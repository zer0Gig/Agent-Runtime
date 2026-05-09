/**
 * test-chat-live.js — exercises the EXACT code path the Telegram CS bot uses
 * to reply to a customer message. No Telegraf, no real Telegram needed.
 *
 * Pipeline tested (same as CustomerServiceBot._generateReply):
 *   ExtendedComputeService.processTask(prompt, systemPrompt, toolContext)
 *
 * What this proves:
 *   ✓ LLM provider credentials work
 *   ✓ Provider routing (0g-compute / groq / openai / fallback) works
 *   ✓ Response shape is parseable
 *
 * Usage: node src/test-chat-live.js
 */
import "dotenv/config";
import { ethers } from "ethers";
import { ExtendedComputeService } from "./services/extendedComputeService.js";

const TEST_PROMPTS = [
  { user: "Hi! Who are you?", system: "You are zer0Gig customer service. Reply briefly." },
  { user: "What's 2+2?",      system: "Answer math questions. Be concise." },
];

async function main() {
  console.log("\n  Live Chat Path Test (CustomerServiceBot._generateReply equivalent)");
  console.log("  " + "─".repeat(70));

  // Sanity-check env
  const provider = process.env.FALLBACK_LLM_PROVIDER || "0g-compute";
  console.log(`  Provider:        ${provider}`);
  console.log(`  GROQ_API_KEY:    ${process.env.GROQ_API_KEY ? "set ✓" : "MISSING ✗"}`);
  console.log(`  OPENAI_API_KEY:  ${process.env.OPENAI_API_KEY ? "set" : "—"}`);
  console.log(`  ANTHROPIC_API:   ${process.env.ANTHROPIC_API_KEY ? "set" : "—"}`);
  console.log(`  AGENT_PRIVATE:   ${process.env.AGENT_PRIVATE_KEY ? "set ✓" : "MISSING ✗"}`);
  console.log("  " + "─".repeat(70));

  if (!process.env.AGENT_PRIVATE_KEY) {
    console.error("\n  ✗ AGENT_PRIVATE_KEY not set — cannot init ExtendedComputeService\n");
    process.exit(1);
  }

  const wallet = new ethers.Wallet(
    process.env.AGENT_PRIVATE_KEY,
    new ethers.JsonRpcProvider(process.env.OG_NEWTON_RPC || "https://evmrpc-testnet.0g.ai"),
  );

  const compute = new ExtendedComputeService(wallet, {
    provider,
    systemPrompt: "You are zer0Gig customer service.",
  });

  let pass = 0;
  let fail = 0;

  for (const t of TEST_PROMPTS) {
    console.log(`\n  → user: "${t.user}"`);
    try {
      const start = Date.now();
      const res = await compute.processTask(t.user, t.system);
      const elapsed = Date.now() - start;

      const content = (res?.content ?? "").trim();
      if (!content) {
        console.log(`  ✗ empty response (${elapsed}ms)`);
        fail++;
      } else {
        console.log(`  ✓ replied in ${elapsed}ms`);
        console.log(`    ${content.slice(0, 200)}${content.length > 200 ? "…" : ""}`);
        pass++;
      }
    } catch (err) {
      console.log(`  ✗ ${err?.message?.slice(0, 200) || err}`);
      // Hint at the most common failure modes
      if (/api key|unauthor|invalid.*token|401|403/i.test(err?.message || "")) {
        console.log(`    HINT: provider says credentials are invalid — check the relevant API_KEY in .env`);
      }
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(err?.message || "")) {
        console.log(`    HINT: network/DNS — provider endpoint unreachable from this host`);
      }
      fail++;
    }
  }

  console.log("\n  " + "─".repeat(70));
  console.log(`  Result: ${pass} passed · ${fail} failed`);
  console.log("  " + "─".repeat(70) + "\n");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
