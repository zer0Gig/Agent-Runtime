/**
 * Autonomous E2E test — verifies the agent-runtime picks up jobs and releases
 * milestones autonomously when AUTO_APPROVE_MILESTONES=true.
 *
 * Flow:
 *   1. POST brief to frontend /api/job-brief
 *   2. postJob on-chain
 *   3. submitProposal as agent owner
 *   4. acceptProposal as client (deposits OG)
 *   5. defineMilestones as client (triggers IN_PROGRESS state)
 *   6. WAIT for runtime to autonomously release the milestone
 *      (NOT a manual releaseMilestone — that's the test point)
 *   7. Verify on-chain: job.releasedWei == job.totalBudgetWei
 *
 * Pre-requisite: agent-runtime running with AUTO_APPROVE_MILESTONES=true.
 * Watch /tmp/runtime.log for the dispatcher picking up the MilestoneDefined event.
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
const agentW   = new ethers.Wallet("0x" + process.env.AGENT_PRIVATE_KEY, provider);
const escrow   = new ethers.Contract(process.env.PROGRESSIVE_ESCROW_ADDRESS, ABI, provider);

const SKILL    = "0x6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f00";
const RUNTIME_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max wait for runtime to process
const POLL_INTERVAL_MS   = 5_000;

let pass = 0, fail = 0;
const fmt = (w) => ethers.formatEther(w) + " OG";
function check(label, ok, det = "") { (ok ? pass++ : fail++); console.log(`  ${ok ? "✓" : "✗"} ${label}${det ? " — " + det : ""}`); }

async function waitForMilestoneRelease(jobId, deadline) {
  console.log(`     [Wait] Polling job ${jobId} every ${POLL_INTERVAL_MS / 1000}s for autonomous release...`);
  while (Date.now() < deadline) {
    const job = await escrow.getJob(jobId);
    if (job.releasedWei > 0n) {
      return { released: true, releasedWei: job.releasedWei, status: Number(job.status) };
    }
    process.stdout.write(".");
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log("");
  return { released: false };
}

async function main() {
  console.log("\n╔" + "═".repeat(58) + "╗");
  console.log("║  Autonomous E2E (runtime self-releases milestone)        ║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  // ─── Step 1: Post brief ─────────────────────────────────────────────────
  console.log("[1/5] POST /api/job-brief...");
  const briefBody = {
    title: `Autonomous test ${Date.now()}`,
    description: "Write a one-line haiku about decentralized agents.",
    skillId: SKILL,
    clientAddress: owner.address,
  };
  const briefRes = await fetch("http://127.0.0.1:3000/api/job-brief", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(briefBody),
  });
  check("brief stored", briefRes.ok, `${briefRes.status}`);
  const { jobDataHash } = await briefRes.json();
  console.log(`     jobDataHash = ${jobDataHash}`);

  // ─── Step 2: postJob on-chain ───────────────────────────────────────────
  console.log("\n[2/5] postJob on-chain...");
  const escAsOwner = escrow.connect(owner);
  const tx1 = await escAsOwner.postJob(jobDataHash, SKILL, { gasLimit: 500_000 });
  const r1 = await tx1.wait();
  check("postJob", r1.status === 1, tx1.hash);
  const jobId = Number(await escrow.totalJobs());
  console.log(`     jobId = ${jobId}`);

  // ─── Step 3-5: build to milestones-defined state ────────────────────────
  console.log("\n[3/5] submitProposal (as agent owner via agentW=owner here for test)...");
  // For agent #2, owner == eCA6... which is also our test "owner" wallet.
  // submitProposal must be called by agent.owner. In our setup owner wallet IS the agent owner.
  const rate = ethers.parseEther("0.005");
  const tx2 = await escAsOwner.submitProposal(
    jobId,
    2, // agent #2
    rate,
    ethers.keccak256(ethers.toUtf8Bytes("autonomous-proposal")),
    { gasLimit: 500_000 }
  );
  await tx2.wait();
  check("submitProposal", true, tx2.hash);

  console.log("\n[4/5] acceptProposal (client deposits)...");
  const tx3 = await escAsOwner.acceptProposal(jobId, 0, { value: rate, gasLimit: 600_000 });
  await tx3.wait();
  check("acceptProposal", true, tx3.hash);

  console.log("\n[5/5] defineMilestones (single 100% milestone)...");
  const tx4 = await escAsOwner.defineMilestones(
    jobId,
    [100],
    [ethers.keccak256(ethers.toUtf8Bytes("deliver"))],
    { gasLimit: 400_000 }
  );
  await tx4.wait();
  check("defineMilestones — IN_PROGRESS", true, tx4.hash);

  // ─── Wait for runtime ────────────────────────────────────────────────────
  console.log("\n[Wait] Runtime should now detect MilestoneDefined event and process autonomously...");
  console.log("       (LLM call → 0G Storage → AUTO_APPROVE bypass → releaseMilestone)");

  const deadline = Date.now() + RUNTIME_TIMEOUT_MS;
  const result = await waitForMilestoneRelease(BigInt(jobId), deadline);

  // ─── Verify ──────────────────────────────────────────────────────────────
  console.log("\n[Verify] Final state...");
  if (!result.released) {
    check("autonomous release within timeout", false, "runtime never released");
    const job = await escrow.getJob(jobId);
    console.log(`     Job status: ${job.status} (0=OPEN, 2=IN_PROGRESS, 3=COMPLETED)`);
    console.log(`     Released:   ${fmt(job.releasedWei)} / ${fmt(job.totalBudgetWei)}`);
  } else {
    check("autonomous release happened", true, `runtime released ${fmt(result.releasedWei)}`);
    const job = await escrow.getJob(jobId);
    check("releasedWei == totalBudgetWei", job.releasedWei === rate, fmt(job.releasedWei));
    check("job status == COMPLETED (3)", Number(job.status) === 3, `status=${job.status}`);
    const milestones = await escrow.getMilestones(jobId);
    check("milestone status == APPROVED (2)", Number(milestones[0].status) === 2, `status=${milestones[0].status}`);
    check("alignment score >= 8000", Number(milestones[0].alignmentScore) >= 8000, `${milestones[0].alignmentScore}/10000`);
  }

  console.log("\n" + "═".repeat(60));
  console.log(`  Autonomous E2E: ${pass} passed, ${fail} failed`);
  console.log("═".repeat(60) + "\n");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
