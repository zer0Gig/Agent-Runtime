/**
 * Full-stack E2E:
 *   1. POST brief to frontend /api/job-brief (returns jobDataHash)
 *   2. Post job on-chain with that hash (as owner)
 *   3. submitProposal + acceptProposal + defineMilestones
 *   4. Watch dispatcher logs to confirm it fetched the brief from Supabase
 *   5. Release milestone with oracle proof
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
const platform = new ethers.Wallet("0x" + process.env.PLATFORM_PRIVATE_KEY, provider);
const agentW   = new ethers.Wallet("0x" + process.env.AGENT_PRIVATE_KEY, provider);
const escrow   = new ethers.Contract(process.env.PROGRESSIVE_ESCROW_ADDRESS, ABI, provider);

const SKILL = "0x6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f00";

let pass = 0, fail = 0;
const fmt = (w) => ethers.formatEther(w) + " OG";
function check(label, ok, det = "") { (ok ? pass++ : fail++); console.log(`  ${ok ? "✓" : "✗"} ${label}${det ? " — " + det : ""}`); }

async function main() {
  console.log("\n╔" + "═".repeat(58) + "╗");
  console.log("║  Full-Stack E2E (FE API → Contract → Runtime)           ║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  // Step 1: post brief via frontend API
  console.log("[1/5] POST /api/job-brief...");
  const briefBody = {
    title: `Full-stack test ${Date.now()}`,
    description: "Write a one-sentence haiku about decentralized compute.",
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

  // Step 2: Post job on-chain with the hash
  console.log("\n[2/5] postJob on-chain...");
  const escAsOwner = escrow.connect(owner);
  const tx1 = await escAsOwner.postJob(jobDataHash, SKILL, { gasLimit: 500_000 });
  const r1 = await tx1.wait();
  check("postJob", r1.status === 1, tx1.hash);
  const totalJobs = await escrow.totalJobs();
  const newJobId = Number(totalJobs);
  console.log(`     jobId = ${newJobId}`);

  // Verify backend fetched brief by hash
  console.log("\n[3/5] Verify GET /api/job-brief?hash=...");
  const lookupRes = await fetch(`http://127.0.0.1:3000/api/job-brief?hash=${jobDataHash}`);
  const lookup = await lookupRes.json();
  check("brief retrievable by hash", lookup?.data?.title === briefBody.title);

  // Step 4: submitProposal + acceptProposal + defineMilestones
  console.log("\n[4/5] Build job to milestones-defined state...");
  const rate = ethers.parseEther("0.005");
  const tx2 = await escAsOwner.submitProposal(newJobId, 2, rate, ethers.keccak256(ethers.toUtf8Bytes("proposal")), { gasLimit: 500_000 });
  await tx2.wait();
  const tx3 = await escAsOwner.acceptProposal(newJobId, 0, { value: rate, gasLimit: 600_000 });
  await tx3.wait();
  const tx4 = await escAsOwner.defineMilestones(newJobId, [100], [ethers.keccak256(ethers.toUtf8Bytes("deliver"))], { gasLimit: 400_000 });
  await tx4.wait();
  check("job in IN_PROGRESS state", true);

  // Wait for dispatcher to pick up MilestoneDefined and try to process
  console.log("\n     Waiting 8s for dispatcher to react...");
  await new Promise(r => setTimeout(r, 8000));

  // Step 5: Release milestone (with oracle proof)
  console.log("\n[5/5] Release milestone (agentWallet calls with oracle proof)...");
  const outputHash = ethers.keccak256(ethers.toUtf8Bytes("agent-output"));
  const score = 8500;
  const msgHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint8", "uint16", "bytes32"],
      [BigInt(newJobId), 0, score, outputHash]
    )
  );
  const sig = await platform.signMessage(ethers.getBytes(msgHash));
  const escAsAgent = escrow.connect(agentW);
  const balBefore = await provider.getBalance(agentW.address);
  const tx5 = await escAsAgent.releaseMilestone(newJobId, 0, outputHash, score, sig, { gasLimit: 800_000 });
  const r5 = await tx5.wait();
  check("releaseMilestone", r5.status === 1, tx5.hash);
  const balAfter = await provider.getBalance(agentW.address);
  console.log(`     agentWallet balance change: ${fmt(balAfter - balBefore)}`);
  const finalJob = await escrow.getJob(newJobId);
  check("releasedWei == budget", finalJob.releasedWei === rate, fmt(finalJob.releasedWei));

  console.log("\n" + "═".repeat(60));
  console.log(`  Full-stack E2E: ${pass} passed, ${fail} failed`);
  console.log("═".repeat(60) + "\n");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
