/**
 * Subscription E2E Test
 *
 * Flow:
 *   1. Client creates subscription (with budget, interval, rate)
 *   2. Verify SubscriptionCreated event
 *   3. AgentWallet calls drainPerCheckIn → drains checkInRate
 *   4. AgentWallet fires drainPerAlert → drains alertRate
 *   5. Client cancels (refund remaining)
 */

import { ethers } from "ethers";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));
const ABI = JSON.parse(readFileSync(join(__dir, "../../frontend/src/lib/abis/SubscriptionEscrow.json"), "utf8")).abi;

const provider = new ethers.JsonRpcProvider(process.env.OG_NEWTON_RPC || "https://evmrpc-testnet.0g.ai");
const owner    = new ethers.Wallet("0xca0d79afb84680abc76613c72e7defe8b9b840b8b78fed749f1f3cd352e17f6e", provider);
const agentW   = new ethers.Wallet("0x" + process.env.AGENT_PRIVATE_KEY, provider);

const SUB_ESC = process.env.SUBSCRIPTION_ESCROW_ADDRESS;
const subEsc = new ethers.Contract(SUB_ESC, ABI, provider);

let pass = 0, fail = 0;
function check(label, ok, detail = "") {
  if (ok) { console.log(`  ✓ ${label}` + (detail ? ` — ${detail}` : "")); pass++; }
  else    { console.log(`  ✗ ${label}` + (detail ? ` — ${detail}` : "")); fail++; }
}

const fmt = (wei) => ethers.formatEther(wei) + " OG";

async function main() {
  console.log("\n╔" + "═".repeat(58) + "╗");
  console.log("║  Subscription E2E Test                                  ║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  console.log(`  SubscriptionEscrow: ${SUB_ESC}`);
  console.log(`  Client (owner)    : ${owner.address}`);
  console.log(`  agentWallet       : ${agentW.address}`);

  const totalSubsBefore = await subEsc.totalSubscriptions();
  console.log(`  totalSubscriptions: ${totalSubsBefore}\n`);

  // Step 1: Create subscription
  console.log("[1/5] Client creates subscription...");
  const taskHash       = ethers.keccak256(ethers.toUtf8Bytes(`subtask-${Date.now()}`));
  const intervalSec    = 60;       // 60-second check-ins
  const checkInRate    = ethers.parseEther("0.001");    // 0.001 OG per check-in
  const alertRate      = ethers.parseEther("0.0005");   // 0.0005 OG per alert
  const gracePeriod    = 30;
  const budget         = ethers.parseEther("0.01");     // 10 check-ins worth

  const subEscClient = subEsc.connect(owner);
  let subId;
  try {
    const tx = await subEscClient.createSubscription(
      2,                    // agentId
      taskHash,
      intervalSec,
      checkInRate,
      alertRate,
      gracePeriod,
      false,                // sessionVoucherEnabled (OKX APP session voucher)
      0,                    // voucherMode (0 = Delegated, 1 = Explicit Confirm)
      "0x",                 // clientVoucherSig (empty — runtime path lands post-demo)
      ethers.ZeroHash,      // webhookHash
      { value: budget, gasLimit: 800_000 }
    );
    const r = await tx.wait();
    check("createSubscription", r.status === 1, `tx ${tx.hash}`);

    // Find SubscriptionCreated event
    const evt = r.logs
      .map(l => { try { return subEsc.interface.parseLog(l); } catch { return null; } })
      .find(e => e?.name === "SubscriptionCreated");
    if (evt) {
      subId = evt.args.subscriptionId;
      console.log(`     subscriptionId = ${subId}, agentId = ${evt.args.agentId}, budget = ${fmt(evt.args.budget)}`);
      check("SubscriptionCreated event fired", true);
      check("Event has correct agentId", evt.args.agentId === 2n);
      check("Event has correct budget", evt.args.budget === budget);
    }
  } catch (e) {
    check("createSubscription", false, e.shortMessage || e.message?.slice(0, 200));
    return;
  }

  // Step 2: Read subscription state
  console.log("\n[2/5] Verify subscription state...");
  const sub = await subEsc.getSubscription(subId);
  check("sub.client == owner", sub.client.toLowerCase() === owner.address.toLowerCase());
  check("sub.agentId == 2", sub.agentId === 2n);
  check("sub.checkInRate matches", sub.checkInRate === checkInRate, fmt(sub.checkInRate));
  check("sub.alertRate matches", sub.alertRate === alertRate, fmt(sub.alertRate));
  check("sub.balance == budget", sub.balance === budget, fmt(sub.balance));
  check("sub.agentWallet matches", sub.agentWallet.toLowerCase() === agentW.address.toLowerCase());
  console.log(`     status=${sub.status}, intervalSeconds=${sub.intervalSeconds}`);

  // Step 3: Agent drains a check-in
  console.log("\n[3/5] AgentWallet drains a check-in...");
  // Wait a bit since the very first checkIn might be too early
  console.log("     (waiting for interval to elapse...)");
  await new Promise(r => setTimeout(r, 2000));
  const subEscAgent = subEsc.connect(agentW);
  const balBefore = await provider.getBalance(agentW.address);
  try {
    const tx = await subEscAgent.drainPerCheckIn(subId, { gasLimit: 500_000 });
    const r = await tx.wait();
    check("drainPerCheckIn", r.status === 1, `tx ${tx.hash}`);
    const balAfter = await provider.getBalance(agentW.address);
    const delta = balAfter - balBefore;
    console.log(`     agentWallet delta = ${fmt(delta)}`);
    check("agentWallet received funds", delta > 0n);
  } catch (e) {
    const data = e.data || e.info?.error?.data || "";
    const sel = typeof data === "string" ? data.slice(0, 10) : "";
    console.log(`     (note: ${sel || e.shortMessage || e.message?.slice(0, 100)})`);
    check("drainPerCheckIn (may need interval wait)", false, sel);
  }

  // Step 4: Try drainPerAlert
  console.log("\n[4/5] AgentWallet fires alert (drainPerAlert)...");
  const alertData = ethers.toUtf8Bytes("BTC price > $100k threshold breached");
  try {
    const tx = await subEscAgent.drainPerAlert(subId, alertData, { gasLimit: 500_000 });
    const r = await tx.wait();
    check("drainPerAlert", r.status === 1, `tx ${tx.hash}`);
  } catch (e) {
    const data = e.data || e.info?.error?.data || "";
    const sel = typeof data === "string" ? data.slice(0, 10) : "";
    const errs = {
      "0x80b62fa6": "AlertsDisabled() — alerts not enabled for this sub",
    };
    console.log(`     (note: ${errs[sel] || sel || e.shortMessage?.slice(0, 100)})`);
    check("drainPerAlert (may not be enabled)", false, sel);
  }

  // Step 5: Client cancels subscription
  console.log("\n[5/5] Client cancels subscription...");
  try {
    const subBefore = await subEsc.getSubscription(subId);
    const ownerBalBefore = await provider.getBalance(owner.address);
    const tx = await subEscClient.cancelSubscription(subId, { gasLimit: 500_000 });
    const r = await tx.wait();
    check("cancelSubscription", r.status === 1, `tx ${tx.hash}`);

    const subAfter = await subEsc.getSubscription(subId);
    console.log(`     status went ${subBefore.status} → ${subAfter.status}`);
    check("Subscription status changed", subAfter.status !== subBefore.status, `→ ${subAfter.status}`);
  } catch (e) {
    check("cancelSubscription", false, e.shortMessage || e.message?.slice(0, 100));
  }

  console.log("\n" + "═".repeat(60));
  console.log(`  Subscription E2E: ${pass} passed, ${fail} failed`);
  console.log("═".repeat(60) + "\n");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(console.error);
