/**
 * Probe releaseMilestone signing format by trying multiple encodings via eth_call
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
const platform = new ethers.Wallet("0x" + process.env.PLATFORM_PRIVATE_KEY, provider);
const escrow   = new ethers.Contract(process.env.PROGRESSIVE_ESCROW_ADDRESS, ABI, provider);

const jobId = 2n;
const milestoneIndex = 0;
const outputHash = ethers.keccak256(ethers.toUtf8Bytes("test-output"));
const alignmentScore = 8500;

// Get current job state first
const job = await escrow.getJob(jobId);
console.log("Job state:");
console.log("  status:", job.status, "(0=OPEN, 1=PENDING_MILES?, 2=IN_PROGRESS?, ...)");
console.log("  agentId:", job.agentId);
console.log("  milestoneCount:", job.milestoneCount);
console.log("  client:", job.client);
console.log("  agentWallet:", job.agentWallet);
console.log("");

const variants = [
  {
    label: "abi.encode(uint256,uint8,uint16,bytes32) jobId,m,score,output",
    types: ["uint256", "uint8", "uint16", "bytes32"],
    values: [jobId, milestoneIndex, alignmentScore, outputHash],
    pack: false,
  },
  {
    label: "abi.encode(uint256,uint8,bytes32,uint16) jobId,m,output,score",
    types: ["uint256", "uint8", "bytes32", "uint16"],
    values: [jobId, milestoneIndex, outputHash, alignmentScore],
    pack: false,
  },
  {
    label: "encodePacked(uint256,uint8,bytes32,uint16) jobId,m,output,score",
    types: ["uint256", "uint8", "bytes32", "uint16"],
    values: [jobId, milestoneIndex, outputHash, alignmentScore],
    pack: true,
  },
  {
    label: "encodePacked(uint256,uint8,uint16,bytes32) jobId,m,score,output",
    types: ["uint256", "uint8", "uint16", "bytes32"],
    values: [jobId, milestoneIndex, alignmentScore, outputHash],
    pack: true,
  },
  {
    label: "encodePacked addr(escrow)+jobId+m+output+score",
    types: ["address", "uint256", "uint8", "bytes32", "uint16"],
    values: [escrow.target, jobId, milestoneIndex, outputHash, alignmentScore],
    pack: true,
  },
];

for (const v of variants) {
  let messageHash;
  try {
    if (v.pack) {
      messageHash = ethers.solidityPackedKeccak256(v.types, v.values);
    } else {
      messageHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(v.types, v.values));
    }
    const sig = await platform.signMessage(ethers.getBytes(messageHash));
    const calldata = escrow.interface.encodeFunctionData("releaseMilestone", [
      jobId, milestoneIndex, outputHash, alignmentScore, sig,
    ]);

    try {
      await provider.call({
        from: "0x0B726Eb69f364ab9718e86cB98898D3bB2e75C8C", // agentWallet
        to: escrow.target,
        data: calldata,
      });
      console.log(`✓ ${v.label}`);
    } catch (e) {
      const data = e.data || e.info?.error?.data || "";
      const sel = typeof data === "string" ? data.slice(0, 10) : "";
      const errs = {
        "0x8baa579f": "InvalidSignature()",
        "0x6249a9c7": "JobNotInProgress()",
        "0x345d337f": "InvalidMilestoneIndex()",
        "0xfdf4d873": "MilestoneFinalized()",
        "0x15561365": "MaxRetriesReached()",
        "0xb87f3be1": "PercentageNotZero()",
        "0xc78c0e0d": "InvalidScore()",
      };
      console.log(`✗ ${v.label} → ${errs[sel] || data.slice(0, 14) || e.shortMessage?.slice(0, 60)}`);
    }
  } catch (e) {
    console.log(`✗ ${v.label} (encoding error) ${e.message?.slice(0, 80)}`);
  }
}
