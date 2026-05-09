/**
 * End-to-end diagnostic + test script for AgentRegistry.mintAgent()
 *
 * Runs in 4 stages:
 *   1. Contract state audit  — scan storage slots 0-100, find all non-zero slots
 *   2. Bytecode analysis     — extract every PUSH4 4-byte selector to find unlisted setters
 *   3. mintAgent dry-run     — eth_call to capture exact revert reason across param combinations
 *   4. Fix attempt           — call any discovered setter, then retry mintAgent for real
 */

import { ethers } from "ethers";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

dotenv.config();

// ── Config ──────────────────────────────────────────────────────────────────

const RPC_URL       = process.env.OG_NEWTON_RPC   || "https://evmrpc-testnet.0g.ai";
const PLATFORM_KEY  = process.env.PLATFORM_PRIVATE_KEY;
const AGENT_KEY     = process.env.AGENT_PRIVATE_KEY;
const REGISTRY_ADDR = process.env.AGENT_REGISTRY_ADDRESS   || "0x4c49D008E72eF1E098Bcd6E75857Ed17377dB4ab";
const USER_REG_ADDR = process.env.USER_REGISTRY_ADDRESS    || "0x1958bdbb5926674026b9ac630c9A4Cb91718Aee7";
const PROG_ESCROW   = process.env.PROGRESSIVE_ESCROW_ADDRESS || "0xe9d1d260c08385b3beB68012D425e208b4cd2295";

const __dir  = dirname(fileURLToPath(import.meta.url));
const ABI_PATH = join(__dir, "../../frontend/src/lib/abis/AgentRegistry.json");

const ZERO32 = "0x" + "0".repeat(64);
const ZERO_ADDR = ethers.ZeroAddress;

// ── Helpers ──────────────────────────────────────────────────────────────────

function pad32addr(addr) {
  return "000000000000000000000000" + addr.toLowerCase().replace("0x", "");
}

function slot32ToAddress(hex) {
  return ethers.getAddress("0x" + hex.replace("0x", "").slice(-40));
}

function looksLikeAddress(hex) {
  const raw = hex.replace("0x", "").padStart(64, "0");
  const upper12 = raw.slice(0, 24);
  const lower20 = raw.slice(24);
  return upper12 === "000000000000000000000000" && lower20 !== "0".repeat(40);
}

// ── Provider ──────────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL);

// ── Stage 1: Storage audit ────────────────────────────────────────────────────

async function auditStorage() {
  console.log("\n═══════════════════════════════════════════════");
  console.log("  STAGE 1: Storage slot audit (slots 0-100)");
  console.log("═══════════════════════════════════════════════\n");

  const map = {};
  for (let slot = 0; slot <= 100; slot++) {
    const val = await provider.getStorage(REGISTRY_ADDR, slot);
    if (val !== ZERO32) {
      map[slot] = val;
      const tag = looksLikeAddress(val) ? `  → address ${slot32ToAddress(val)}` : "";
      console.log(`  slot ${String(slot).padStart(3)}: ${val}${tag}`);
    }
  }
  console.log(`\n  Total non-zero slots found: ${Object.keys(map).length}`);
  return map;
}

// ── Stage 2: Bytecode selector scan ──────────────────────────────────────────

async function extractSelectors() {
  console.log("\n═══════════════════════════════════════════════");
  console.log("  STAGE 2: 4-byte selector scan in bytecode");
  console.log("═══════════════════════════════════════════════\n");

  const code     = await provider.getCode(REGISTRY_ADDR);
  const codeHex  = code.replace("0x", "");
  const codeBuf  = Buffer.from(codeHex, "hex");
  console.log(`  Bytecode size: ${codeBuf.length} bytes`);

  const artifact = JSON.parse(readFileSync(ABI_PATH, "utf8"));
  const iface    = new ethers.Interface(artifact.abi);

  const knownSelectors = new Set();
  for (const fn of artifact.abi) {
    if (fn.type === "function") {
      try {
        const frag = iface.getFunction(fn.name);
        if (frag) knownSelectors.add(frag.selector.slice(2).toLowerCase());
      } catch {}
    }
  }

  const found = new Set();
  for (let i = 0; i < codeBuf.length - 4; i++) {
    if (codeBuf[i] === 0x63) { // PUSH4 opcode
      found.add(codeBuf.slice(i + 1, i + 5).toString("hex"));
    }
  }

  console.log(`  Selectors in ABI:      ${knownSelectors.size}`);
  console.log(`  PUSH4 values in code:  ${found.size}`);

  const unknown = [...found].filter(s => !knownSelectors.has(s) && s !== "00000000" && s !== "ffffffff");
  if (unknown.length === 0) {
    console.log("  ✓ No hidden selectors — ABI fully covers deployed bytecode");
  } else {
    console.log(`\n  ⚠ ${unknown.length} unlisted selector(s):`);
    unknown.forEach(s => console.log(`    0x${s}`));
  }

  return { knownSelectors, unknownSelectors: unknown };
}

// ── Stage 3: mintAgent dry-run ────────────────────────────────────────────────

const KNOWN_ERRORS = {
  "0xd92e233d": "ZeroAddress()",
  "0x08c379a0": "Error(string)",
  "0x4e487b71": "Panic(uint256)",
  "0x6f483d09": "EmptyEciesKey()",
  "0x3a3a0058": "EmptySealedKey()",
  "0x80c98b4f": "OracleNotSet()",
  "0x44980d8f": "EmptyCID()",
  "0xf01dae99": "InvalidTokenId()",
  "0x5c9ecb3c": "NotAgentOwner()",
  "0x53b42045": "EmptySealedKey()",
  "0x3d7e903d": "ZeroRoot()",
};

function decodeRevert(err) {
  const data = err?.data
    || err?.info?.error?.data
    || err?.error?.data
    || err?.cause?.data
    || "";
  if (!data) return "(no revert data — check RPC support)";
  const sel = typeof data === "string" ? data.slice(0, 10).toLowerCase() : "";
  if (KNOWN_ERRORS[sel]) return KNOWN_ERRORS[sel];

  // Try decoding Error(string)
  if (sel === "0x08c379a0") {
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10));
      return `Error("${decoded[0]}")`;
    } catch {}
  }
  return `unknown(${data.slice(0, 20)})`;
}

async function dryRunMintAgent() {
  console.log("\n═══════════════════════════════════════════════");
  console.log("  STAGE 3: mintAgent dry-run variations");
  console.log("═══════════════════════════════════════════════\n");

  const artifact = JSON.parse(readFileSync(ABI_PATH, "utf8"));
  const iface    = new ethers.Interface(artifact.abi);

  const platformAddr = PLATFORM_KEY ? new ethers.Wallet(PLATFORM_KEY).address : "0x48379F4d1427209311E9FF0bcC4a354953ea631B";
  const agentAddr    = AGENT_KEY    ? new ethers.Wallet(AGENT_KEY).address    : "0xca0d79AFb84680AbC76613c72E7dEFe8b9B840B8";

  const pubKey65 = "0x04" + "ab".repeat(32);   // valid-length 65-byte ECIES pub key

  const cases = [
    { label: "valid agentWallet (platform)", agentWallet: platformAddr, from: platformAddr },
    { label: "valid agentWallet (agent)",    agentWallet: agentAddr,    from: platformAddr },
    { label: "ZERO agentWallet",             agentWallet: ZERO_ADDR,    from: platformAddr },
    { label: "UserRegistry as agentWallet",  agentWallet: USER_REG_ADDR, from: platformAddr },
    { label: "caller = agentWallet = same",  agentWallet: platformAddr, from: platformAddr },
  ];

  for (const c of cases) {
    const calldata = iface.encodeFunctionData("mintAgent", [
      1000,
      ethers.keccak256(ethers.toUtf8Bytes("test-profile")),
      ethers.keccak256(ethers.toUtf8Bytes("test-capability")),
      [],                 // no skills
      c.agentWallet,
      pubKey65,
      "0x01",
    ]);

    try {
      const result = await provider.call({ from: c.from, to: REGISTRY_ADDR, data: calldata });
      const agentId = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], result)[0];
      console.log(`  ✓ SUCCEEDED (agentId=${agentId}) — ${c.label}`);
    } catch (err) {
      console.log(`  ✗ ${decodeRevert(err).padEnd(30)} — ${c.label}`);
    }
  }

  // Also try with empty skillIds[] replaced by non-empty to isolate
  const callEmptyCap = iface.encodeFunctionData("mintAgent", [
    1000,
    ethers.keccak256(ethers.toUtf8Bytes("test-profile")),
    ethers.ZeroHash,    // zero capabilityHash — should trigger ZeroRoot() if that's the check
    [],
    platformAddr,
    pubKey65,
    "0x01",
  ]);
  try {
    await provider.call({ from: platformAddr, to: REGISTRY_ADDR, data: callEmptyCap });
    console.log(`  ✓ SUCCEEDED with zero capHash — ${platformAddr}`);
  } catch (err) {
    console.log(`  ✗ ${decodeRevert(err).padEnd(30)} — zero capabilityHash test`);
  }

  const callEmptyProf = iface.encodeFunctionData("mintAgent", [
    1000,
    ethers.ZeroHash,    // zero profileHash
    ethers.keccak256(ethers.toUtf8Bytes("test-capability")),
    [],
    platformAddr,
    pubKey65,
    "0x01",
  ]);
  try {
    await provider.call({ from: platformAddr, to: REGISTRY_ADDR, data: callEmptyProf });
    console.log(`  ✓ SUCCEEDED with zero profileHash`);
  } catch (err) {
    console.log(`  ✗ ${decodeRevert(err).padEnd(30)} — zero profileHash test`);
  }

  // Short ecies key (< 65 bytes) — should trigger EmptyEciesKey or similar
  const callShortKey = iface.encodeFunctionData("mintAgent", [
    1000,
    ethers.keccak256(ethers.toUtf8Bytes("test-profile")),
    ethers.keccak256(ethers.toUtf8Bytes("test-capability")),
    [],
    platformAddr,
    "0x04ab",           // only 2 bytes
    "0x01",
  ]);
  try {
    await provider.call({ from: platformAddr, to: REGISTRY_ADDR, data: callShortKey });
    console.log(`  ✓ SUCCEEDED with short ecies key`);
  } catch (err) {
    console.log(`  ✗ ${decodeRevert(err).padEnd(30)} — short ecies key test`);
  }

  // Zero ecies (65 zero bytes)
  const callZeroKey = iface.encodeFunctionData("mintAgent", [
    1000,
    ethers.keccak256(ethers.toUtf8Bytes("test-profile")),
    ethers.keccak256(ethers.toUtf8Bytes("test-capability")),
    [],
    platformAddr,
    "0x" + "00".repeat(65),
    "0x01",
  ]);
  try {
    await provider.call({ from: platformAddr, to: REGISTRY_ADDR, data: callZeroKey });
    console.log(`  ✓ SUCCEEDED with 65-zero ecies key`);
  } catch (err) {
    console.log(`  ✗ ${decodeRevert(err).padEnd(30)} — 65-zero ecies key test`);
  }
}

// ── Stage 4: Fix + real transaction ──────────────────────────────────────────

async function attemptFix(storageMap, unknownSelectors) {
  console.log("\n═══════════════════════════════════════════════");
  console.log("  STAGE 4: Fix attempt + real mintAgent tx");
  console.log("═══════════════════════════════════════════════\n");

  if (!PLATFORM_KEY) {
    console.log("  ✗ PLATFORM_PRIVATE_KEY not set in .env — skipping");
    return null;
  }

  const signer   = new ethers.Wallet(PLATFORM_KEY, provider);
  const artifact = JSON.parse(readFileSync(ABI_PATH, "utf8"));
  const registry = new ethers.Contract(REGISTRY_ADDR, artifact.abi, signer);

  console.log(`  Signer: ${signer.address}`);
  const bal = await provider.getBalance(signer.address);
  console.log(`  Balance: ${ethers.formatEther(bal)} OG\n`);

  // Dump current public state
  try {
    const owner  = await registry.owner();
    const oracle = await registry.oracle();
    const paused = await registry.paused();
    const total  = await registry.totalAgents();
    const escOk  = await registry.authorizedEscrows(PROG_ESCROW);
    console.log(`  owner()  = ${owner}`);
    console.log(`  oracle() = ${oracle}`);
    console.log(`  paused() = ${paused}`);
    console.log(`  totalAgents() = ${total}`);
    console.log(`  authorizedEscrows[progEscrow] = ${escOk}`);
  } catch (e) {
    console.log(`  ✗ state read failed: ${e.message}`);
  }

  // Probe unknown selectors as setter(address) calls
  if (unknownSelectors.length > 0) {
    console.log("\n  Probing unknown selectors as set<X>(address):");
    for (const sel of unknownSelectors) {
      const data = "0x" + sel + pad32addr(USER_REG_ADDR);
      try {
        await provider.call({ from: signer.address, to: REGISTRY_ADDR, data });
        console.log(`  ✓ 0x${sel}(userRegistry) succeeds via eth_call — sending tx...`);
        const tx = await signer.sendTransaction({ to: REGISTRY_ADDR, data, gasLimit: 200_000 });
        await tx.wait();
        console.log(`    ✓ tx confirmed: ${tx.hash}`);
      } catch {}

      const data2 = "0x" + sel + pad32addr(PROG_ESCROW);
      try {
        await provider.call({ from: signer.address, to: REGISTRY_ADDR, data: data2 });
        console.log(`  ✓ 0x${sel}(progEscrow) succeeds via eth_call — sending tx...`);
        const tx = await signer.sendTransaction({ to: REGISTRY_ADDR, data: data2, gasLimit: 200_000 });
        await tx.wait();
        console.log(`    ✓ tx confirmed: ${tx.hash}`);
      } catch {}
    }
  }

  // Now fire the real mintAgent using agent wallet as signer
  // Agent wallet is registered as FreelancerOwner and has enough OG
  // We generate a FRESH wallet for agentWallet (must differ from msg.sender)
  const agentSigner = AGENT_KEY
    ? new ethers.Wallet(AGENT_KEY.startsWith("0x") ? AGENT_KEY : `0x${AGENT_KEY}`, provider)
    : signer;
  const registryAsSigner = registry.connect(agentSigner);

  console.log(`\n  Using signer: ${agentSigner.address}`);
  const signerBal = await provider.getBalance(agentSigner.address);
  console.log(`  Signer balance: ${ethers.formatEther(signerBal)} OG`);

  // The real mintAgent transaction
  console.log("\n  Firing real mintAgent transaction...");

  // IMPORTANT: agentWallet must NOT equal msg.sender — generate fresh
  const freshAgentWallet = ethers.Wallet.createRandom();
  const pubKey65         = "0x04" + "ab".repeat(32);

  const defaultRateWei  = ethers.parseEther("0.01");
  const defaultRate     = Number(defaultRateWei / BigInt(10_000_000_000));

  console.log(`  signer      = ${agentSigner.address}  (msg.sender)`);
  console.log(`  agentWallet = ${freshAgentWallet.address}  (fresh, != signer)`);
  console.log(`  defaultRate = ${defaultRate}`);

  try {
    const tx = await registryAsSigner.mintAgent(
      defaultRate,
      ethers.keccak256(ethers.toUtf8Bytes("e2e-profile")),
      ethers.keccak256(ethers.toUtf8Bytes("e2e-capability")),
      [],
      freshAgentWallet.address,
      pubKey65,
      "0x01",
      { gasLimit: 2_000_000 }
    );
    console.log(`\n  ✓ TX submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  ✓ Confirmed in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed})`);

    const mintedLog = receipt.logs
      .map(l => { try { return registryAsSigner.interface.parseLog(l); } catch { return null; } })
      .find(e => e?.name === "AgentMinted");

    if (mintedLog) {
      const { agentId, owner, agentWallet: aw } = mintedLog.args;
      console.log(`\n  ✓ AgentMinted event:`);
      console.log(`    agentId     = ${agentId}`);
      console.log(`    owner       = ${owner}`);
      console.log(`    agentWallet = ${aw}`);
      console.log(`\n  *** Save freshAgentWallet private key: ${freshAgentWallet.privateKey}`);
    }

    return mintedLog?.args?.agentId ?? null;
  } catch (err) {
    console.log(`\n  ✗ mintAgent FAILED: ${err.message?.slice(0, 300)}`);
    const data = err?.data || err?.info?.error?.data || "";
    if (data) console.log(`  Revert data: ${data}`);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔═══════════════════════════════════════════════════╗");
  console.log("║  AgentRegistry — E2E Diagnostic + Test            ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log(`\n  Contract : ${REGISTRY_ADDR}`);
  console.log(`  RPC      : ${RPC_URL}`);

  try {
    const net = await provider.getNetwork();
    console.log(`  Chain ID : ${net.chainId}`);
  } catch {
    console.log("  ✗ Cannot reach RPC");
    return;
  }

  const storageMap               = await auditStorage();
  const { unknownSelectors }     = await extractSelectors();
  await dryRunMintAgent();
  const mintedId                 = await attemptFix(storageMap, unknownSelectors);

  console.log("\n╔═══════════════════════════════════════════════════╗");
  if (mintedId !== null) {
    console.log(`║  ✓ SUCCESS — agentId ${mintedId} minted              ║`);
  } else {
    console.log("║  ✗ mintAgent still reverts — needs re-deployment   ║");
  }
  console.log("╚═══════════════════════════════════════════════════╝\n");
}

main().catch(console.error);
