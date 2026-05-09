/**
 * Platform Dispatcher
 *
 * The core orchestrator for Platform-Managed Agents (Path B).
 * Listens for job events on the blockchain, loads agent configurations from 0G Storage,
 * and routes jobs to the appropriate PlatformJobProcessor.
 *
 * Auto-discovery:
 *  - Listens for AgentMinted events → auto-adds platform-managed agents
 *  - Periodic registry scan → catches agents minted while offline
 *  - No need to pre-configure PLATFORM_AGENT_IDS
 */

import { ethers } from "ethers";
import { StorageService } from "./storageService.js";
import { PlatformJobProcessor } from "./platformJobProcessor.js";
import { CustomerServiceBot } from "./telegramConnector.js";
import { ExtendedComputeService } from "./extendedComputeService.js";
import { MemoryService } from "./memoryService.js";
import { AlertDelivery } from "./alertDelivery.js";
import { AgentScheduler } from "./scheduler.js";
import { validateCapabilityManifest } from "../schemas/capabilitySchema.js";
import { executeForJob } from "./toolExecutor.js";
import { EventWatcher } from "./eventWatcher.js";
import { logActivity } from "./jobProcessor.js";

// ABIs aligned to ERC-7857 / ERC-8183 deployment (2026-04-28)
const AGENT_REGISTRY_ABI = [
  "event AgentMinted(uint256 indexed agentId, address indexed owner, bytes32 capabilityHash, bytes32 profileHash, address agentWallet, uint32 defaultRate)",
  "event CapabilityUpdated(uint256 indexed agentId, bytes32 newHash, uint16 newVersion)",
  "function totalAgents() view returns (uint256)",
  "function getAgentProfile(uint256 agentId) view returns (tuple(address owner, uint48 createdAt, uint16 winRate, uint16 version, bool isActive, bytes32 capabilityHash, bytes32 profileHash, address agentWallet, uint64 totalJobsCompleted, uint32 defaultRate, uint64 totalJobsAttempted, uint128 totalEarningsWei, uint48 updatedAt))",
  "function getAgentSkills(uint256 agentId) view returns (bytes32[])",
];

const PROGRESSIVE_ESCROW_ABI = [
  "event JobPosted(uint256 indexed jobId, address indexed client, bytes32 skillId, bytes32 jobDataHash)",
  "event ProposalAccepted(uint256 indexed jobId, uint256 proposalIndex, uint256 agentId, uint96 budgetWei)",
  "event MilestoneDefined(uint256 indexed jobId, uint8 milestoneCount)",
  "function submitProposal(uint256 jobId, uint256 agentId, uint96 proposedRateWei, bytes32 descriptionHash) external",
  "function getJob(uint256 jobId) view returns (tuple(address client, uint64 agentId, uint8 status, uint8 milestoneCount, address agentWallet, uint96 totalBudgetWei, uint96 releasedWei, uint64 createdAt, bytes32 skillId, bytes32 jobDataHash))",
];

const SUBSCRIPTION_ESCROW_ABI = [
  "function totalSubscriptions() view returns (uint256)",
  "function drainPerCheckIn(uint256 subId) external",
  "function drainPerAlert(uint256 subId, bytes alertData) external",
  "function updateInterval(uint256 subId, uint32 newInterval) external",
  "function proposeInterval(uint256 subId, uint32 suggestedInterval) external",
  "function subscriptionTaskHash(uint256 subId) view returns (bytes32)",
  "function getSubscription(uint256 subId) view returns (tuple(address client, uint64 agentId, uint8 status, uint8 intervalMode, uint8 x402VerificationMode, bool x402Enabled, address agentWallet, uint64 lastCheckIn, uint32 intervalSeconds, uint96 checkInRate, uint96 alertRate, uint64 createdAt, uint128 balance, uint128 totalDrained, uint64 pausedAt, uint64 gracePeriodEnds, uint32 gracePeriodSeconds, uint32 proposedInterval))",
  "event SubscriptionCreated(uint256 indexed subscriptionId, uint256 indexed agentId, address indexed client, uint128 budget, bytes32 taskHash)",
  "event SubscriptionPaused(uint256 indexed subscriptionId, bytes32 reason)",
  "event SubscriptionCancelled(uint256 indexed subscriptionId, bytes32 reason, uint128 refund)",
  "event CheckInDrained(uint256 indexed subscriptionId, uint256 indexed agentId, uint96 amount, uint64 timestamp)",
  "event AlertFired(uint256 indexed subscriptionId, uint256 indexed agentId, uint64 timestamp, bytes alertData, uint96 amountDrained)",
  "event IntervalUpdated(uint256 indexed subscriptionId, uint32 newInterval)",
];

// Subscription tick activity gets logged into the `agent_activity` table the same
// way job-phase events do. Job IDs and subscription IDs are independent number
// spaces (different contracts), so we offset subscription rows by +1B to keep
// JobChat's per-job views from accidentally showing subscription ticks.
// PG `integer` max is ~2.147B, so this is safe.
const SUBSCRIPTION_ACTIVITY_OFFSET = 1_000_000_000;

/** Fetch the off-chain subscription task description by its on-chain hash from Supabase */
async function fetchSubscriptionTaskByHash(taskHash) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey || !taskHash) return null;
  try {
    const res = await fetch(
      `${sbUrl}/rest/v1/subscription_tasks?task_hash=eq.${taskHash.toLowerCase()}&select=task_description,webhook_url,metadata`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Fetch capability manifest for an agent from Supabase agent_profiles */
async function fetchManifestFromSupabase(agentId) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) return null;
  try {
    const res = await fetch(
      `${sbUrl}/rest/v1/agent_profiles?agent_id=eq.${agentId}&select=metadata`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.metadata ?? null;
  } catch {
    return null;
  }
}

export class PlatformDispatcher {
  constructor({ wallet, rpcUrl, registryAddress, escrowAddress, subscriptionEscrowAddress, managedAgentIds, agentWalletKeys }) {
    this.wallet = wallet;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.registryAddress = registryAddress;
    this.escrowAddress = escrowAddress;
    this.subscriptionEscrowAddress = subscriptionEscrowAddress || escrowAddress;

    // Per-agent wallet signers — map<agentId, Wallet>. Used when calling releaseMilestone
    // since the contract requires msg.sender == job.agentWallet.
    this.agentWallets = new Map();
    if (agentWalletKeys) {
      for (const [agentId, key] of Object.entries(agentWalletKeys)) {
        const normalizedKey = key.startsWith("0x") ? key : `0x${key}`;
        this.agentWallets.set(String(agentId), new ethers.Wallet(normalizedKey, this.provider));
      }
    }

    // Track managed agents — starts from env or pre-configured list
    this.managedAgentIds = new Set();
    if (managedAgentIds) {
      managedAgentIds.forEach(id => this.managedAgentIds.add(id.toString()));
    }

    // Track which agents we've already loaded configs for
    this.agentConfigs = new Map();

    // Services
    this.storage = new StorageService(wallet);
    this.alertDelivery = new AlertDelivery({
      wallet,
      escrowAddress: this.subscriptionEscrowAddress,
      storageService: this.storage,
    });
    this.scheduler = new AgentScheduler({
      alertDelivery: this.alertDelivery,
      storageService: this.storage,
    });

    // Auto-discovery config
    this._registryContract = null;
    this._scanInterval = null;

    // Per-subscription customer service bots (keyed by "sub-{id}")
    this.customerServiceBots = new Map();
    // Tracks bot tokens already running — prevents 409 when multiple subs share one token
    this._runningBotTokens = new Set();
    // Block-polling event watchers (replace ethers .on() filters which 0G RPC drops)
    this._eventWatchers = [];
  }

  /**
   * Starts the dispatcher.
   * 1. Loads pre-configured agent configs (from PLATFORM_AGENT_IDS env).
   * 2. Scans the registry for ALL platform-managed agents (auto-discovery).
   * 3. Starts listening to blockchain events (jobs + new agent minting).
   */
  async start() {
    console.log("[PlatformDispatcher] Starting Platform Dispatcher (Path B)...");

    const registryContract = new ethers.Contract(this.registryAddress, AGENT_REGISTRY_ABI, this.provider);
    this._registryContract = registryContract;

    // Phase 1: Load pre-configured agents (from env)
    if (this.managedAgentIds.size > 0) {
      console.log(`[PlatformDispatcher] Pre-configured agents: ${Array.from(this.managedAgentIds).join(", ")}`);
      await this._loadAllAgentConfigs();
    }

    // Phase 2: Auto-discovery — scan the entire registry for platform-managed agents
    console.log("[PlatformDispatcher] Scanning AgentRegistry for platform-managed agents...");
    const discovered = await this._scanRegistry();
    if (discovered.length > 0) {
      console.log(`[PlatformDispatcher] Discovered ${discovered.length} new platform-managed agent(s): ${discovered.join(", ")}`);
      await this._loadAgentConfigs(discovered);
    }

    // Phase 3: Start periodic scanning (every 60s) to catch agents minted while offline
    this._scanInterval = setInterval(async () => {
      try {
        const newAgents = await this._scanRegistry();
        if (newAgents.length > 0) {
          console.log(`[PlatformDispatcher] Auto-discovered ${newAgents.length} new agent(s): ${newAgents.join(", ")}`);
          await this._loadAgentConfigs(newAgents);
        }
      } catch (err) {
        console.log(`[PlatformDispatcher] Periodic scan error: ${err.message}`);
      }
    }, 60_000);

    // ── Phase 4–6: Block-polling watchers (replaces ethers `.on()` filter
    //              listeners which 0G Newton RPC drops after a short window).
    //              Each watcher polls eth_getLogs with a tracked block range,
    //              so dropped filters can never spam "filter not found".

    const reg = (eventName, handler) => {
      const w = new EventWatcher(registryContract, eventName, handler, { label: `[Event ${eventName}]` });
      this._eventWatchers.push(w);
      return w.start();
    };

    await reg("AgentMinted", async (agentId, owner, capabilityHash) => {
      const agentIdStr = agentId.toString();
      console.log(`[Event] AgentMinted #${agentIdStr} | Owner: ${String(owner).slice(0, 10)}... | Hash: ${String(capabilityHash).slice(0, 10)}...`);
      if (this.managedAgentIds.has(agentIdStr)) {
        await this._loadAgentConfigs([agentIdStr]);
      }
    });

    await reg("CapabilityUpdated", async (agentId, _newHash, newVersion) => {
      const agentIdStr = agentId.toString();
      if (this.managedAgentIds.has(agentIdStr)) {
        console.log(`[Auto-Reload] Agent #${agentIdStr} capability updated (v${newVersion}). Reloading config...`);
        await this._loadAgentConfigs([agentIdStr]);
      }
    });

    // Phase 6: Setup contract listeners for jobs and subscriptions
    const escrowContract = new ethers.Contract(this.escrowAddress, PROGRESSIVE_ESCROW_ABI, this.provider);

    const onEscrow = (eventName, handler) => {
      const w = new EventWatcher(escrowContract, eventName, handler, { label: `[Event ${eventName}]` });
      this._eventWatchers.push(w);
      return w.start();
    };

    await onEscrow("ProposalAccepted", async (jobId, _proposalIndex, agentId, budgetWei) => {
      const agentIdStr = agentId.toString();
      if (this.managedAgentIds.has(agentIdStr)) {
        console.log(`[Event] ProposalAccepted | Job ${jobId} → Agent ${agentIdStr} | Budget: ${ethers.formatEther(budgetWei)} OG`);
        await this._onJobCreated(jobId, agentId);
      }
    });

    await onEscrow("MilestoneDefined", async (jobId) => {
      await this._onMilestoneDefined(jobId);
    });

    // ── SubscriptionEscrow events ──────────────────────────────────────────
    const subContract = new ethers.Contract(
      this.subscriptionEscrowAddress,
      SUBSCRIPTION_ESCROW_ABI,
      this.wallet
    );

    await this.alertDelivery.initialize(subContract);

    const onSub = (eventName, handler) => {
      const w = new EventWatcher(subContract, eventName, handler, { label: `[Event ${eventName}]` });
      this._eventWatchers.push(w);
      return w.start();
    };

    await onSub("SubscriptionCreated", async (subscriptionId, agentId, _client, budget) => {
      await this._onSubscriptionCreated(subscriptionId, agentId, budget, subContract);
    });

    await onSub("SubscriptionPaused", async (subscriptionId, reason) => {
      console.log(`[PlatformDispatcher] SubscriptionPaused #${subscriptionId} | ${reason}`);
      await this.alertDelivery.sendBalanceLow(subscriptionId.toString(), "platform", 0, 0);
    });

    await onSub("SubscriptionCancelled", async (subscriptionId, reason, refund) => {
      console.log(`[PlatformDispatcher] SubscriptionCancelled #${subscriptionId} | ${reason} | Refund: ${ethers.formatEther(refund)} OG`);
      await this.scheduler.cancelJob(`sub-${subscriptionId}`);
      // Stop customer service bot for this subscription if running
      const key = `sub-${subscriptionId}`;
      const bot = this.customerServiceBots.get(key);
      if (bot) {
        await bot.stop().catch(() => {});
        this.customerServiceBots.delete(key);
        console.log(`[PlatformDispatcher] Customer service bot stopped for cancelled Subscription #${subscriptionId}`);
      }
    });

    console.log(`[PlatformDispatcher] Managing ${this.managedAgentIds.size} agent(s): ${Array.from(this.managedAgentIds).join(", ")}`);
    console.log(`[PlatformDispatcher] Listening for events on ProgressiveEscrow + SubscriptionEscrow...`);
    console.log(`[PlatformDispatcher] Auto-discovery: scanning for new AgentMinted events every 60s\n`);

    // Start auto-persist for scheduler state
    this.scheduler.startAutoPersist();

    // Recover existing subscriptions from on-chain
    await this._recoverSubscriptions();
  }

  /**
   * Scans the entire AgentRegistry for platform-managed agents.
   * Returns array of agent IDs that are platform-managed but not yet in managedAgentIds.
   */
  async _scanRegistry() {
    if (!this._registryContract) return [];

    let totalAgents;
    try {
      totalAgents = Number(await this._registryContract.totalAgents());
    } catch {
      console.log("[PlatformDispatcher] Could not read totalAgents.");
      return [];
    }

    if (totalAgents === 0) return [];

    const newAgents = [];

    // ERC-7857: no capabilityCID on-chain — auto-discovery checks Supabase agent_profiles
    for (let i = 1; i <= totalAgents; i++) {
      const agentIdStr = i.toString();
      if (this.managedAgentIds.has(agentIdStr)) continue;

      try {
        const metadata = await fetchManifestFromSupabase(i);
        if (metadata?.platformManaged === true) {
          newAgents.push(agentIdStr);
        }
      } catch (err) {
        // skip
      }
    }

    return newAgents;
  }

  /**
   * Loads and validates capability manifests for the given agent IDs.
   */
  async _loadAgentConfigs(agentIds) {
    for (const agentId of agentIds) {
      try {
        await this._loadAgentConfig(agentId);
      } catch (error) {
        console.error(`[PlatformDispatcher] Failed to load config for Agent ${agentId}:`, error.message);
      }
    }
  }

  /**
   * Legacy method — loads configs for pre-configured agent IDs (PLATFORM_AGENT_IDS env).
   * Now delegates to _loadAgentConfigs.
   */
  async _loadAllAgentConfigs() {
    await this._loadAgentConfigs(Array.from(this.managedAgentIds));
  }

  /**
   * Recovers existing subscriptions from SubscriptionEscrow on startup.
   * Re-schedules all active subscriptions for managed agents.
   */
  async _recoverSubscriptions() {
    console.log("[PlatformDispatcher] Recovering existing subscriptions...");

    const subContract = new ethers.Contract(
      this.subscriptionEscrowAddress,
      SUBSCRIPTION_ESCROW_ABI,
      this.provider
    );

    try {
      const total = await subContract.totalSubscriptions();
      console.log(`[PlatformDispatcher] Found ${total} total subscriptions on-chain`);

      let recovered = 0;

      for (let i = 1; i <= Number(total); i++) {
        try {
          const sub = await subContract.getSubscription(i);
          const subAgentId = Number(sub.agentId);
          const subAgentIdStr = subAgentId.toString();

          if (!this.managedAgentIds.has(subAgentIdStr)) continue;
          if (Number(sub.status) === 3) continue;

          const intervalSeconds = Number(sub.intervalSeconds);
          const cronExpr = this._intervalToCron(intervalSeconds);
          if (!cronExpr) {
            console.warn(`[PlatformDispatcher] Unsupported interval for sub ${i}: ${intervalSeconds}s`);
            continue;
          }

          // Resolve agent's signer for on-chain drains (must equal agentWallet)
          const agentSigner = this._resolveAgentSigner(subAgentIdStr);
          if (!agentSigner) {
            console.warn(`[PlatformDispatcher] No signer for Agent ${subAgentIdStr} — sub ${i} won't be able to drain`);
          }

          this.scheduler.scheduleJob(
            `sub-${i}`,
            cronExpr,
            async (checkpoint) => this._runSubscriptionTick(i, subAgentIdStr, agentSigner, checkpoint),
            {
              subscriptionId: i.toString(),
              agentId: subAgentIdStr,
            }
          );

          recovered++;
          console.log(`[PlatformDispatcher] Recovered subscription ${i} (${cronExpr})`);

          // Start client customer service bot if configured
          await this._startClientBotForSubscription(i, subAgentIdStr);
        } catch (err) {
          console.warn(`[PlatformDispatcher] Failed to recover subscription ${i}: ${err.message?.slice(0, 80)}`);
        }
      }

      console.log(`[PlatformDispatcher] Recovery complete. Recovered ${recovered} subscription(s).`);
    } catch (err) {
      console.error(`[PlatformDispatcher] Failed to scan subscriptions: ${err.message}`);
    }
  }

  /**
   * Convert interval seconds to cron expression.
   */
  _intervalToCron(intervalSeconds) {
    if (intervalSeconds === 0 || intervalSeconds === 0n) return null;
    if (intervalSeconds === BigInt(2) ** BigInt(256) - BigInt(1)) return "*/5 * * * *";

    const interval = Number(intervalSeconds);
    if (interval === 60) return "* * * * *";
    if (interval === 300) return "*/5 * * * *";
    if (interval === 600) return "*/10 * * * *";
    if (interval === 900) return "*/15 * * * *";
    if (interval === 1800) return "*/30 * * * *";
    if (interval === 3600) return "0 * * * *";
    if (interval === 7200) return "0 */2 * * *";
    if (interval === 14400) return "0 */4 * * *";
    if (interval === 28800) return "0 */8 * * *";
    if (interval === 43200) return "0 */12 * * *";
    if (interval === 86400) return "0 0 * * *";
    if (interval < 60) return "* * * * *";
    if (interval < 300) return "*/5 * * * *";
    if (interval < 900) return "*/15 * * * *";
    return "*/5 * * * *";
  }

  /**
   * Execute a subscription job.
   */
  async _executeSubscriptionJob(subscriptionId, subscription, checkpoint) {
    return {
      type: "subscription_execution",
      subscriptionId: subscriptionId.toString(),
      taskHash: subscription.taskHash,
      timestamp: Date.now(),
    };
  }

  /**
   * Loads a single agent config.
   */
  async _loadAgentConfig(agentId) {
    console.log(`[PlatformDispatcher] Loading config for Agent ${agentId}...`);

    await this._registryContract.getAgentProfile(agentId); // verify agent exists on-chain

    // ERC-7857: no capabilityCID on-chain — fetch manifest from Supabase agent_profiles.metadata
    let manifest = await fetchManifestFromSupabase(agentId);
    if (!manifest) {
      console.warn(`[PlatformDispatcher] Agent ${agentId} has no metadata in Supabase. Using empty config.`);
      manifest = { platformConfig: {}, tools: [], prebuiltSkills: [], skillConfigs: {} };
    } else {
      console.log(`[PlatformDispatcher] Agent ${agentId} manifest loaded from Supabase.`);
    }

    // Validate manifest
    const validation = validateCapabilityManifest(manifest);
    if (!validation.valid) {
      console.error(`[PlatformDispatcher] Agent ${agentId} manifest invalid:`, validation.errors);
      return;
    }

    // Cache config
    manifest.agentId = agentId.toString();
    this.agentConfigs.set(agentId.toString(), manifest);
    this.managedAgentIds.add(agentId.toString());
    console.log(`[PlatformDispatcher] Agent ${agentId} config loaded successfully.`);
    console.log(`[PlatformDispatcher]   Provider: ${manifest.platformConfig?.llmProvider || "unknown"}`);
    console.log(`[PlatformDispatcher]   Model:    ${manifest.platformConfig?.model || manifest.model || "unknown"}`);

  }

  /**
   * Fetches a client's bot token from Supabase client_bot_configs and starts a
   * CustomerServiceBot for that specific subscription.
   * Keyed by "sub-{subscriptionId}" — one bot per client subscription.
   */
  async _startClientBotForSubscription(subscriptionId, agentIdStr) {
    const key = `sub-${subscriptionId}`;
    if (this.customerServiceBots.has(key)) return; // already running

    const supabaseUrl     = process.env.SUPABASE_URL;
    // client_bot_configs has RLS with no public policies — must use service role key
    const supabaseKey     = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    console.log(`[CS Bot] Checking sub #${subscriptionId} — supabaseUrl=${!!supabaseUrl} serviceKey=${!!process.env.SUPABASE_SERVICE_ROLE_KEY} anonKey=${!!process.env.SUPABASE_ANON_KEY}`);
    if (!supabaseUrl || !supabaseKey) {
      console.warn(`[CS Bot] Sub #${subscriptionId}: missing SUPABASE_URL or key — skipping`);
      return;
    }

    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/client_bot_configs?subscription_id=eq.${subscriptionId}&select=bot_token,allowed_chats`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
      );
      console.log(`[CS Bot] Sub #${subscriptionId}: Supabase response status=${res.status}`);
      if (!res.ok) {
        console.warn(`[CS Bot] Sub #${subscriptionId}: Supabase error ${res.status} — ${await res.text()}`);
        return;
      }
      const rows = await res.json();
      console.log(`[CS Bot] Sub #${subscriptionId}: rows found=${rows?.length ?? 0}`);
      if (!rows?.length || !rows[0].bot_token) {
        console.log(`[CS Bot] Sub #${subscriptionId}: no bot token configured — skipping`);
        return;
      }

      const { bot_token: botToken, allowed_chats: allowedChats = [] } = rows[0];

      // Deduplicate — one polling connection per token (Telegram 409 otherwise)
      if (this._runningBotTokens.has(botToken)) {
        console.log(`[CS Bot] Sub #${subscriptionId}: bot token already polling (shared across subs) — skipping duplicate`);
        return;
      }

      const agentConfig = this.agentConfigs.get(agentIdStr) || {};
      const extendedCompute = new ExtendedComputeService(this.wallet, {
        provider: agentConfig.platformConfig?.llmProvider || "0g-compute",
        systemPrompt: agentConfig.platformConfig?.systemPrompt || "You are a helpful customer service assistant.",
      });

      const memoryService = new MemoryService(agentIdStr, extendedCompute, this.storage);

      const bot = new CustomerServiceBot({
        botToken,
        allowedChats,
        extendedCompute,
        memoryService,
        storageService: this.storage,
        // Pass the agent's actual tools and skills so the CS Bot behaves like the real agent
        agentId:        agentIdStr,
        customTools:    agentConfig.tools           || [],
        prebuiltSkills: agentConfig.prebuiltSkills  || [],
        skillConfigs:   agentConfig.skillConfigs    || {},
        systemPrompt:   agentConfig.platformConfig?.systemPrompt || null,
      });

      await bot.start();
      this.customerServiceBots.set(key, bot);
      this._runningBotTokens.add(botToken);
      console.log(`[PlatformDispatcher] Client customer service bot started for Subscription #${subscriptionId} (Agent ${agentIdStr})`);
    } catch (err) {
      console.error(`[PlatformDispatcher] Failed to start client bot for Subscription #${subscriptionId}:`, err.message);
    }
  }

  /**
   * Gracefully shuts down all customer service bots.
   * Call on SIGTERM/SIGINT.
   */
  async stop() {
    console.log("[PlatformDispatcher] Stopping event watchers...");
    for (const w of this._eventWatchers) {
      try { w.stop(); } catch { /* swallow */ }
    }
    this._eventWatchers = [];

    console.log("[PlatformDispatcher] Stopping customer service bots...");
    for (const [agentId, bot] of this.customerServiceBots) {
      try {
        await bot.stop();
        console.log(`[PlatformDispatcher] Customer service bot stopped for Agent ${agentId}`);
      } catch (err) {
        console.error(`[PlatformDispatcher] Error stopping bot for Agent ${agentId}:`, err.message);
      }
    }
    this.customerServiceBots.clear();

    if (this._scanInterval) {
      clearInterval(this._scanInterval);
      this._scanInterval = null;
    }

    this.scheduler.stopAutoPersist();
  }

  /**
   * Handles JobCreated event.
   * Checks if the job is for a managed agent.
   */
  async _onJobCreated(jobId, agentId) {
    const agentIdStr = agentId.toString();
    if (this.managedAgentIds.has(agentIdStr)) {
      console.log(`[PlatformDispatcher] Job ${jobId} created for managed Agent ${agentIdStr}. Waiting for milestones...`);
    }
  }

  /**
   * Handles MilestoneDefined event.
   * Triggers job processing.
   */
  async _onMilestoneDefined(jobId) {
    try {
      const escrowContract = new ethers.Contract(this.escrowAddress, PROGRESSIVE_ESCROW_ABI, this.provider);
      const job = await escrowContract.getJob(jobId);
      
      const agentIdStr = job[1].toString(); // agentId at index 1 in ERC-8183 struct

      if (this.managedAgentIds.has(agentIdStr)) {
        console.log(`[PlatformDispatcher] Milestones defined for Job ${jobId} (Agent ${agentIdStr}). Routing job...`);
        await this.routeJob(jobId, job, agentIdStr);
      }
    } catch (error) {
      console.error(`[PlatformDispatcher] Error handling MilestoneDefined for Job ${jobId}:`, error.message);
    }
  }

  /**
   * Handles SubscriptionCreated event — schedules recurring check-ins.
   * The scheduled callback runs the FULL autonomous loop:
   *   fetch task → LLM observation → on-chain drain (check-in or alert) → optional interval update.
   */
  async _onSubscriptionCreated(subscriptionId, agentId, budget, subContract) {
    const agentIdStr = agentId.toString();
    if (!this.managedAgentIds.has(agentIdStr)) return;

    console.log(`[PlatformDispatcher] SubscriptionCreated #${subscriptionId} | Agent ${agentIdStr} | Budget: ${ethers.formatEther(budget)} OG`);

    try {
      const subscription = await subContract.getSubscription(subscriptionId);
      const cronExpr = this._intervalToCron(subscription.intervalSeconds);
      if (!cronExpr) {
        console.warn(`[PlatformDispatcher] Could not convert interval to cron for sub #${subscriptionId}`);
        return;
      }

      // Resolve agent's signer once — must match agentWallet for drain calls
      const agentSigner = this._resolveAgentSigner(agentIdStr);
      if (!agentSigner) {
        console.error(`[PlatformDispatcher] No signer for Agent ${agentIdStr} — sub #${subscriptionId} cannot drain. Set AGENT_WALLET_KEYS.`);
      }

      await this.scheduler.scheduleJob(
        `sub-${subscriptionId}`,
        cronExpr,
        async (checkpoint) => this._runSubscriptionTick(subscriptionId, agentIdStr, agentSigner, checkpoint),
        { subscriptionId: subscriptionId.toString(), agentId: agentIdStr }
      );

      console.log(`[PlatformDispatcher] Subscription #${subscriptionId} scheduled (${cronExpr})`);
      await this._startClientBotForSubscription(subscriptionId.toString(), agentIdStr);
    } catch (err) {
      console.error(`[PlatformDispatcher] Failed to schedule subscription #${subscriptionId}:`, err.message);
    }
  }

  /**
   * Resolve the per-agent signer (Wallet) for on-chain calls that require
   * msg.sender == agentWallet (drainPerCheckIn, drainPerAlert, updateInterval).
   */
  _resolveAgentSigner(agentIdStr) {
    let signer = this.agentWallets.get(agentIdStr);
    if (!signer && process.env.AGENT_PRIVATE_KEY) {
      const k = process.env.AGENT_PRIVATE_KEY.startsWith("0x")
        ? process.env.AGENT_PRIVATE_KEY
        : `0x${process.env.AGENT_PRIVATE_KEY}`;
      signer = new ethers.Wallet(k, this.provider);
    }
    return signer || null;
  }

  /**
   * One tick of the autonomous monitoring loop for a subscription.
   * Returns a checkpoint that the scheduler persists for the next tick.
   */
  async _runSubscriptionTick(subscriptionId, agentIdStr, agentSigner, checkpoint) {
    const subEscrow = new ethers.Contract(this.subscriptionEscrowAddress, SUBSCRIPTION_ESCROW_ABI, this.provider);
    const config = this.agentConfigs.get(agentIdStr) || {};
    const subIdStr = subscriptionId.toString();
    const agentWallet = agentSigner?.address || config.agentWallet || null;

    // Refresh on-chain state — interval, status, balance may have changed since scheduling
    let sub;
    try {
      sub = await subEscrow.getSubscription(subscriptionId);
    } catch (err) {
      console.error(`[Sub #${subscriptionId}] getSubscription failed: ${err.message?.slice(0, 80)}`);
      return { error: err.message, skipped: true };
    }

    const status = Number(sub.status);
    if (status !== 1 /* ACTIVE */) {
      console.log(`[Sub #${subscriptionId}] status=${status} (not ACTIVE), skipping tick`);
      return { skipped: true, status };
    }

    // Activity log entry — visible in subscription detail "Agent Activity" panel.
    // job_id stored as the subscription id for now; the AgentActivityByWallet
    // component filters purely by agent_wallet so this lands in the right view.
    await logActivity({
      jobId: SUBSCRIPTION_ACTIVITY_OFFSET + Number(subIdStr),
      agentId: agentIdStr,
      agentWallet,
      phase: "processing",
      message: `Subscription tick — checking task for sub #${subIdStr}`,
      metadata: { source: "subscription", intervalSeconds: Number(sub.intervalSeconds) },
    });

    const taskHash = await subEscrow.subscriptionTaskHash(subscriptionId).catch(() => null);
    const observation = await this._executeMonitoringTask(subscriptionId, taskHash, sub, config, checkpoint, agentSigner);

    // ── Decide on-chain action ─────────────────────────────────────────────
    let onChainAction = null;

    if (observation.anomalyDetected && Number(sub.alertRate) > 0n) {
      onChainAction = await this._drainAlertOnChain(
        subscriptionId,
        { type: "anomaly", reason: observation.alertReason || "agent-detected anomaly", severity: observation.severity || 0 },
        agentSigner
      );
      onChainAction.kind = "alert";
      console.log(`[Sub #${subscriptionId}] ALERT drained: ${observation.alertReason} (sev=${observation.severity}) — tx=${onChainAction.hash || onChainAction.reason}`);
      await logActivity({
        jobId: SUBSCRIPTION_ACTIVITY_OFFSET + Number(subIdStr),
        agentId: agentIdStr,
        agentWallet,
        phase: onChainAction.ok ? "completed" : "error",
        message: onChainAction.ok
          ? `Alert drained: ${observation.alertReason} (severity ${observation.severity})`
          : `Alert drain failed: ${onChainAction.reason}`,
        metadata: {
          source: "subscription",
          drainKind: "alert",
          txHash: onChainAction.hash,
          reason: observation.alertReason,
          severity: observation.severity,
        },
      });
    } else if (Number(sub.checkInRate) > 0n) {
      onChainAction = await this._drainCheckInOnChain(subscriptionId, agentSigner);
      onChainAction.kind = "checkin";
      if (onChainAction.ok) {
        console.log(`[Sub #${subscriptionId}] CHECK-IN drained — tx=${onChainAction.hash}`);
      } else {
        console.log(`[Sub #${subscriptionId}] check-in skipped: ${onChainAction.reason}`);
      }
      await logActivity({
        jobId: SUBSCRIPTION_ACTIVITY_OFFSET + Number(subIdStr),
        agentId: agentIdStr,
        agentWallet,
        phase: onChainAction.ok ? "completed" : (onChainAction.reason?.includes("TooEarly") ? "processing" : "error"),
        message: onChainAction.ok
          ? `Check-in drained successfully`
          : `Check-in skipped: ${onChainAction.reason}`,
        metadata: {
          source: "subscription",
          drainKind: "checkin",
          txHash: onChainAction.hash,
          observation: observation.observation?.slice(0, 200),
        },
      });
    }

    // ── Mode C — agent dynamically adjusts interval ────────────────────────
    const intervalMode = Number(sub.intervalMode);
    const currentInterval = Number(sub.intervalSeconds);
    const suggested = Number(observation.suggestedIntervalSeconds || 0);
    if (intervalMode === 2 /* AGENT_AUTO */ && suggested > 0
        && Math.abs(suggested - currentInterval) >= 60
        && suggested >= 60 && suggested <= 86400 * 7) {
      const upd = await this._updateIntervalOnChain(subscriptionId, suggested, agentSigner);
      console.log(`[Sub #${subscriptionId}] Mode C interval update ${currentInterval}s → ${suggested}s — ${upd.ok ? "OK" : upd.reason}`);
      onChainAction = { ...(onChainAction || {}), intervalUpdate: upd };
    }

    // ── Webhook push (if configured) ───────────────────────────────────────
    if (observation.webhookUrl) {
      this._postWebhook(observation.webhookUrl, {
        subscriptionId: subscriptionId.toString(),
        agentId: agentIdStr,
        observation: observation.observation,
        anomalyDetected: observation.anomalyDetected,
        timestamp: Date.now(),
      });
    }

    return {
      ...observation,
      onChainAction,
      lastTickAt: Date.now(),
    };
  }

  /**
   * Real autonomous monitoring task — runs the LLM with the client's task description
   * and returns a structured observation that drives on-chain action.
   *
   * The agent makes goal-based decisions: it reads the task, optionally fetches
   * external data (URL embedded in task), then asks the LLM to classify the
   * observation as either routine (drainPerCheckIn) or anomalous (drainPerAlert),
   * and to suggest the next polling interval (Mode C).
   */
  async _executeMonitoringTask(subscriptionId, taskHash, sub, config, checkpoint, agentSigner) {
    const taskRow = taskHash ? await fetchSubscriptionTaskByHash(taskHash) : null;
    const taskDescription = taskRow?.task_description
      || `(no off-chain task description for hash ${taskHash}; running generic check)`;
    const webhookUrl = taskRow?.webhook_url || null;

    // Try to extract a URL from the task — if present, fetch its current state for the LLM to analyze
    let fetchedData = null;
    let fetchedUrl = null;
    const urlMatch = String(taskDescription).match(/https?:\/\/[^\s)]+/);
    if (urlMatch) {
      fetchedUrl = urlMatch[0];
      try {
        const r = await fetch(fetchedUrl, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
        const text = (await r.text()).slice(0, 4000);
        fetchedData = `HTTP ${r.status} from ${fetchedUrl}\n\n${text}`;
      } catch (err) {
        fetchedData = `(fetch ${fetchedUrl} failed: ${err.message})`;
      }
    }

    // ── Execute the agent's full toolkit (custom tools + MCPs + pre-built skills) ──
    // Same arsenal that's available during job processing. The brief is built from the
    // task description so tools that depend on it (web_search, market_analysis,
    // chart_patterns, code_exec, MCPs) can do their work.
    const customTools     = config.tools          || [];
    const prebuiltSkills  = config.prebuiltSkills || [];
    let toolContext = "";
    if (customTools.length > 0 || prebuiltSkills.length > 0) {
      try {
        const subBrief = {
          title: `Subscription tick #${subscriptionId}`,
          description: taskDescription,
          context: { lastCheckpoint: checkpoint?.lastResult || null, fetchedUrl, fetchedData: fetchedData?.slice(0, 1500) },
        };
        toolContext = await executeForJob(subBrief, customTools, prebuiltSkills, config.agentId);
        console.log(`[Sub #${subscriptionId}] Tools executed — ${customTools.length} custom + ${prebuiltSkills.length} skill(s); context ${toolContext.length} chars`);
      } catch (err) {
        console.log(`[Sub #${subscriptionId}] Tool execution failed: ${err.message?.slice(0, 100)}`);
      }
    }

    const compute = new ExtendedComputeService(agentSigner || this.wallet, {
      provider: config.platformConfig?.llmProvider || "0g-compute",
      model:    config.platformConfig?.model,
      systemPrompt: config.platformConfig?.systemPrompt || "You are an autonomous monitoring agent on the zer0Gig platform. You have access to tools — use their results to inform your decision.",
    });

    const toolsList = [
      ...customTools.map(t => `${t.name || t.type} (${t.type})`),
      ...prebuiltSkills,
    ];
    const decisionPrompt = `You are an autonomous monitoring agent. Your job is to perform recurring checks for a client.

CLIENT'S TASK:
${taskDescription}

OBSERVED DATA THIS TICK (raw URL fetch):
${fetchedData ?? "(no URL detected in task — base your assessment on the task description and tools)"}

YOUR TOOLS / SKILLS (${toolsList.length}): ${toolsList.length ? toolsList.join(", ") : "(none configured)"}

TOOL EXECUTION RESULTS THIS TICK:
${toolContext || "(no tool output)"}

LAST CHECKPOINT (your previous run):
${JSON.stringify(checkpoint?.lastResult || null, null, 2)}

CURRENT INTERVAL: ${Number(sub.intervalSeconds)} seconds

Respond with STRICT JSON ONLY (no markdown fences, no prose):
{
  "observation": "<1-2 sentence summary of what you found, drawing on tool output if available>",
  "anomalyDetected": <true if this requires immediate client attention, otherwise false>,
  "alertReason": "<short reason if anomalyDetected=true, else empty string>",
  "severity": <0-100 integer, higher = more urgent>,
  "suggestedIntervalSeconds": <recommended next interval; keep current if no change needed>
}`;

    let llmResult;
    try {
      llmResult = await compute.processTask(decisionPrompt, "", "");
    } catch (err) {
      return { observation: `LLM failure: ${err.message?.slice(0, 100)}`, anomalyDetected: false, fetchedUrl, webhookUrl };
    }

    // Parse JSON — LLM may wrap in code fences or include extra text
    let parsed = null;
    try {
      const jsonMatch = String(llmResult.content).match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {/* parsed stays null */}

    if (!parsed || typeof parsed.observation !== "string") {
      return {
        observation: String(llmResult.content || "").slice(0, 200),
        anomalyDetected: false,
        fetchedUrl, webhookUrl,
        model: llmResult.model, provider: llmResult.provider,
      };
    }

    return {
      observation:               String(parsed.observation),
      anomalyDetected:           !!parsed.anomalyDetected,
      alertReason:               String(parsed.alertReason || ""),
      severity:                  Number(parsed.severity) || 0,
      suggestedIntervalSeconds:  Number(parsed.suggestedIntervalSeconds) || 0,
      fetchedUrl,
      webhookUrl,
      model:                     llmResult.model,
      provider:                  llmResult.provider,
    };
  }

  /**
   * Call drainPerCheckIn on-chain. Contract enforces TooEarly via lastCheckIn + intervalSeconds.
   */
  async _drainCheckInOnChain(subId, agentSigner) {
    if (!agentSigner) return { ok: false, reason: "no agent signer" };
    const escrow = new ethers.Contract(this.subscriptionEscrowAddress, SUBSCRIPTION_ESCROW_ABI, agentSigner);
    try {
      const tx = await escrow.drainPerCheckIn(subId, { gasLimit: 200_000 });
      const r = await tx.wait();
      return { ok: r.status === 1, hash: r.hash };
    } catch (err) {
      const msg = err.message || "";
      // TooEarly() = 0x085de625, InsufficientBalance(), CheckInDisabled(), NotActive()
      if (msg.includes("TooEarly") || msg.includes("0x085de625")) return { ok: false, reason: "too_early" };
      if (msg.includes("InsufficientBalance")) return { ok: false, reason: "insufficient_balance" };
      return { ok: false, reason: msg.slice(0, 80) };
    }
  }

  /**
   * Call drainPerAlert on-chain with structured alert data.
   */
  async _drainAlertOnChain(subId, alert, agentSigner) {
    if (!agentSigner) return { ok: false, reason: "no agent signer" };
    const escrow = new ethers.Contract(this.subscriptionEscrowAddress, SUBSCRIPTION_ESCROW_ABI, agentSigner);
    try {
      const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint256"],
        [alert.type || "anomaly", alert.reason || "", BigInt(alert.severity || 0)]
      );
      const tx = await escrow.drainPerAlert(subId, encoded, { gasLimit: 250_000 });
      const r = await tx.wait();
      return { ok: r.status === 1, hash: r.hash };
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("AlertsDisabled")) return { ok: false, reason: "alerts_disabled" };
      if (msg.includes("InsufficientBalance")) return { ok: false, reason: "insufficient_balance" };
      return { ok: false, reason: msg.slice(0, 80) };
    }
  }

  /**
   * Mode C — agent dynamically adjusts the polling interval based on observations.
   */
  async _updateIntervalOnChain(subId, newInterval, agentSigner) {
    if (!agentSigner) return { ok: false, reason: "no agent signer" };
    const escrow = new ethers.Contract(this.subscriptionEscrowAddress, SUBSCRIPTION_ESCROW_ABI, agentSigner);
    try {
      const tx = await escrow.updateInterval(subId, Math.floor(newInterval), { gasLimit: 150_000 });
      const r = await tx.wait();
      return { ok: r.status === 1, hash: r.hash, newInterval: Math.floor(newInterval) };
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("NotModeC")) return { ok: false, reason: "not_mode_c" };
      if (msg.includes("InvalidInterval")) return { ok: false, reason: "invalid_interval" };
      return { ok: false, reason: msg.slice(0, 80) };
    }
  }

  /**
   * Best-effort webhook push for client-side notifications. Non-blocking.
   */
  _postWebhook(url, payload) {
    if (!url || !/^https?:\/\//i.test(url)) return;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    }).catch((err) => console.log(`[Webhook] ${url} failed: ${err.message?.slice(0, 80)}`));
  }

  /**
   * Routes a job to a PlatformJobProcessor.
   */
  async routeJob(jobId, job, agentIdStr) {
    let config = this.agentConfigs.get(agentIdStr);

    // Race condition: AgentMinted added agent to managedAgentIds synchronously,
    // but _loadAgentConfig is async — MilestoneDefined may arrive before config is ready.
    // Try loading on demand with a short retry window.
    if (!config) {
      console.log(`[PlatformDispatcher] Config not ready for Agent ${agentIdStr} — loading on demand...`);
      try {
        await this._loadAgentConfig(agentIdStr);
        config = this.agentConfigs.get(agentIdStr);
      } catch (err) {
        console.error(`[PlatformDispatcher] On-demand config load failed for Agent ${agentIdStr}:`, err.message);
      }
    }

    if (!config) {
      console.error(`[PlatformDispatcher] No config found for Agent ${agentIdStr}. Cannot route Job ${jobId}.`);
      return;
    }

    console.log(`[PlatformDispatcher] Routing Job ${jobId} to Agent ${agentIdStr} using provider: ${config.platformConfig?.llmProvider || "0g-compute"}`);

    // Resolve the agent's signer for releaseMilestone. Contract requires msg.sender == job.agentWallet.
    // Lookup order: per-agent map → AGENT_PRIVATE_KEY (single-agent fallback) → platform wallet (will revert).
    let agentSigner = this.agentWallets.get(agentIdStr);
    if (!agentSigner && process.env.AGENT_PRIVATE_KEY) {
      const fallbackKey = process.env.AGENT_PRIVATE_KEY.startsWith("0x")
        ? process.env.AGENT_PRIVATE_KEY
        : `0x${process.env.AGENT_PRIVATE_KEY}`;
      agentSigner = new ethers.Wallet(fallbackKey, this.provider);
      console.log(`[PlatformDispatcher] Using AGENT_PRIVATE_KEY fallback signer for Agent ${agentIdStr}: ${agentSigner.address}`);
    }
    if (!agentSigner) {
      console.error(`[PlatformDispatcher] No agentWallet key for Agent ${agentIdStr} — releaseMilestone WILL revert (NotAgentWallet). Set AGENT_WALLET_KEYS in .env.`);
      agentSigner = this.wallet; // fall back to platform wallet, but it will fail at release time
    }

    // Create processor instance
    const processor = new PlatformJobProcessor({
      wallet: agentSigner,
      computeService: null, // Not used directly, ExtendedComputeService handles it
      storageService: this.storage,
      escrowAddress: this.escrowAddress,
      alignmentVerifierKey: process.env.ALIGNMENT_VERIFIER_KEY || process.env.PLATFORM_PRIVATE_KEY
    }, config);

    // Process the job
    // Small delay to ensure chain state is settled
    setTimeout(async () => {
      try {
        await processor.processJob(jobId);
      } catch (error) {
        console.error(`[PlatformDispatcher] Job ${jobId} processing failed:`, error.message);
      }
    }, 3000);
  }
}
