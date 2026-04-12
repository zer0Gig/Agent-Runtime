/**
 * Platform Dispatcher Entry Point (Path B)
 * 
 * Runs the Platform Dispatcher which manages jobs for multiple registered agents.
 * This is an alternative to `index.js` (Path A - Self-Hosted).
 * 
 * Usage:
 *   npm run start:platform
 */

import "dotenv/config";
import { ethers } from "ethers";
import { PlatformDispatcher } from "./services/platformDispatcher.js";
import { initTelegram } from "./services/telegramConnector.js";

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  zer0Gig Platform Dispatcher (Path B)            ║");
  console.log("║  Managing Platform-Managed Agents                ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── Validate config ──────────────────────────────────────────
  const requiredEnv = [
    "PLATFORM_PRIVATE_KEY",
    "AGENT_REGISTRY_ADDRESS",
    "PROGRESSIVE_ESCROW_ADDRESS"
  ];

  for (const key of requiredEnv) {
    if (!process.env[key]) {
      console.error(`[Platform] Missing required env: ${key}`);
      process.exit(1);
    }
  }

  // PLATFORM_AGENT_IDS is optional — auto-discovery will find agents
  const managedIds = process.env.PLATFORM_AGENT_IDS
    ? process.env.PLATFORM_AGENT_IDS.split(",")
    : [];

  // ── Setup provider & wallet ──────────────────────────────────
  const rpcUrl = process.env.OG_NEWTON_RPC || "https://evmrpc-testnet.0g.ai";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(process.env.PLATFORM_PRIVATE_KEY, provider);

  const blockNumber = await provider.getBlockNumber();
  const balance = await provider.getBalance(wallet.address);

  console.log(`[Platform] Chain RPC:         ${rpcUrl}`);
  console.log(`[Platform] Operator Wallet:   ${wallet.address}`);
  console.log(`[Platform] Balance:           ${ethers.formatEther(balance)} OG`);
  console.log(`[Platform] Block:             ${blockNumber}`);
  console.log(`[Platform] Managed Agents:    ${managedIds.length > 0 ? managedIds.join(", ") : "(auto-discover)"}`);
  console.log(`[Platform] ProgressiveEscrow: ${process.env.PROGRESSIVE_ESCROW_ADDRESS}`);
  console.log(`[Platform] SubscriptionEscrow:${process.env.SUBSCRIPTION_ESCROW_ADDRESS || "(fallback to ProgressiveEscrow)"}`);
  console.log();

  // ── Initialize Telegram Bot (if token configured) ────────────
  const tgBot = initTelegram();
  if (tgBot) {
    console.log(`[Platform] Telegram: bot active (${process.env.TELEGRAM_WEBHOOK_URL ? "webhook" : "polling"} mode)`);
  } else {
    console.log(`[Platform] Telegram: disabled (set TELEGRAM_BOT_TOKEN to enable)`);
  }
  console.log();

  // ── Initialize Dispatcher ────────────────────────────────────
  const dispatcher = new PlatformDispatcher({
    wallet,
    rpcUrl,
    registryAddress: process.env.AGENT_REGISTRY_ADDRESS,
    escrowAddress: process.env.PROGRESSIVE_ESCROW_ADDRESS,
    subscriptionEscrowAddress: process.env.SUBSCRIPTION_ESCROW_ADDRESS,
    managedAgentIds: managedIds
  });

  // ── Start Listening ──────────────────────────────────────────
  try {
    await dispatcher.start();
  } catch (error) {
    console.error("[Platform] Fatal error:", error);
    process.exit(1);
  }
}

main();
