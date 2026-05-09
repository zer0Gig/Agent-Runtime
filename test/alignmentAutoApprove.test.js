/**
 * Unit tests for the Alignment Node auto-approve path in runFeedbackLoop.
 *
 * Verifies that when the self-eval score >= ALIGNMENT_AUTO_APPROVE_THRESHOLD
 * AND alignmentSigned=true, the loop releases after the grace window without
 * waiting for human approval. Also verifies the user override during grace.
 */
import { strict as assert } from "node:assert";
import { describe, it, beforeEach, afterEach } from "mocha";
import { runFeedbackLoop } from "../src/services/platformJobProcessor.js";

describe("runFeedbackLoop — Alignment Node auto-release", () => {
  let originalFetch;
  let originalAuto, originalThreshold, originalGrace;
  let postedMessages;
  let chatHistoryProvider;

  beforeEach(() => {
    originalAuto      = process.env.AUTO_APPROVE_MILESTONES;
    originalThreshold = process.env.ALIGNMENT_AUTO_APPROVE_THRESHOLD;
    originalGrace     = process.env.ALIGNMENT_GRACE_PERIOD_MS;
    originalFetch     = globalThis.fetch;
    postedMessages    = [];
    chatHistoryProvider = () => []; // default: no user messages

    delete process.env.AUTO_APPROVE_MILESTONES;
    process.env.ALIGNMENT_AUTO_APPROVE_THRESHOLD = "7500";
    process.env.ALIGNMENT_GRACE_PERIOD_MS        = "200"; // tiny grace for tests

    globalThis.fetch = async (url, opts) => {
      if (typeof url === "string" && url.includes("/api/job-chat") && opts?.method === "POST") {
        postedMessages.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({}) };
      }
      if (typeof url === "string" && url.includes("/api/job-chat?jobId=")) {
        return { ok: true, json: async () => chatHistoryProvider() };
      }
      if (typeof url === "string" && url.includes("/api/milestone-approval")) {
        return { ok: true, json: async () => ({ approved: false }) };
      }
      return { ok: true, json: async () => ({}) };
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAuto      === undefined) delete process.env.AUTO_APPROVE_MILESTONES;     else process.env.AUTO_APPROVE_MILESTONES = originalAuto;
    if (originalThreshold === undefined) delete process.env.ALIGNMENT_AUTO_APPROVE_THRESHOLD; else process.env.ALIGNMENT_AUTO_APPROVE_THRESHOLD = originalThreshold;
    if (originalGrace     === undefined) delete process.env.ALIGNMENT_GRACE_PERIOD_MS;   else process.env.ALIGNMENT_GRACE_PERIOD_MS = originalGrace;
  });

  it("releases via alignment path when score >= threshold and signed", async () => {
    const result = await runFeedbackLoop(
      "1", 0, "Output summary", null, null, 60_000,
      8500,   // alignmentScore: above 7500 threshold
      true    // alignmentSigned
    );

    assert.strictEqual(result.path, "alignment");
    assert.strictEqual(result.alignmentScore, 8500);
    assert.match(result.userFeedback, /alignment-attested/);
  });

  it("posts an attestation card during the grace window", async () => {
    await runFeedbackLoop("42", 1, "milestone deliverable", null, null, 60_000, 9000, true);

    assert.ok(postedMessages.length >= 1, "Expected at least one chat post");
    const card = postedMessages.find(m => m.msgType === "milestone_alignment_attested");
    assert.ok(card, "Expected milestone_alignment_attested card");
    assert.strictEqual(card.metadata.alignmentScore, 9000);
  });

  it("does NOT use alignment path when score is below threshold", async () => {
    let threw = false;
    try {
      await runFeedbackLoop("1", 0, "Output", null, null, 200, 7400, true);
    } catch (err) {
      threw = true;
      assert.match(err.message, /timed out/);
    }
    assert.ok(threw, "Should fall through to human-loop and timeout");
  });

  it("does NOT use alignment path when not signed", async () => {
    let threw = false;
    try {
      await runFeedbackLoop("1", 0, "Output", null, null, 200, 9999, false);
    } catch (err) {
      threw = true;
    }
    assert.ok(threw, "Unsigned alignment must fall through to human-loop");
  });

  it("AUTO_APPROVE_MILESTONES still wins over alignment path", async () => {
    process.env.AUTO_APPROVE_MILESTONES = "true";
    const result = await runFeedbackLoop("1", 0, "Output", null, null, 60_000, 9000, true);
    assert.strictEqual(result.path, "demo");
  });

  it("user override during grace window aborts auto-release", async function() {
    this.timeout(8000);
    process.env.ALIGNMENT_GRACE_PERIOD_MS = "1500";

    let returned = false;
    chatHistoryProvider = () => {
      if (returned) return [];
      returned = true;
      return [{ sender: "user", message: "wait, I want to review", created_at: new Date().toISOString() }];
    };

    // Stub the LLM that the human-loop would call to classify intent
    const fakeCompute = { processTask: async () => ({ content: "UNKNOWN" }) };

    let threw = false;
    try {
      // tight overall timeout — once we override into the human loop, it should time out fast
      await runFeedbackLoop("1", 0, "Output", fakeCompute, null, 200, 9000, true);
    } catch (err) {
      threw = true;
    }
    assert.ok(threw, "Should fall through to human-loop after override and time out");
  });
});
