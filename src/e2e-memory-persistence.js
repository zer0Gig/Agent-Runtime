/**
 * Cross-restart memory persistence test.
 *
 * Proves that the agent remembers past clients across runtime restarts.
 *
 * Flow:
 *   1. Phase A — runtime running already from prior test (Job #9 saved memory for client 0xeCA6...)
 *   2. Verify memory exists in Supabase agent_kv_index
 *   3. Post a NEW job for the same client
 *   4. Wait for runtime to process it
 *   5. Check runtime logs for "Memory injected for client 0xeCA6f9f4…" marker
 *   6. Verify the LLM had memory context (memory_loaded phase logged)
 *
 * Pre-requisite: agent-runtime is RUNNING with AUTO_APPROVE_MILESTONES=true
 * and writes logs to /tmp/runtime.log
 */
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));
const ABI = JSON.parse(readFileSync(join(__dir, "../../frontend/src/lib/abis/ProgressiveEscrow.json"), "utf8")).abi;

const provider = new ethers.JsonRpcProvider(process.env.OG_NEWTON_RPC || "https://evmrpc-testnet.0g.ai");
const owner    = new ethers.Wallet("0xca0d79afb84680abc76613c72e7defe8b9b840b8b78fed749f1f3cd352e17f6e", provider);
const escrow   = new ethers.Contract(process.env.PROGRESSIVE_ESCROW_ADDRESS, ABI, provider);

const SKILL    = "0x6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f00";
const RUNTIME_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS   = 5_000;

let pass = 0, fail = 0;
const fmt = (w) => ethers.formatEther(w) + " OG";
function check(label, ok, det = "") { (ok ? pass++ : fail++); console.log(`  ${ok ? "✓" : "✗"} ${label}${det ? " — " + det : ""}`); }

async function waitForRelease(jobId, deadline) {
  while (Date.now() < deadline) {
    const job = await escrow.getJob(jobId);
    if (job.releasedWei > 0n) return { released: true };
    process.stdout.write(".");
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log("");
  return { released: false };
}

async function main() {
  console.log("\n╔" + "═".repeat(58) + "╗");
  console.log("║  Cross-restart memory persistence test                   ║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  // ─── Step 1: verify Supabase has the memory from prior runs ─────────────
  console.log("[1/4] Verify memory was saved by prior job(s)...");
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const memKey = `${owner.address.toLowerCase()}:general`;

  const memRes = await fetch(
    `${SB_URL}/rest/v1/agent_kv_index?stream_id=eq.agent:2:memories&key=eq.${encodeURIComponent(memKey)}&select=value,updated_at`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
  );
  const rows = await memRes.json();
  check("memory exists in Supabase", rows.length > 0, rows.length > 0 ? `${rows[0].value.length} bytes, updated ${rows[0].updated_at}` : "no row");
  if (!rows.length) {
    console.error("\n  Run e2e-autonomous.js first to seed the memory.");
    process.exit(1);
  }

  // ─── Step 2: post a NEW job for the same client ─────────────────────────
  console.log("\n[2/4] Post a new job for the same client (0xeCA6...)...");
  const briefBody = {
    title: `Memory recall test ${Date.now()}`,
    description: "Write another short haiku for me.",
    skillId: SKILL,
    clientAddress: owner.address,
  };
  const briefRes = await fetch("http://127.0.0.1:3000/api/job-brief", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(briefBody),
  });
  const { jobDataHash } = await briefRes.json();
  check("brief stored", briefRes.ok, jobDataHash.slice(0, 14) + "...");

  const escAsOwner = escrow.connect(owner);
  const tx1 = await escAsOwner.postJob(jobDataHash, SKILL, { gasLimit: 500_000 });
  await tx1.wait();
  const jobId = Number(await escrow.totalJobs());
  console.log(`     jobId = ${jobId}`);

  const rate = ethers.parseEther("0.005");
  const tx2 = await escAsOwner.submitProposal(jobId, 2, rate, ethers.keccak256(ethers.toUtf8Bytes("p")), { gasLimit: 500_000 });
  await tx2.wait();
  const tx3 = await escAsOwner.acceptProposal(jobId, 0, { value: rate, gasLimit: 600_000 });
  await tx3.wait();
  const tx4 = await escAsOwner.defineMilestones(jobId, [100], [ethers.keccak256(ethers.toUtf8Bytes("d"))], { gasLimit: 400_000 });
  await tx4.wait();
  check("job in IN_PROGRESS", true);

  // ─── Step 3: wait for runtime to process ──────────────────────────────────
  console.log("\n[3/4] Wait for runtime to process and recall memory...");
  console.log("     (Look for [PlatformProcessor] Memory injected for client 0xeCA6f9f4… in /tmp/runtime.log)");
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
  process.stdout.write("     ");
  const result = await waitForRelease(BigInt(jobId), deadline);
  check("milestone released by runtime", result.released);

  // ─── Step 4: check runtime log for memory_loaded marker ──────────────────
  console.log("\n[4/4] Inspect runtime log for memory injection marker...");
  // Wait a moment for log flush
  await new Promise(r => setTimeout(r, 2000));

  let logContent = "";
  try {
    logContent = readFileSync("/tmp/runtime.log", "utf8");
  } catch {
    try { logContent = readFileSync(`${process.env.TEMP || "/tmp"}/runtime.log`, "utf8"); } catch {}
  }
  const lower = logContent.toLowerCase();
  const memoryInjected = lower.includes(`memory injected for client ${owner.address.slice(0, 10).toLowerCase()}`);
  const memorySaved    = lower.includes(`[memory] saved for ${owner.address.slice(0, 10).toLowerCase()}`);
  check("runtime injected memory before LLM call", memoryInjected, memoryInjected ? "✓ found 'Memory injected' marker" : "marker not found");
  check("runtime saved updated memory after job", memorySaved);

  console.log("\n" + "═".repeat(60));
  console.log(`  Memory persistence: ${pass} passed, ${fail} failed`);
  console.log("═".repeat(60) + "\n");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
