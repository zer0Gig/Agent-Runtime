/**
 * Unit tests for the 0G KV Node circuit breaker + retry behavior.
 *
 * Stubs out the actual KV transport so we can drive failure cycles
 * deterministically and verify state transitions and exponential cooldown.
 */
import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "mocha";

// Build a minimal storage shim that mimics the breaker subset of StorageService.
// We re-implement the breaker logic surface directly to avoid pulling in 0G SDK
// init paths that need testnet RPC. The methods under test are pure state machines.
class BreakerHarness {
  constructor() {
    this._kvNodeState           = "closed";
    this._kvNodeFailures        = 0;
    this._kvNodeDisabledUntil   = 0;
    this._kvNodeCooldownMs      = 5 * 60 * 1000;
    this._kvNodeOpenCount       = 0;
    this._kvNodeLastError       = null;
    this._kvNodeLastSuccessAt   = 0;
    this._KV_NODE_FAILURE_THRESHOLD = 2;
    this._KV_NODE_BASE_COOLDOWN_MS  = 5 * 60 * 1000;
    this._KV_NODE_MAX_COOLDOWN_MS   = 30 * 60 * 1000;
    this._KV_NODE_RETRY_DELAYS_MS   = [10, 20];
  }

  // Methods copied verbatim from StorageService — keep in sync if either side changes
  _kvNodeCircuitOpen() {
    if (this._kvNodeState === "closed") return false;
    if (this._kvNodeState === "open") {
      if (Date.now() >= this._kvNodeDisabledUntil) {
        this._kvNodeState = "half-open";
        return false;
      }
      return true;
    }
    return false;
  }

  _kvNodeRecordFailure(reason) {
    this._kvNodeLastError = reason;
    this._kvNodeFailures += 1;
    const shouldOpen =
      this._kvNodeState === "half-open" ||
      (this._kvNodeState === "closed" && this._kvNodeFailures >= this._KV_NODE_FAILURE_THRESHOLD);
    if (shouldOpen) {
      this._kvNodeState = "open";
      this._kvNodeOpenCount += 1;
      this._kvNodeCooldownMs = Math.min(
        this._KV_NODE_BASE_COOLDOWN_MS * Math.pow(2, this._kvNodeOpenCount - 1),
        this._KV_NODE_MAX_COOLDOWN_MS
      );
      this._kvNodeDisabledUntil = Date.now() + this._kvNodeCooldownMs;
    }
  }

  _kvNodeRecordSuccess() {
    this._kvNodeState         = "closed";
    this._kvNodeFailures      = 0;
    this._kvNodeDisabledUntil = 0;
    this._kvNodeOpenCount     = 0;
    this._kvNodeCooldownMs    = this._KV_NODE_BASE_COOLDOWN_MS;
    this._kvNodeLastError     = null;
    this._kvNodeLastSuccessAt = Date.now();
  }

  getKvHealth() {
    const now = Date.now();
    return {
      state:           this._kvNodeState,
      failures:        this._kvNodeFailures,
      openCount:       this._kvNodeOpenCount,
      cooldownMs:      this._kvNodeCooldownMs,
      reopensInMs:     this._kvNodeState === "open" ? Math.max(0, this._kvNodeDisabledUntil - now) : 0,
      lastError:       this._kvNodeLastError,
      lastSuccessAgoMs: this._kvNodeLastSuccessAt ? now - this._kvNodeLastSuccessAt : null,
    };
  }

  async _withRetry(fn, label) {
    const attempts = this._KV_NODE_RETRY_DELAYS_MS.length + 1;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        if (i < this._KV_NODE_RETRY_DELAYS_MS.length) {
          await new Promise(r => setTimeout(r, this._KV_NODE_RETRY_DELAYS_MS[i]));
        }
      }
    }
    throw lastErr;
  }
}

describe("KV Node circuit breaker", () => {
  let h;

  beforeEach(() => { h = new BreakerHarness(); });

  it("starts closed", () => {
    assert.equal(h.getKvHealth().state, "closed");
    assert.equal(h._kvNodeCircuitOpen(), false);
  });

  it("stays closed after a single failure (below threshold)", () => {
    h._kvNodeRecordFailure("blip");
    assert.equal(h.getKvHealth().state, "closed");
    assert.equal(h._kvNodeCircuitOpen(), false);
  });

  it("opens after threshold failures with base cooldown", () => {
    h._kvNodeRecordFailure("err1");
    h._kvNodeRecordFailure("err2");
    const s = h.getKvHealth();
    assert.equal(s.state, "open");
    assert.equal(s.openCount, 1);
    assert.equal(s.cooldownMs, 5 * 60 * 1000);
    assert.ok(s.reopensInMs > 0);
    assert.equal(h._kvNodeCircuitOpen(), true);
  });

  it("transitions open → half-open after cooldown expires", () => {
    h._kvNodeRecordFailure("a");
    h._kvNodeRecordFailure("b");
    // Force cooldown to have already expired
    h._kvNodeDisabledUntil = Date.now() - 1000;
    assert.equal(h._kvNodeCircuitOpen(), false);  // probe allowed
    assert.equal(h.getKvHealth().state, "half-open");
  });

  it("a successful probe in half-open closes the circuit", () => {
    h._kvNodeRecordFailure("a");
    h._kvNodeRecordFailure("b");
    h._kvNodeDisabledUntil = Date.now() - 1;
    h._kvNodeCircuitOpen(); // promote to half-open
    h._kvNodeRecordSuccess();
    const s = h.getKvHealth();
    assert.equal(s.state, "closed");
    assert.equal(s.failures, 0);
    assert.equal(s.openCount, 0);
  });

  it("a failing probe in half-open jumps straight back to open with longer cooldown", () => {
    h._kvNodeRecordFailure("a");
    h._kvNodeRecordFailure("b");
    h._kvNodeDisabledUntil = Date.now() - 1;
    h._kvNodeCircuitOpen(); // half-open
    h._kvNodeRecordFailure("probe-failed");
    const s = h.getKvHealth();
    assert.equal(s.state, "open");
    assert.equal(s.openCount, 2);
    assert.equal(s.cooldownMs, 10 * 60 * 1000); // doubled
  });

  it("cooldown caps at the configured max after enough cycles", () => {
    // Drive 4+ open→half-open→open cycles. Cooldown doubles each cycle:
    //   1: 5m, 2: 10m, 3: 20m, 4: 40m → capped at 30m.
    for (let cycle = 0; cycle < 5; cycle++) {
      // From closed, two failures opens
      h._kvNodeRecordFailure("a");
      h._kvNodeRecordFailure("b");
      // Force cooldown to have expired so we can probe again
      h._kvNodeDisabledUntil = Date.now() - 1;
      h._kvNodeCircuitOpen();           // promotes to half-open
      h._kvNodeRecordFailure("probe");  // probe fails → opens again with next cooldown
    }
    assert.equal(h._kvNodeCooldownMs, h._KV_NODE_MAX_COOLDOWN_MS);
  });

  it("_withRetry succeeds after a transient failure", async () => {
    let calls = 0;
    const result = await h._withRetry(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return "ok";
    }, "test");
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  it("_withRetry exhausts attempts then throws", async () => {
    let calls = 0;
    let thrown = null;
    try {
      await h._withRetry(async () => { calls += 1; throw new Error("perma"); }, "test");
    } catch (err) { thrown = err; }
    assert.ok(thrown);
    assert.equal(thrown.message, "perma");
    assert.equal(calls, 3); // 1 initial + 2 retries
  });

  it("getKvHealth reports the fields the /health endpoint expects", () => {
    h._kvNodeRecordFailure("a");
    h._kvNodeRecordFailure("b");
    const s = h.getKvHealth();
    assert.equal(typeof s.state, "string");
    assert.equal(typeof s.failures, "number");
    assert.equal(typeof s.openCount, "number");
    assert.equal(typeof s.cooldownMs, "number");
    assert.equal(typeof s.reopensInMs, "number");
    assert.equal(s.lastError, "b");
  });
});
