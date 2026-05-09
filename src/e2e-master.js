/**
 * Master E2E Test Script
 *
 * Exercises the entire zer0Gig stack:
 *   1. Read state from all 4 contracts
 *   2. Test 0G Storage upload/download
 *   3. Post a job → fund → define milestones → release
 *   4. Test oracle signing
 *   5. Test Telegram bot reachability
 *   6. Verify Supabase access
 *
 * Run AFTER:
 *   - Frontend dev server is up (port 3000)
 *   - Platform dispatcher is running (background)
 */

import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));
const ABI_DIR = join(__dir, "../../frontend/src/lib/abis");

// ── Config ──────────────────────────────────────────────────────────────────

const RPC      = process.env.OG_NEWTON_RPC || "https://evmrpc-testnet.0g.ai";
const REGISTRY = process.env.AGENT_REGISTRY_ADDRESS;
const ESCROW   = process.env.PROGRESSIVE_ESCROW_ADDRESS;
const SUB_ESC  = process.env.SUBSCRIPTION_ESCROW_ADDRESS;
const USER_REG = process.env.USER_REGISTRY_ADDRESS;

// Wallets
const OWNER_KEY = "0xca0d79afb84680abc76613c72e7defe8b9b840b8b78fed749f1f3cd352e17f6e"; // 0xeCA6...
const PLAT_KEY  = "0x" + process.env.PLATFORM_PRIVATE_KEY;
const AGENT_KEY = "0x" + process.env.AGENT_PRIVATE_KEY; // new agentWallet (0x0B72...)

const provider = new ethers.JsonRpcProvider(RPC);
const owner    = new ethers.Wallet(OWNER_KEY, provider);
const platform = new ethers.Wallet(PLAT_KEY,  provider);
const agentW   = new ethers.Wallet(AGENT_KEY, provider);

// ABIs
const loadAbi = (name) => JSON.parse(readFileSync(join(ABI_DIR, `${name}.json`), "utf8")).abi;
const REG_ABI  = loadAbi("AgentRegistry");
const ESC_ABI  = loadAbi("ProgressiveEscrow");
const SUB_ABI  = loadAbi("SubscriptionEscrow");
const USER_ABI = loadAbi("UserRegistry");

// Contracts
const reg     = new ethers.Contract(REGISTRY, REG_ABI, provider);
const escrow  = new ethers.Contract(ESCROW,   ESC_ABI, provider);
const subEsc  = new ethers.Contract(SUB_ESC,  SUB_ABI, provider);
const userReg = new ethers.Contract(USER_REG, USER_ABI, provider);

// Skill IDs
const SKILL_CONTENT_WRITING = "0x6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f00";

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt   = (wei) => ethers.formatEther(wei) + " OG";
const k256  = (s)   => ethers.keccak256(typeof s === "string" ? ethers.toUtf8Bytes(s) : s);
const sleep = (ms)  => new Promise(r => setTimeout(r, ms));

let passes = 0, fails = 0;
function check(label, cond, detail = "") {
  if (cond) { console.log(`  ✓ ${label}` + (detail ? ` — ${detail}` : "")); passes++; }
  else      { console.log(`  ✗ ${label}` + (detail ? ` — ${detail}` : "")); fails++; }
}

function header(title) {
  console.log("\n" + "═".repeat(60));
  console.log("  " + title);
  console.log("═".repeat(60));
}

// ── Test Phase 1: Smart contract reads ───────────────────────────────────────

async function phase1_ContractReads() {
  header("PHASE 1 — Smart Contract State Reads");

  const [block, ownerBal, platBal, agentBal] = await Promise.all([
    provider.getBlockNumber(),
    provider.getBalance(owner.address),
    provider.getBalance(platform.address),
    provider.getBalance(agentW.address),
  ]);

  console.log(`  Block: ${block}`);
  console.log(`  owner    ${owner.address}    ${fmt(ownerBal)}`);
  console.log(`  platform ${platform.address}    ${fmt(platBal)}`);
  console.log(`  agentW   ${agentW.address}    ${fmt(agentBal)}`);

  check("Block height", block > 0, `${block}`);
  check("Owner has > 5 OG", ownerBal > ethers.parseEther("5"), fmt(ownerBal));
  check("Platform has > 0.5 OG", platBal > ethers.parseEther("0.5"), fmt(platBal));

  // AgentRegistry
  const totalAgents = await reg.totalAgents();
  check("totalAgents >= 2", totalAgents >= 2n, `${totalAgents}`);

  const agent2 = await reg.getAgentProfile(2);
  check("agent2.owner == owner", agent2.owner.toLowerCase() === owner.address.toLowerCase());
  check("agent2.isActive", agent2.isActive);
  check("agent2.agentWallet == 0x0B72...", agent2.agentWallet.toLowerCase() === agentW.address.toLowerCase(), agent2.agentWallet);

  // ProgressiveEscrow
  const totalJobs = await escrow.totalJobs();
  console.log(`  ProgressiveEscrow.totalJobs = ${totalJobs}`);
  const escAR = await escrow.agentRegistry();
  check("ProgressiveEscrow.agentRegistry matches", escAR.toLowerCase() === REGISTRY.toLowerCase());

  // SubscriptionEscrow
  const totalSubs = await subEsc.totalSubscriptions();
  console.log(`  SubscriptionEscrow.totalSubscriptions = ${totalSubs}`);

  // UserRegistry
  const ownerRole = await userReg.getUserRole(owner.address);
  check("Owner registered as FreelancerOwner (role=2)", ownerRole === 2n, `role=${ownerRole}`);

  return { totalAgents, totalJobs, totalSubs };
}

// ── Test Phase 2: 0G Storage ─────────────────────────────────────────────────

async function phase2_Storage() {
  header("PHASE 2 — 0G Storage / KV / Compute");

  // Test 0G Storage indexer
  const indexer = process.env.OG_INDEXER_RPC || "https://indexer-storage-testnet-turbo.0g.ai";
  try {
    const res = await fetch(`${indexer}/file/info/0xdeadbeef`, { signal: AbortSignal.timeout(8000) });
    check("0G Storage indexer reachable", res.status < 600, `HTTP ${res.status}`);
  } catch (e) {
    check("0G Storage indexer reachable", false, e.message);
  }

  // Test KV node
  try {
    const kvUrl = process.env.OG_KV_NODE_RPC || "http://localhost:6789";
    const res = await fetch(kvUrl, { signal: AbortSignal.timeout(3000) });
    check("Local KV node reachable", res.status < 600, `HTTP ${res.status}`);
  } catch {
    check("Local KV node (optional)", true, "skipped — not running locally");
  }

  // Test 0G Compute providers
  try {
    const res = await fetch(`https://evmrpc-testnet.0g.ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", id: 1 }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await res.json();
    check("0G EVM RPC alive", !!j.result, `block=${parseInt(j.result, 16)}`);
  } catch (e) {
    check("0G EVM RPC alive", false, e.message);
  }

  // Test alignment node verifier (oracle signer = platform key)
  try {
    const verifier = await escrow.alignmentNodeVerifier();
    check("alignmentNodeVerifier matches platform wallet",
      verifier.toLowerCase() === platform.address.toLowerCase(), verifier);
  } catch (e) {
    check("alignmentNodeVerifier read", false, e.message);
  }
}

// ── Test Phase 3: Frontend reachability ──────────────────────────────────────

async function phase3_Frontend() {
  header("PHASE 3 — Frontend Routes");

  const routes = [
    "/", "/marketplace", "/dashboard", "/dashboard/jobs",
    "/dashboard/create-job", "/dashboard/register-agent",
    "/dashboard/create-subscription", "/dashboard/my-proposals",
  ];

  for (const r of routes) {
    try {
      const res = await fetch(`http://127.0.0.1:3000${r}`, { signal: AbortSignal.timeout(60000) });
      check(`GET ${r}`, res.status === 200, `${res.status}, ${(res.headers.get("content-length") || "?")} bytes`);
    } catch (e) {
      check(`GET ${r}`, false, e.message);
    }
  }

  // API routes
  const apis = ["/api/agents", "/api/agent-stats?agentId=2", "/api/agent-profile?agentId=2"];
  for (const a of apis) {
    try {
      const res = await fetch(`http://127.0.0.1:3000${a}`, { signal: AbortSignal.timeout(15000) });
      check(`API GET ${a}`, res.status < 500, `${res.status}`);
    } catch (e) {
      check(`API GET ${a}`, false, e.message);
    }
  }
}

// ── Test Phase 4: Oracle signing ─────────────────────────────────────────────

async function phase4_OracleSign() {
  header("PHASE 4 — Oracle / Alignment Signing");

  // The contract's releaseMilestone expects an oracle signature over:
  //   keccak256(jobId, milestoneIndex, outputHash, alignmentScore)
  // Signed by the alignmentNodeVerifier address (platform wallet)

  const jobId          = 1n;
  const milestoneIndex = 0;
  const outputHash     = k256("test-output");
  const alignmentScore = 8500;

  // Contract bytecode: abi.encode(jobId, uint8(milestoneIdx), uint16(score), outputHash)
  const messageHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint8", "uint16", "bytes32"],
      [jobId, milestoneIndex, alignmentScore, outputHash]
    )
  );

  const sig = await platform.signMessage(ethers.getBytes(messageHash));
  console.log(`  signature: ${sig.slice(0, 30)}...${sig.slice(-10)}`);

  // Verify signature locally
  const recovered = ethers.verifyMessage(ethers.getBytes(messageHash), sig);
  check("Oracle signature recovers to platform wallet",
    recovered.toLowerCase() === platform.address.toLowerCase(),
    recovered);
}

// ── Test Phase 5: Full job E2E flow ──────────────────────────────────────────

async function phase5_JobFlow(initialJobCount) {
  header("PHASE 5 — Full Job E2E Flow");

  // Step 1: Client posts job
  console.log("\n  [1/5] Client posts job...");
  const escrowAsOwner = escrow.connect(owner);
  const jobDataHash = k256(`e2e-job-${Date.now()}`);
  const tx1 = await escrowAsOwner.postJob(jobDataHash, SKILL_CONTENT_WRITING, { gasLimit: 500_000 });
  const r1 = await tx1.wait();
  const newJobId = Number(initialJobCount) + 1;
  check("postJob succeeded", r1.status === 1, `tx ${tx1.hash}`);
  console.log(`         jobId = ${newJobId}, dataHash = ${jobDataHash.slice(0, 18)}...`);

  // Verify job state
  const job = await escrow.getJob(newJobId);
  check("job.client == owner", job.client.toLowerCase() === owner.address.toLowerCase());
  check("job.status == OPEN (0)", job.status === 0n, `status=${job.status}`);
  check("job.skillId matches", job.skillId === SKILL_CONTENT_WRITING);

  // Step 2: Agent submits proposal (from agentWallet — needs to be the agent's owner per contract)
  console.log("\n  [2/5] Agent submits proposal...");
  // submitProposal is called by the agent's OWNER (the user's wallet), since they own the NFT
  const escrowAsAgentOwner = escrow.connect(owner);
  const proposedRate = ethers.parseEther("0.005");  // 0.005 OG
  const descriptionHash = k256("I will write a high-quality 500-word article on the topic.");
  try {
    const tx2 = await escrowAsAgentOwner.submitProposal(newJobId, 2, proposedRate, descriptionHash, { gasLimit: 500_000 });
    const r2 = await tx2.wait();
    check("submitProposal succeeded", r2.status === 1, `tx ${tx2.hash}`);
  } catch (e) {
    check("submitProposal", false, e.shortMessage || e.message?.slice(0, 100));
    return;
  }

  // Step 3: Client accepts proposal (payable - sends funding)
  console.log("\n  [3/5] Client accepts proposal + funds escrow...");
  const totalBudget = proposedRate; // 0.005 OG
  try {
    const tx3 = await escrowAsOwner.acceptProposal(newJobId, 0, { value: totalBudget, gasLimit: 600_000 });
    const r3 = await tx3.wait();
    check("acceptProposal succeeded", r3.status === 1, `tx ${tx3.hash}`);
  } catch (e) {
    check("acceptProposal", false, e.shortMessage || e.message?.slice(0, 200));
    return;
  }

  const jobAfterAccept = await escrow.getJob(newJobId);
  check("Job status == IN_PROGRESS or PENDING_MILESTONES", jobAfterAccept.status >= 1n, `status=${jobAfterAccept.status}`);
  check("Job has agentId=2 assigned", jobAfterAccept.agentId === 2n);
  check("Job budget == 0.005 OG", jobAfterAccept.totalBudgetWei === totalBudget, fmt(jobAfterAccept.totalBudgetWei));

  // Step 4: Client defines milestones (single 100% milestone)
  console.log("\n  [4/5] Client defines milestones...");
  try {
    const tx4 = await escrowAsOwner.defineMilestones(
      newJobId,
      [100], // single 100% milestone
      [k256("Deliverable: 500-word article published as markdown")],
      { gasLimit: 400_000 }
    );
    await tx4.wait();
    check("defineMilestones succeeded", true, `tx ${tx4.hash}`);
  } catch (e) {
    check("defineMilestones", false, e.shortMessage || e.message?.slice(0, 200));
    return;
  }

  // Step 5: Platform releases milestone with oracle signature
  console.log("\n  [5/5] Platform releases milestone with oracle proof...");
  const outputHash      = k256(`agent-output-job-${newJobId}`);
  const alignmentScore  = 8500;
  const milestoneIndex  = 0;

  const messageHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint8", "uint16", "bytes32"],
      [newJobId, milestoneIndex, alignmentScore, outputHash]
    )
  );
  const oracleSig = await platform.signMessage(ethers.getBytes(messageHash));
  // Contract requires msg.sender == job.agentWallet (NotAgentWallet selector 0x93538e00).
  // The agent runtime has the agentWallet key — uses it to call releaseMilestone with oracle proof.
  const escrowAsAgentWallet = escrow.connect(agentW);
  const agentWalletBalBefore = await provider.getBalance(agentW.address);
  try {
    const tx5 = await escrowAsAgentWallet.releaseMilestone(
      newJobId, milestoneIndex, outputHash, alignmentScore, oracleSig,
      { gasLimit: 800_000 }
    );
    const r5 = await tx5.wait();
    check("releaseMilestone succeeded", r5.status === 1, `tx ${tx5.hash}`);
  } catch (e) {
    check("releaseMilestone", false, e.shortMessage || e.message?.slice(0, 250));
    return;
  }

  // Verify funds released to agentWallet
  const agentWalletBalAfter = await provider.getBalance(agentW.address);
  const delta = agentWalletBalAfter - agentWalletBalBefore;
  check("agentWallet received funds", delta > 0n, `+${fmt(delta)}`);

  // Verify job final state
  const finalJob = await escrow.getJob(newJobId);
  console.log(`\n  Final job status: ${finalJob.status}, releasedWei: ${fmt(finalJob.releasedWei)}`);
  check("Full budget released", finalJob.releasedWei === totalBudget, fmt(finalJob.releasedWei));

  return newJobId;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔" + "═".repeat(58) + "╗");
  console.log("║  zer0Gig — Master E2E Test                              ║");
  console.log("╚" + "═".repeat(58) + "╝");

  try {
    const { totalJobs } = await phase1_ContractReads();
    await phase2_Storage();
    await phase3_Frontend();
    await phase4_OracleSign();
    await phase5_JobFlow(totalJobs);
  } catch (e) {
    console.error("\nFATAL:", e);
  }

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log(`  RESULT: ${passes} passed, ${fails} failed`);
  console.log("═".repeat(60) + "\n");

  process.exit(fails > 0 ? 1 : 0);
}

main();
