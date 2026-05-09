/**
 * Unit tests for runFeedbackLoop — specifically the AUTO_APPROVE_MILESTONES bypass.
 *
 * Run with: npm test
 */
import { strict as assert } from "node:assert";
import { describe, it, beforeEach, afterEach } from "mocha";
import { runFeedbackLoop } from "../src/services/platformJobProcessor.js";

describe("runFeedbackLoop — AUTO_APPROVE_MILESTONES bypass", () => {
  let originalFetch;
  let originalEnv;
  let postedMessages;

  beforeEach(() => {
    originalEnv = process.env.AUTO_APPROVE_MILESTONES;
    originalFetch = globalThis.fetch;
    postedMessages = [];

    // Mock fetch — capture chat posts, return ok response
    globalThis.fetch = async (url, opts) => {
      if (typeof url === "string" && url.includes("/api/job-chat") && opts?.method === "POST") {
        postedMessages.push(JSON.parse(opts.body));
      }
      return { ok: true, json: async () => ({}) };
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.AUTO_APPROVE_MILESTONES;
    } else {
      process.env.AUTO_APPROVE_MILESTONES = originalEnv;
    }
  });

  it("returns immediately when AUTO_APPROVE_MILESTONES=true", async () => {
    process.env.AUTO_APPROVE_MILESTONES = "true";

    const start = Date.now();
    const result = await runFeedbackLoop(
      "1",                          // jobId
      0,                            // milestoneIndex
      "Output summary text",        // outputSummary
      null,                         // extendedCompute (not used in bypass)
      null,                         // telegramChatId
      60_000                        // timeoutMs
    );
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 1000, `Should return in <1s, took ${elapsed}ms`);
    assert.strictEqual(result.userFeedback, "[auto-approved for demo]");
    assert.strictEqual(result.path, "demo");
  });

  it("posts the output summary to chat in auto-approve mode", async () => {
    process.env.AUTO_APPROVE_MILESTONES = "true";

    await runFeedbackLoop("42", 1, "Detailed milestone output here.", null, null, 60_000);

    assert.strictEqual(postedMessages.length, 1, "Exactly one chat post expected");
    const msg = postedMessages[0];
    assert.strictEqual(msg.jobId, "42");
    assert.strictEqual(msg.sender, "agent");
    assert.match(msg.message, /Milestone 2 complete/);
    assert.match(msg.message, /Auto-approved/);
    assert.match(msg.message, /Detailed milestone output here\./);
  });

  it("does NOT skip when AUTO_APPROVE_MILESTONES is not 'true'", async () => {
    process.env.AUTO_APPROVE_MILESTONES = "false";

    // With timeoutMs=200ms, the function will throw before any LLM call
    // because the deadline passes during the polling loop.
    let threw = false;
    try {
      await runFeedbackLoop("1", 0, "Output", null, null, 200);
    } catch (err) {
      threw = true;
      assert.match(err.message, /timed out/);
    }
    assert.ok(threw, "Should throw on timeout when not auto-approving");
  });

  it("does NOT skip when AUTO_APPROVE_MILESTONES is unset", async () => {
    delete process.env.AUTO_APPROVE_MILESTONES;

    let threw = false;
    try {
      await runFeedbackLoop("1", 0, "Output", null, null, 200);
    } catch (err) {
      threw = true;
    }
    assert.ok(threw, "Should NOT bypass when env var is missing");
  });

  it("treats string 'true' (case-sensitive) — 'TRUE' does NOT bypass", async () => {
    process.env.AUTO_APPROVE_MILESTONES = "TRUE";

    // Should fall through to the normal loop (timeout)
    let threw = false;
    try {
      await runFeedbackLoop("1", 0, "Output", null, null, 200);
    } catch (err) {
      threw = true;
    }
    assert.ok(threw, "Strict 'true' check — uppercase should not match");
  });
});
