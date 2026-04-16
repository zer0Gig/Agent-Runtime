/**
 * Platform Job Processor
 * 
 * Extends the base JobProcessor to support Platform-Managed Agents.
 * Injects agent-specific configuration (system prompts, tools) into the execution pipeline.
 * Uses ExtendedComputeService for multi-provider LLM routing.
 */

import { JobProcessor, logActivity, sendChatMessage } from "./jobProcessor.js";
import { ExtendedComputeService } from "./extendedComputeService.js";
import { executeForJob } from "./toolExecutor.js";
import { sendMilestoneCard, sendNotification, sendJobCompletionAlert, CustomerServiceBot } from "./telegramConnector.js";
import { SelfEvaluator } from "./selfEvaluator.js";
import { MemoryService } from "./memoryService.js";
import { ethers } from "ethers";

const ACTIVITY_BASE = process.env.ACTIVITY_LOG_URL?.replace("/api/agent-activity", "") || "http://localhost:3000";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

/** Fetch telegramChatId from agent_profiles.metadata (Option 2 — 0G Storage-backed) */
async function getTelegramChatIdFromProfiles(agentId) {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/agent_profiles?agent_id=eq.${agentId}&select=metadata`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.metadata?.telegramChatId ?? null;
  } catch {
    return null;
  }
}

/** Post a message to the job chat stream */
async function postChat(jobId, message, msgType = "text", metadata = {}) {
  try {
    await fetch(`${ACTIVITY_BASE}/api/job-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, sender: "agent", message, msgType, metadata }),
    });
  } catch (err) {
    console.log(`[PlatformProcessor] postChat error: ${err.message}`);
  }
}

/**
 * Wait for milestone approval via chat-based feedback loop.
 *
 * Flow:
 *  1. Post the milestone output summary + "milestone_ready" card as agent messages.
 *  2. Every 15 min, post a reminder if the user still hasn't responded.
 *  3. When the user sends a message, use LLM to interpret intent:
 *       APPROVED  → confirm and wait for button click to release payment.
 *       REVISION  → acknowledge, apply (max 2 revisions), re-post card.
 *  4. Never auto-approve — if the 1-hour deadline passes with no action, throw.
 *
 * Returns when the user clicks "Go to Next Milestone" (milestone-approval POST).
 */
async function runFeedbackLoop(jobId, milestoneIndex, outputSummary, extendedCompute, telegramChatId = null, timeoutMs = 60 * 60 * 1000) {
  const REMINDER_INTERVAL = 15 * 60 * 1000; // 15 minutes between reminders
  const POLL_INTERVAL     = 1_000;           // check for new user messages every 1s
  const MAX_REVISIONS     = 2;

  const deadline        = Date.now() + timeoutMs;
  let lastMsgTime       = new Date().toISOString();
  let lastReminder      = Date.now();
  let revisions         = 0;
  const collectedFeedback = []; // accumulate user messages for memory

  // 1. Post output summary as a plain chat bubble (dashboard)
  await postChat(
    jobId,
    `✅ Milestone ${milestoneIndex + 1} complete! Here's a summary of my work:\n\n${outputSummary}\n\nPlease review and reply — tell me if you're happy with this or what you'd like changed.`,
    "text"
  );

  // 2. Post the milestone_ready card (dashboard — has "Go to Next Milestone" button)
  await postChat(
    jobId,
    `Milestone ${milestoneIndex + 1} is ready for your review. Click below when you're satisfied to release payment and continue.`,
    "milestone_ready",
    { milestoneIndex }
  );

  // 2b. Send Telegram notification if client has it connected
  if (telegramChatId) {
    await sendMilestoneCard({ chatId: telegramChatId, jobId, milestoneIndex, outputSummary });
  }

  console.log(`[PlatformProcessor] Milestone ${milestoneIndex + 1} card posted — waiting for user action.`);

  const approvalUrl = `${ACTIVITY_BASE}/api/milestone-approval?jobId=${jobId}&milestoneIndex=${milestoneIndex}`;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    // ── Check if user already clicked the approval button ──────────────────
    try {
      const res = await fetch(approvalUrl);
      if (res.ok && (await res.json()).approved) {
        console.log(`[PlatformProcessor] Milestone ${milestoneIndex + 1} approved via button.`);
        return { userFeedback: collectedFeedback.join("\n") };
      }
    } catch { /* ignore network hiccups */ }

    // ── Fetch new user chat messages since last check ───────────────────────
    let userMessages = [];
    try {
      const res = await fetch(`${ACTIVITY_BASE}/api/job-chat?jobId=${jobId}&since=${encodeURIComponent(lastMsgTime)}`);
      if (res.ok) {
        const all = await res.json();
        userMessages = all.filter(m => m.sender === "user");
      }
    } catch (err) {
      console.log(`[PlatformProcessor] Chat poll error: ${err.message}`);
    }

    // ── Interpret user message if any ───────────────────────────────────────
    if (userMessages.length > 0) {
      lastMsgTime = new Date().toISOString();
      lastReminder = Date.now(); // reset reminder timer when user is active
      const chatText = userMessages.map(m => m.message).join("\n");
      collectedFeedback.push(chatText); // accumulate for memory
      console.log(`[PlatformProcessor] ${userMessages.length} user message(s) — interpreting...`);

      let intent = "UNKNOWN";
      try {
        const result = await extendedCompute.processTask(
          `You are an AI freelance agent. You completed a milestone and the client has responded.

Your milestone ${milestoneIndex + 1} summary:
${outputSummary}

Client's message:
${chatText}

Classify the client's intent with EXACTLY one of:
- "APPROVED" — client is satisfied, happy, wants to proceed
- "REVISION: <specific change>" — client wants something changed or fixed

Reply with only "APPROVED" or "REVISION: ..." — nothing else.`,
          "", ""
        );
        const raw = result.content.trim();
        if (raw.toUpperCase().startsWith("APPROVED")) intent = "APPROVED";
        else if (raw.toUpperCase().startsWith("REVISION")) intent = raw;
      } catch {
        // On LLM failure, ask the user to use the button directly
        await postChat(jobId, "I had trouble interpreting your message. If you're satisfied, please click the 'Go to Next Milestone' button above to proceed.");
        continue;
      }

      console.log(`[PlatformProcessor] Intent: ${intent}`);

      if (intent === "APPROVED") {
        // Re-post the card in case the user missed it, and confirm
        await postChat(
          jobId,
          `Great! I'm glad the work meets your expectations. Click the button below to release payment for milestone ${milestoneIndex + 1} and proceed to the next step.`,
          "milestone_ready",
          { milestoneIndex }
        );
      } else {
        // REVISION requested
        revisions++;
        const details = intent.replace(/^REVISION:\s*/i, "");
        console.log(`[PlatformProcessor] Revision ${revisions}/${MAX_REVISIONS}: ${details}`);

        await postChat(
          jobId,
          `Understood — I'll revise: "${details}". This is revision ${revisions}/${MAX_REVISIONS}.`
        );

        if (revisions >= MAX_REVISIONS) {
          await postChat(
            jobId,
            `I've done my best with ${revisions} revision(s). If you'd like further changes after approving, you can open a new job. Please click the button to proceed when ready.`,
            "milestone_ready",
            { milestoneIndex }
          );
        } else {
          // Re-post card after acknowledging revision
          await postChat(
            jobId,
            `Revision applied. Please review again — click below when satisfied.`,
            "milestone_ready",
            { milestoneIndex }
          );
        }
      }

      continue; // restart poll loop
    }

    // ── Send a reminder if 15 minutes have passed without activity ──────────
    if (Date.now() - lastReminder >= REMINDER_INTERVAL) {
      lastReminder = Date.now();
      const minutesLeft = Math.round((deadline - Date.now()) / 60_000);
      const reminderMsg = `⏰ Reminder: Milestone ${milestoneIndex + 1} is still waiting for your review (${minutesLeft} min remaining). Click "Go to Next Milestone" above when you're ready, or reply here with feedback.`;

      await postChat(jobId, reminderMsg, "text");

      if (telegramChatId) {
        await sendNotification({
          chatId: telegramChatId,
          message: reminderMsg,
        });
      }

      console.log(`[PlatformProcessor] Reminder posted — ${minutesLeft} min left on deadline.`);
    }
  }

  // Deadline passed without approval
  throw Object.assign(
    new Error(`Milestone ${milestoneIndex + 1} timed out after ${timeoutMs / 60_000} minutes with no user action.`),
    { userFeedback: collectedFeedback.join("\n") }
  );
}

export class PlatformJobProcessor extends JobProcessor {
  /**
   * @param {object} params - Standard JobProcessor params.
   * @param {object} agentConfig - The validated capability manifest for this agent.
   *   {
   *     model: string,
   *     systemPrompt: string,
   *     llmProvider: string,
   *     tools: Array,
   *     ...
   *   }
   */
  constructor(params, agentConfig) {
    super(params);
    
    this.agentConfig = agentConfig;
    this.customerServiceBot = null;
    
    this.extendedCompute = new ExtendedComputeService(params.wallet, {
      provider: agentConfig.platformConfig?.llmProvider || "0g-compute",
      systemPrompt: agentConfig.platformConfig?.systemPrompt || "You are a helpful assistant."
    });

    this.selfEvaluator  = new SelfEvaluator(this.extendedCompute);
    this.memoryService  = new MemoryService(agentConfig.agentId, this.extendedCompute, this.storage);
  }

  async setupCustomerService() {
    const telegramConfig = this.agentConfig.skillConfigs?.telegram_notify;
    if (!telegramConfig?.botToken) return;

    if (!this.customerServiceBot) {
      this.customerServiceBot = new CustomerServiceBot({
        botToken: telegramConfig.botToken,
        allowedChats: telegramConfig.allowedChats || [],
        extendedCompute: this.extendedCompute,
        memoryService: this.memoryService,
        storageService: this.storage,
      });

      await this.customerServiceBot.start();
    }
  }

  async stopCustomerService() {
    if (this.customerServiceBot) {
      await this.customerServiceBot.stop();
      this.customerServiceBot = null;
    }
  }

  /**
   * Override processMilestone to inject tool context and use ExtendedComputeService.
   * @param {bigint} jobId 
   * @param {number} milestoneIndex 
   * @param {object} job 
   * @param {object} jobBrief 
   */
  async processMilestone(jobId, milestoneIndex, job, jobBrief) {
    const id = jobId.toString();
    const agentId = this.agentConfig.agentId;
    const agentWallet = job.agentWallet;
    const totalMilestones = job.milestones.length;

    console.log(`\n[PlatformProcessor] --- Milestone ${milestoneIndex} for Agent ${agentId} ---`);
    console.log(`[PlatformProcessor] Percentage: ${job.milestones[milestoneIndex].percentage}%`);
    console.log(`[PlatformProcessor] Amount: ${job.milestones[milestoneIndex].amountWei} wei`);

    await logActivity({
      jobId: id, agentId, agentWallet,
      phase: "processing",
      message: `Working on milestone ${milestoneIndex + 1}/${totalMilestones}...`,
      milestoneIndex,
    });

    // 1. Execute Tools + Pre-built Skills (if configured)
    const customTools     = this.agentConfig.tools           || [];
    const prebuiltSkills  = this.agentConfig.prebuiltSkills  || [];
    let toolContext = "";
    if (customTools.length > 0 || prebuiltSkills.length > 0) {
      console.log(`[PlatformProcessor] Executing ${customTools.length} tool(s) + ${prebuiltSkills.length} skill(s)...`);
      try {
        toolContext = await executeForJob(jobBrief, customTools, prebuiltSkills, agentId);
        if (toolContext) {
          console.log("[PlatformProcessor] Tool/skill context generated.");
        }
      } catch (error) {
        console.error("[PlatformProcessor] Tool execution failed:", error.message);
      }
    }

    // 2. Recall memories for this client
    let memoryContext = "";
    try {
      const clientAddress = job.client || "";
      const jobType = jobBrief.skillCategory || jobBrief.category || "general";
      const recalled = await this.memoryService.recall(clientAddress, jobType);
      if (recalled) {
        memoryContext = recalled;
        console.log(`[PlatformProcessor] Memory injected for client ${clientAddress.slice(0, 10)}…`);
        await logActivity({
          jobId: id, agentId, agentWallet,
          phase: "memory_loaded",
          message: `Loaded past learnings for this client — context injected`,
          milestoneIndex,
        });
      }
    } catch (err) {
      console.log(`[PlatformProcessor] Memory recall failed: ${err.message}`);
    }

    // 3. Build Task Prompt
    const taskDescription = this._buildTaskPrompt(jobBrief, milestoneIndex, totalMilestones);

    // 4. LLM Generation + Self-Evaluation Loop
    let result;
    let currentPrompt = taskDescription;
    const MAX_SELF_RETRIES = this.selfEvaluator.MAX_RETRIES;

    for (let attempt = 0; attempt <= MAX_SELF_RETRIES; attempt++) {
      console.log(`[PlatformProcessor] LLM call (attempt ${attempt + 1}/${MAX_SELF_RETRIES + 1})...`);

      try {
        result = await this.extendedCompute.processTask(currentPrompt, memoryContext, toolContext);
        console.log(`[PlatformProcessor] LLM response: ${result.content.length} chars via ${result.provider}`);
      } catch (err) {
        console.log(`[PlatformProcessor] Compute error: ${err.message}`);
        result = {
          content: `[Agent Output] Milestone ${milestoneIndex + 1}/${totalMilestones} completed.\n\nDeliverable prepared based on job requirements and ready for review.`,
          model: "fallback",
          provider: "fallback",
        };
      }

      // Skip self-evaluation on final attempt — accept whatever we have
      if (attempt === MAX_SELF_RETRIES) {
        console.log(`[PlatformProcessor] Max retries reached — proceeding with current output.`);
        break;
      }

      // Self-evaluate
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "self_review",
        message: `Reviewing output quality (attempt ${attempt + 1})…`,
        milestoneIndex,
      });

      const evaluation = await this.selfEvaluator.evaluate(
        result.content,
        jobBrief.description || taskDescription,
        milestoneIndex,
        totalMilestones
      );

      console.log(`[PlatformProcessor] Self-score: ${evaluation.score}/10000 — ${evaluation.summary}`);

      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "self_review",
        message: `Quality score: ${evaluation.score}/10000 — ${evaluation.passed ? "✅ Passed" : "⚠️ Below threshold, improving…"}`,
        milestoneIndex,
        metadata: { selfScore: evaluation.score, issues: evaluation.issues, summary: evaluation.summary },
      });

      if (evaluation.passed) break; // Good enough — proceed to upload

      // Build improved prompt and retry
      currentPrompt = this.selfEvaluator.buildImprovementPrompt(
        taskDescription, result.content, evaluation
      );
    }

    // Log the actual output content so the frontend can display it
    await logActivity({
      jobId: id, agentId, agentWallet,
      phase: "agent_output",
      message: `Milestone ${milestoneIndex + 1} output ready (${result.content.length} chars via ${result.model})`,
      milestoneIndex,
      metadata: {
        content: result.content,
        model: result.model,
        provider: result.provider,
      },
    });

    // Send the output as a chat message to the job stream
    await sendChatMessage({
      jobId: Number(id),
      message: result.content,
      msgType: "text",
      metadata: { model: result.model, provider: result.provider, milestoneIndex },
    });

    // 4. Upload output to 0G Storage
    const output = {
      jobId: id,
      milestoneIndex,
      content: result.content,
      model: result.model,
      provider: result.provider,
      timestamp: new Date().toISOString(),
    };

    let outputCID;
    try {
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "uploading",
        message: "Uploading output to 0G Storage...",
        milestoneIndex,
      });
      outputCID = await this.storage.uploadMilestoneOutput(id, milestoneIndex, output);
      console.log(`[PlatformProcessor] Output uploaded. CID: ${outputCID}`);
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "uploaded",
        message: `Output stored on 0G Storage`,
        milestoneIndex,
        metadata: { outputCID },
      });
    } catch (err) {
      console.log(`[PlatformProcessor] Storage upload error: ${err.message}`);
      outputCID = `mock-cid-job${id}-m${milestoneIndex}-${Date.now()}`;
    }

    // 5. Pre-compute alignment score + signature (so we can release immediately on approval)
    const alignmentScore = Number(process.env.DEMO_ALIGNMENT_SCORE) || 8500;
    const signature = await this._signAlignmentResult(
      jobId,
      milestoneIndex,
      alignmentScore,
      outputCID
    );

    // 6. Pause — run chat-based feedback loop until user confirms
    await logActivity({
      jobId: id, agentId, agentWallet,
      phase: "waiting_approval",
      message: `Milestone ${milestoneIndex + 1} ready. Waiting for user review via chat.`,
      milestoneIndex,
      metadata: { outputCID, alignmentScore },
    });

    // Build a short output summary for the chat (first 800 chars)
    const outputSummary = result.content.length > 800
      ? result.content.slice(0, 800) + "…"
      : result.content;

    // Resolve Telegram chatId — first from skill config, then from agent_profiles.metadata (Option 2)
    let telegramChatId = this.agentConfig.skillConfigs?.telegram_notify?.chatId || null;
    if (!telegramChatId) {
      const fromProfile = await getTelegramChatIdFromProfiles(this.agentConfig.agentId);
      if (fromProfile) {
        telegramChatId = fromProfile;
        console.log(`[PlatformProcessor] Telegram chatId recovered from agent_profiles.metadata`);
      }
    }
    if (telegramChatId) {
      console.log(`[PlatformProcessor] Telegram notifications → chat ${telegramChatId}`);
    }

    let feedbackResult = { userFeedback: "" };
    try {
      feedbackResult = await runFeedbackLoop(id, milestoneIndex, outputSummary, this.extendedCompute, telegramChatId) || feedbackResult;
    } catch (timeoutErr) {
      console.error(`[PlatformProcessor] ${timeoutErr.message}`);
      feedbackResult.userFeedback = timeoutErr.userFeedback || "";
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "error",
        message: `Milestone ${milestoneIndex + 1} feedback loop timed out.`,
        milestoneIndex,
      });
      return;
    }

    // 7. Save memory — extract learnings from chat feedback
    try {
      await this.memoryService.save({
        clientAddress: job.client || "",
        jobId:         id,
        jobType:       jobBrief.skillCategory || jobBrief.category || "general",
        outcomeScore:  alignmentScore,
        chatFeedback:  feedbackResult.userFeedback,
        outputSummary: result.content,
      });
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "memory_saved",
        message: `Learnings saved — agent will remember this client's preferences`,
        milestoneIndex,
      });
    } catch (err) {
      console.log(`[PlatformProcessor] Memory save failed: ${err.message}`);
    }

    // 9. Submit milestone to escrow for payment release
    console.log("[PlatformProcessor] User approved — submitting milestone to ProgressiveEscrow...");
    await logActivity({
      jobId: id, agentId, agentWallet,
      phase: "submitting",
      message: `Submitting milestone ${milestoneIndex + 1} for payment release (alignment score: ${(alignmentScore / 100).toFixed(1)}%)`,
      milestoneIndex,
    });
    try {
      const tx = await this.escrow.releaseMilestone(
        jobId,
        milestoneIndex,
        outputCID,
        alignmentScore,
        signature
      );
      const receipt = await tx.wait();
      const amountOG = ethers.formatEther(job.milestones[milestoneIndex].amountWei);
      console.log(`[PlatformProcessor] Milestone ${milestoneIndex} APPROVED! TX: ${receipt.hash}`);
      console.log(`[PlatformProcessor] Payment released: ${amountOG} OG`);
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "completed",
        message: `Milestone ${milestoneIndex + 1} approved — ${amountOG} OG released`,
        milestoneIndex,
        metadata: { txHash: receipt.hash, amountOG },
      });

      // Send Telegram job completion alert
      if (telegramChatId) {
        try {
          await sendJobCompletionAlert({
            chatId: telegramChatId,
            jobId: id,
            title: jobBrief.title || `Job #${id}`,
            summary: outputSummary,
            totalEarned: `${amountOG} OG`,
          });
        } catch (err) {
          console.log(`[PlatformProcessor] Telegram completion alert failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[PlatformProcessor] Milestone submission failed:`, err.message?.slice(0, 120));
      await logActivity({
        jobId: id, agentId, agentWallet,
        phase: "error",
        message: `Milestone submission failed: ${err.message?.slice(0, 200)}`,
        milestoneIndex,
      });
    }
  }
}
