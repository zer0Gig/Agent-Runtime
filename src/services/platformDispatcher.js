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

// Minimal ABI for listening to events and reading agent profile
const AGENT_REGISTRY_ABI = [
  "event AgentMinted(uint256 indexed agentId, address indexed owner, uint256 defaultRate, address agentWallet, string capabilityCID)",
  "event CapabilitiesUpdated(uint256 indexed agentId, string oldCID, string newCID)",
  "function totalAgents() view returns (uint256)",
  "function getAgentProfile(uint256 agentId) view returns (tuple(address owner, address agentWallet, bytes eciesPublicKey, bytes32 capabilityHash, string capabilityCID, string profileCID, uint256 overallScore, uint256 totalJobsCompleted, uint256 totalJobsAttempted, uint256 totalEarningsWei, uint256 defaultRate, uint256 createdAt, bool isActive))",
];

const PROGRESSIVE_ESCROW_ABI = [
  "event JobCreated(uint256 indexed jobId, address indexed client, uint256 indexed agentId, uint256 totalBudgetWei, string jobDataCID)",
  "event MilestoneDefined(uint256 indexed jobId, uint8 milestoneCount)",
  "function getJob(uint256 jobId) view returns (tuple(uint256 jobId, address client, uint256 agentId, address agentWallet, uint256 totalBudgetWei, uint256 releasedWei, uint8 status, tuple(uint8 percentage, uint256 amountWei, uint8 status, bytes32 criteriaHash, string outputCID, uint256 alignmentScore, uint256 retryCount, uint256 submittedAt, uint256 completedAt)[] milestones, uint256 createdAt, string jobDataCID, bytes32 skillId))",
];

const SUBSCRIPTION_ESCROW_ABI = [
  "function totalSubscriptions() view returns (uint256)",
  "function drainPerCheckIn(uint256 subscriptionId) external",
  "function getSubscription(uint256 subscriptionId) view returns (tuple(uint256 subscriptionId, address client, uint256 agentId, address agentWallet, string taskDescription, uint256 intervalSeconds, uint8 intervalMode, uint256 checkInRate, uint256 alertRate, uint256 balance, uint256 totalDrained, uint8 status, uint256 createdAt, uint256 lastCheckIn, uint256 pausedAt, uint256 gracePeriodEnds, uint256 gracePeriodSeconds, bool x402Enabled, uint8 x402VerificationMode, bytes clientX402Sig, string webhookUrl, uint256 proposedInterval))",
  "event SubscriptionCreated(uint256 indexed subscriptionId, uint256 indexed agentId, address client, uint256 budget)",
  "event SubscriptionPaused(uint256 indexed subscriptionId, string reason)",
  "event SubscriptionCancelled(uint256 indexed subscriptionId, string reason, uint256 refund)",
  "event AlertFired(uint256 indexed subscriptionId, uint256 indexed agentId, uint256 timestamp, bytes alertData, uint256 amountDrained)",
];

/**
 * Check if a capabilityCID indicates a platform-managed agent.
 */
function isPlatformManaged(capabilityCID) {
  if (!capabilityCID) return false;
  return capabilityCID.startsWith("pm:") || capabilityCID.startsWith("sh:");
}

export class PlatformDispatcher {
  constructor({ wallet, rpcUrl, registryAddress, escrowAddress, subscriptionEscrowAddress, managedAgentIds }) {
    this.wallet = wallet;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.registryAddress = registryAddress;
    this.escrowAddress = escrowAddress;
    this.subscriptionEscrowAddress = subscriptionEscrowAddress || escrowAddress;

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

    // Per-agent customer service bots (keyed by agentId string)
    this.customerServiceBots = new Map();
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

    // Phase 4: Listen for real-time AgentMinted events
    registryContract.on("AgentMinted", async (agentId, owner, defaultRate, agentWallet, capabilityCID) => {
      const agentIdStr = agentId.toString();
      console.log(`[Event] AgentMinted #${agentIdStr} | Owner: ${owner.slice(0, 10)}...`);

      if (isPlatformManaged(capabilityCID) && !this.managedAgentIds.has(agentIdStr)) {
        console.log(`[Auto-Discover] New platform-managed agent #${agentIdStr}! Adding...`);
        this.managedAgentIds.add(agentIdStr);
        await this._loadAgentConfigs([agentIdStr]);
      }
    });

    // Phase 5: Listen for capabilityCID updates (agent re-registered as platform-managed)
    registryContract.on("CapabilitiesUpdated", async (agentId, oldCID, newCID) => {
      const agentIdStr = agentId.toString();
      if (isPlatformManaged(newCID) && !this.managedAgentIds.has(agentIdStr)) {
        console.log(`[Auto-Discover] Agent #${agentIdStr} updated to platform-managed! Adding...`);
        this.managedAgentIds.add(agentIdStr);
        await this._loadAgentConfigs([agentIdStr]);
      }
    });

    // Phase 6: Setup contract listeners for jobs and subscriptions
    const escrowContract = new ethers.Contract(this.escrowAddress, PROGRESSIVE_ESCROW_ABI, this.provider);

    // Listen for new jobs
    escrowContract.on("JobCreated", async (jobId, client, agentId, budget, dataCid) => {
      await this._onJobCreated(jobId, agentId);
    });

    // Listen for milestone definitions (trigger processing)
    escrowContract.on("MilestoneDefined", async (jobId, count) => {
      await this._onMilestoneDefined(jobId);
    });

    // ── SubscriptionEscrow events ──────────────────────────────────────────
    const subContract = new ethers.Contract(
      this.subscriptionEscrowAddress,
      SUBSCRIPTION_ESCROW_ABI,
      this.wallet
    );

    await this.alertDelivery.initialize(subContract);

    subContract.on("SubscriptionCreated", async (subscriptionId, agentId, client, budget) => {
      await this._onSubscriptionCreated(subscriptionId, agentId, budget, subContract);
    });

    subContract.on("SubscriptionPaused", async (subscriptionId, reason) => {
      console.log(`[PlatformDispatcher] SubscriptionPaused #${subscriptionId} | ${reason}`);
      await this.alertDelivery.sendBalanceLow(subscriptionId.toString(), "platform", 0, 0);
    });

    subContract.on("SubscriptionCancelled", async (subscriptionId, reason, refund) => {
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

    for (let i = 1; i <= totalAgents; i++) {
      const agentIdStr = i.toString();
      if (this.managedAgentIds.has(agentIdStr)) continue; // already managed

      try {
        const profile = await this._registryContract.getAgentProfile(i);
        const capabilityCID = profile[4]; // capabilityCID is at index 4
        if (isPlatformManaged(capabilityCID)) {
          newAgents.push(agentIdStr);
        }
      } catch (err) {
        // Agent may not exist at this index — skip
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

          this.scheduler.scheduleJob(
            `sub-${i}`,
            cronExpr,
            async (checkpoint) => {
              return await this._executeSubscriptionJob(i, sub, checkpoint);
            },
            {
              subscriptionId: i.toString(),
              agentId: subAgentIdStr,
              taskDescription: sub.taskDescription,
            }
          );

          recovered++;
          console.log(`[PlatformDispatcher] Recovered subscription ${i}: "${sub.taskDescription}" (${cronExpr})`);

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
      taskDescription: subscription.taskDescription,
      timestamp: Date.now(),
    };
  }

  /**
   * Loads a single agent config.
   */
  async _loadAgentConfig(agentId) {
    console.log(`[PlatformDispatcher] Loading config for Agent ${agentId}...`);

    const profile = await this._registryContract.getAgentProfile(agentId);
    const capabilityCID = profile[4]; // capabilityCID is at index 4

    if (!capabilityCID) {
      console.warn(`[PlatformDispatcher] Agent ${agentId} has no capabilityCID. Skipping.`);
      return;
    }

    // Decode manifest
    let manifest;
    if (capabilityCID.startsWith("pm:") || capabilityCID.startsWith("sh:")) {
      const base64 = capabilityCID.slice(3);
      manifest = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
      console.log(`[PlatformDispatcher] Agent ${agentId} manifest decoded from inline CID.`);
    } else {
      console.log(`[PlatformDispatcher] Downloading capabilityCID from 0G Storage...`);
      manifest = await this.storage.downloadData(capabilityCID, `manifest-${agentId}.json`);
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
    if (!supabaseUrl || !supabaseKey) return;

    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/client_bot_configs?subscription_id=eq.${subscriptionId}&select=bot_token,allowed_chats`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
      );
      if (!res.ok) return;
      const rows = await res.json();
      if (!rows?.length || !rows[0].bot_token) return;

      const { bot_token: botToken, allowed_chats: allowedChats = [] } = rows[0];

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
      });

      await bot.start();
      this.customerServiceBots.set(key, bot);
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
      
      const agentIdStr = job[2].toString(); // agentId is at index 2

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

      const config = this.agentConfigs.get(agentIdStr);
      const systemPrompt = config?.platformConfig?.systemPrompt || "You are a monitoring agent. Analyze the task and report findings.";

      await this.scheduler.scheduleJob(
        `sub-${subscriptionId}`,
        cronExpr,
        async (checkpoint) => {
          const result = await this._executeMonitoringTask(subscription, systemPrompt, checkpoint);
          if (this._detectAnomaly(result, subscription)) {
            await this.alertDelivery.sendAnomalyDetected(
              subscriptionId.toString(),
              agentIdStr,
              subscription.taskDescription,
              0,
              result.value || 0
            );
          }
          return result;
        },
        { subscriptionId: subscriptionId.toString(), agentId: agentIdStr }
      );

      console.log(`[PlatformDispatcher] Subscription #${subscriptionId} scheduled (${cronExpr})`);

      // Start client customer service bot if the client has one configured
      await this._startClientBotForSubscription(subscriptionId.toString(), agentIdStr);
    } catch (err) {
      console.error(`[PlatformDispatcher] Failed to schedule subscription #${subscriptionId}:`, err.message);
    }
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

    // Create processor instance
    const processor = new PlatformJobProcessor({
      wallet: this.wallet,
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
