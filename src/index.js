require("dotenv").config();
const { ethers } = require("ethers");

// ABI minimal untuk listen events dari ProgressiveEscrow
const ESCROW_ABI = [
  "event JobCreated(uint256 indexed jobId, address indexed client, uint256 indexed agentId, uint256 totalBudgetWei, string jobDataCID)",
  "event MilestoneDefined(uint256 indexed jobId, uint8 milestoneCount)",
];

async function main() {
  console.log("[Agent Runtime] Starting...");
  console.log(`[Agent Runtime] Chain: ${process.env.CHAIN_ID || 16600}`);
  console.log(`[Agent Runtime] Agent ID: ${process.env.AGENT_ID || "not set"}`);

  // Setup provider dan wallet
  const provider = new ethers.JsonRpcProvider(
    process.env.OG_NEWTON_RPC || "https://rpc-testnet.0g.ai"
  );

  const blockNumber = await provider.getBlockNumber();
  console.log(`[Agent Runtime] Connected to chain. Block: ${blockNumber}`);

  // Setup contract listener
  const escrowAddress = process.env.PROGRESSIVE_ESCROW_ADDRESS;
  if (!escrowAddress) {
    console.warn("[Agent Runtime] PROGRESSIVE_ESCROW_ADDRESS not set. Waiting for deployment...");
    console.log("[Agent Runtime] Set the address in .env after Dex deploys contracts.");
    return;
  }

  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);

  // Listen for JobCreated events
  escrow.on("JobCreated", (jobId, client, agentId, totalBudgetWei, jobDataCID) => {
    console.log(`\n[Agent Runtime] === NEW JOB DETECTED ===`);
    console.log(`  Job ID:    ${jobId}`);
    console.log(`  Client:    ${client}`);
    console.log(`  Agent ID:  ${agentId}`);
    console.log(`  Budget:    ${ethers.formatEther(totalBudgetWei)} OG`);
    console.log(`  Data CID:  ${jobDataCID}`);

    // TODO: Trigger jobProcessor.processJob(jobId)
    console.log(`  [TODO] Will process this job via jobProcessor.js`);
  });

  escrow.on("MilestoneDefined", (jobId, milestoneCount) => {
    console.log(`\n[Agent Runtime] Milestones defined for Job ${jobId}: ${milestoneCount} milestones`);
    // TODO: Start working on first milestone
  });

  console.log("[Agent Runtime] Listening for events on ProgressiveEscrow:", escrowAddress);
  console.log("[Agent Runtime] Ready. Waiting for jobs...\n");
}

main().catch((error) => {
  console.error("[Agent Runtime] Fatal error:", error);
  process.exit(1);
});
