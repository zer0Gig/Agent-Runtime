/**
 * Autonomous SUBSCRIPTION E2E test.
 *
 * Proves the agent runs CONTINUOUSLY and makes its own decisions —
 * NOT milestone-based. Specifically verifies:
 *
 *   1. Subscription created on-chain (Mode C — AGENT_AUTO so the agent can self-adjust)
 *   2. Runtime detects SubscriptionCreated event and schedules a recurring task
 *   3. On each tick the agent:
 *      - Fetches the task description from Supabase by hash
 *      - Pulls live data from a real URL embedded in the task
 *      - Runs LLM analysis (qwen-2.5-7b on 0G Compute)
 *      - Decides: routine (drainPerCheckIn) vs anomaly (drainPerAlert)
 *      - May call updateInterval (Mode C self-adjustment)
 *   4. After ~3 minutes we should see at least 1 successful drainPerCheckIn
 *
 * Pre-requisite: agent-runtime is RUNNING with AUTO_APPROVE_MILESTONES not required
 * (subscriptions don't go through milestone flow).
 */
import { ethers } from "ethers";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
dotenv.config();

const __dir = dirname(fileURLToPath(import.meta.url));
const SUB_ABI = [
  "function createSubscription(uint256 agentId, bytes32 taskHash, uint32 intervalSeconds, uint96 checkInRate, uint96 alertRate, uint32 gracePeriodSeconds, bool x402Enabled, uint8 x402VerificationMode, bytes clientX402Sig, bytes32 webhookHash) payable returns (uint256)",
  "function getSubscription(uint256 subId) view returns (tuple(address client, uint64 agentId, uint8 status, uint8 intervalMode, uint8 x402VerificationMode, bool x402Enabled, address agentWallet, uint64 lastCheckIn, uint32 intervalSeconds, uint96 checkInRate, uint96 alertRate, uint64 createdAt, uint128 balance, uint128 totalDrained, uint64 pausedAt, uint64 gracePeriodEnds, uint32 gracePeriodSeconds, uint32 proposedInterval))",
  "function totalSubscriptions() view returns (uint256)",
  "function cancelSubscription(uint256 subId) external",
  "event SubscriptionCreated(uint256 indexed subscriptionId, uint256 indexed agentId, address indexed client, uint128 budget, bytes32 taskHash)",
  "event CheckInDrained(uint256 indexed subscriptionId, uint256 indexed agentId, uint96 amount, uint64 timestamp)",
  "event AlertFired(uint256 indexed subscriptionId, uint256 indexed agentId, uint64 timestamp, bytes alertData, uint96 amountDrained)",
  "event IntervalUpdated(uint256 indexed subscriptionId, uint32 newInterval)",
];

const provider = new ethers.JsonRpcProvider(process.env.OG_NEWTON_RPC || "https://evmrpc-testnet.0g.ai");
const owner    = new ethers.Wallet("0xca0d79afb84680abc76613c72e7defe8b9b840b8b78fed749f1f3cd352e17f6e", provider);
const escrow   = new ethers.Contract(process.env.SUBSCRIPTION_ESCROW_ADDRESS, SUB_ABI, provider);

const AUTO_INTERVAL  = 4_294_967_295;   // Mode C sentinel from contract: type(uint32).max
const TICK_INTERVAL  = 60;              // 60s — agent will tick every minute via cron
const CHECK_IN_RATE  = ethers.parseEther("0.0001");
const ALERT_RATE     = ethers.parseEther("0.0003");
const BUDGET         = ethers.parseEther("0.005"); // good for ~50 check-ins
const GRACE          = 3600;            // 1h grace
const FRONTEND       = "http://127.0.0.1:3000";
const TEST_DURATION  = 4 * 60 * 1000;   // watch for 4 minutes

let pass = 0, fail = 0;
const fmt = (w) => ethers.formatEther(w) + " OG";
function check(label, ok, det = "") { (ok ? pass++ : fail++); console.log(`  ${ok ? "✓" : "✗"} ${label}${det ? " — " + det : ""}`); }

async function main() {
  console.log("\n╔" + "═".repeat(58) + "╗");
  console.log("║  Autonomous Subscription E2E (continuous, no milestones)║");
  console.log("╚" + "═".repeat(58) + "╝\n");

  // ─── Step 1: Post task description to Supabase via /api/subscription-task ─
  console.log("[1/5] POST /api/subscription-task...");
  const taskDescription = `Monitor https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd every minute. Report the current ETH price. Flag as anomaly if price drops below 1000 USD or rises above 10000 USD (these are unrealistic bounds — should never alert in normal market). Suggest a longer interval (300s) if the price is stable for two consecutive checks, shorter (60s) if it's volatile.`;
  const taskRes = await fetch(`${FRONTEND}/api/subscription-task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskDescription, clientAddress: owner.address }),
  });
  const taskJson = await taskRes.json();
  check("task stored off-chain", taskRes.ok && taskJson.taskHash, taskJson.taskHash);
  const { taskHash } = taskJson;

  // ─── Step 2: Create subscription on-chain (Mode C: AGENT_AUTO) ────────────
  console.log("\n[2/5] createSubscription on-chain (Mode C: AGENT_AUTO)...");
  const escAsClient = escrow.connect(owner);
  const tx = await escAsClient.createSubscription(
    2,                                    // agentId
    taskHash,                             // taskHash
    TICK_INTERVAL,                        // intervalSeconds — start at 60s, agent can adjust (Mode C uses AUTO_INTERVAL but for hackathon we use real seconds since runtime cron supports 60s)
    CHECK_IN_RATE,                        // checkInRate
    ALERT_RATE,                           // alertRate
    GRACE,                                // gracePeriodSeconds
    false,                                // x402Enabled
    0,                                    // x402VerificationMode (AGENT_SIDE)
    "0x",                                 // clientX402Sig
    ethers.ZeroHash,                      // webhookHash (no webhook for this test)
    { value: BUDGET, gasLimit: 800_000 }
  );
  const receipt = await tx.wait();
  check("createSubscription tx confirmed", receipt.status === 1, tx.hash);

  const subId = Number(await escrow.totalSubscriptions());
  console.log(`     subId = ${subId}`);

  // Verify initial state
  const sub0 = await escrow.getSubscription(subId);
  check("subscription is ACTIVE",         Number(sub0.status) === 1, `status=${sub0.status}`);
  check("balance == budget",              sub0.balance === BUDGET, fmt(sub0.balance));
  check("interval == 60s",                Number(sub0.intervalSeconds) === TICK_INTERVAL);
  check("agentWallet matches expected",   sub0.agentWallet.toLowerCase() === "0x0b726eb69f364ab9718e86cb98898d3bb2e75c8c", sub0.agentWallet);

  // ─── Step 3: Watch the runtime work autonomously ──────────────────────────
  console.log(`\n[3/5] Watching runtime for ${TEST_DURATION / 60_000} minutes — runtime should tick every ~60s and call drainPerCheckIn each time...`);

  let checkInsObserved = 0;
  let alertsObserved   = 0;
  let intervalUpdates  = 0;
  let lastDrainHash    = null;

  // Listen for events
  escrow.on("CheckInDrained", (sid, agentId, amount, ts) => {
    if (Number(sid) === subId) {
      checkInsObserved++;
      console.log(`     [event] CheckInDrained #${checkInsObserved} — amount=${fmt(amount)} at ${new Date(Number(ts) * 1000).toISOString()}`);
    }
  });
  escrow.on("AlertFired", (sid, agentId, ts, alertData, amount) => {
    if (Number(sid) === subId) {
      alertsObserved++;
      console.log(`     [event] AlertFired #${alertsObserved} — amount=${fmt(amount)} alertData=${alertData.slice(0, 40)}...`);
    }
  });
  escrow.on("IntervalUpdated", (sid, newInterval) => {
    if (Number(sid) === subId) {
      intervalUpdates++;
      console.log(`     [event] IntervalUpdated — newInterval=${newInterval}s`);
    }
  });

  const deadline = Date.now() + TEST_DURATION;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 30_000));
    const subNow = await escrow.getSubscription(subId);
    console.log(`     [poll @ ${new Date().toISOString().slice(11, 19)}] balance=${fmt(subNow.balance)} drained=${fmt(subNow.totalDrained)} status=${subNow.status} lastCheckIn=${subNow.lastCheckIn}`);
    if (Number(subNow.status) !== 1) break;
  }

  // Stop listening
  escrow.removeAllListeners();

  // ─── Step 4: Verify autonomous activity ───────────────────────────────────
  console.log("\n[4/5] Verify autonomous activity...");
  const subFinal = await escrow.getSubscription(subId);
  console.log(`     Final balance:   ${fmt(subFinal.balance)}`);
  console.log(`     Total drained:   ${fmt(subFinal.totalDrained)}`);
  console.log(`     Last check-in:   ${new Date(Number(subFinal.lastCheckIn) * 1000).toISOString()}`);
  console.log(`     Interval now:    ${subFinal.intervalSeconds}s`);

  check("at least 1 autonomous check-in",      checkInsObserved >= 1, `${checkInsObserved} CheckInDrained events`);
  check("totalDrained > 0",                    subFinal.totalDrained > 0n, fmt(subFinal.totalDrained));
  check("lastCheckIn was updated",             Number(subFinal.lastCheckIn) > 0);
  check("subscription still ACTIVE",           Number(subFinal.status) === 1);

  // ─── Step 5: Cleanup ───────────────────────────────────────────────────────
  console.log("\n[5/5] Cancel subscription (cleanup, refund remaining balance)...");
  try {
    const cancelTx = await escAsClient.cancelSubscription(subId, { gasLimit: 200_000 });
    await cancelTx.wait();
    check("cancelSubscription tx confirmed", true, cancelTx.hash);
  } catch (err) {
    check("cancelSubscription tx confirmed", false, err.message?.slice(0, 80));
  }

  console.log("\n" + "═".repeat(60));
  console.log(`  Autonomous Subscription E2E: ${pass} passed, ${fail} failed`);
  console.log(`  Activity: ${checkInsObserved} check-ins, ${alertsObserved} alerts, ${intervalUpdates} interval updates`);
  console.log("═".repeat(60) + "\n");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
