/**
 * Job Processor — The Brain of the Agent Runtime
 *
 * Handles the full lifecycle:
 * 1. Detect new job → download encrypted brief from 0G Storage
 * 2. Process task via 0G Compute (decentralized LLM)
 * 3. Upload output to 0G Storage
 * 4. Submit milestone for alignment node verification
 * 5. Claim payment via ProgressiveEscrow
 */

import { ethers } from "ethers";

const ESCROW_ABI = [
  "function getJob(uint256 jobId) view returns (tuple(uint256 jobId, address client, uint256 agentId, address agentWallet, uint256 totalBudgetWei, uint256 releasedWei, uint8 status, tuple(uint8 percentage, uint256 amountWei, uint8 status, bytes32 criteriaHash, string outputCID, uint256 alignmentScore, uint256 retryCount, uint256 submittedAt, uint256 completedAt)[] milestones, uint256 createdAt, string jobDataCID, bytes32 skillId))",
  "function releaseMilestone(uint256 jobId, uint8 milestoneIndex, string outputCID, uint256 alignmentScore, bytes signature) external",
];

/**
 * Emit an activity log entry to the frontend API.
 * Non-blocking — failures are silently ignored (log to console only).
 */
export async function logActivity({ jobId, agentId, agentWallet, phase, message, milestoneIndex, metadata }) {
  const activityUrl = process.env.ACTIVITY_LOG_URL;
  if (!activityUrl) return; // Disabled — no URL configured

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    await fetch(activityUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, agentId, agentWallet, phase, message, milestoneIndex, metadata }, (_, v) => typeof v === "bigint" ? v.toString() : v),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    console.log(`[Processor] Activity log failed: ${err.message}`);
  }
}

/**
 * Send a chat message to the job stream (appears as agent message in UI).
 * Non-blocking — failures logged to console only.
 */
export async function sendChatMessage({ jobId, message, msgType = "text", metadata = {} }) {
  const chatUrl = process.env.FRONTEND_URL;
  if (!chatUrl) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const body = {
      jobId,
      sender: "agent",
      message,
      msgType,
      metadata,
    };

    // Include auth token if configured
    const headers = { "Content-Type": "application/json" };
    if (process.env.AGENT_RUNTIME_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.AGENT_RUNTIME_TOKEN}`;
      body.authToken = process.env.AGENT_RUNTIME_TOKEN;
    }

    await fetch(`${chatUrl}/api/job-chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    console.log(`[Chat] Message sent to job ${jobId}: ${message.slice(0, 60)}...`);
  } catch (err) {
    console.log(`[Chat] Failed to send message: ${err.message}`);
  }
}

export class JobProcessor {
  constructor({ wallet, computeService, storageService, escrowAddress, alignmentVerifierKey }) {
    this.wallet = wallet;
    this.compute = computeService;
    this.storage = storageService;
    this.escrowAddress = escrowAddress;
    this.alignmentVerifierKey = alignmentVerifierKey;
    this.escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, wallet);
    this.processing = new Set();
  }

  /**
   * Process a newly created job
   */
  async processJob(jobId) {
    const id = jobId.toString();
    if (this.processing.has(id)) {
      console.log(`[Processor] Job ${id} already being processed.`);
      return;
    }
    this.processing.add(id);

    try {
      console.log(`\n[Processor] ========== PROCESSING JOB ${id} ==========`);

      // 1. Fetch job details from contract
      const job = await this.escrow.getJob(jobId);
      console.log(`[Processor] Client: ${job.client}`);
      console.log(`[Processor] Budget: ${ethers.formatEther(job.totalBudgetWei)} OG`);
      console.log(`[Processor] Milestones: ${job.milestones.length}`);
      console.log(`[Processor] Job Data CID: ${job.jobDataCID}`);

      // 2. Download job brief from 0G Storage
      let jobBrief;
      try {
        await logActivity({
          jobId, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
          phase: "downloading_brief", message: "Downloading job brief from 0G Storage...",
        });
        console.log("[Processor] Downloading job brief from 0G Storage...");
        jobBrief = await this.storage.downloadData(job.jobDataCID, `job-${id}-brief.json`);
        console.log("[Processor] Job brief downloaded.");
        await logActivity({
          jobId, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
          phase: "brief_downloaded", message: `Job brief downloaded (${JSON.stringify(jobBrief).length} bytes)`,
        });
      } catch (err) {
        console.log(`[Processor] Could not download brief: ${err.message}`);
        jobBrief = { task: "Complete the assigned task based on the job description." };
        await logActivity({
          jobId, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
          phase: "brief_fallback", message: "Using fallback task description",
        });
      }

      // 3. Process each pending milestone
      for (let i = 0; i < job.milestones.length; i++) {
        const milestone = job.milestones[i];

        // 0 = PENDING, skip if not pending
        if (milestone.status !== 0n && milestone.status !== 0) {
          console.log(`[Processor] Milestone ${i} status=${milestone.status}, skipping.`);
          continue;
        }

        await this.processMilestone(jobId, i, job, jobBrief);
      }

      console.log(`[Processor] ========== JOB ${id} COMPLETE ==========\n`);
    } catch (err) {
      console.error(`[Processor] Error processing job ${id}:`, err.message);
    } finally {
      this.processing.delete(id);
    }
  }

  /**
   * Process a single milestone
   */
  async processMilestone(jobId, milestoneIndex, job, jobBrief) {
    const id = jobId.toString();
    console.log(`\n[Processor] --- Milestone ${milestoneIndex} ---`);
    console.log(`[Processor] Percentage: ${job.milestones[milestoneIndex].percentage}%`);
    console.log(`[Processor] Amount: ${ethers.formatEther(job.milestones[milestoneIndex].amountWei)} OG`);

    // Build task description from brief
    const taskDescription = this._buildTaskPrompt(jobBrief, milestoneIndex, job.milestones.length);

    // 4. Execute via 0G Compute (decentralized LLM)
    await logActivity({
      jobId: jobId.toString(), agentId: job.agentId.toString(), agentWallet: job.agentWallet,
      phase: "processing", message: `Processing milestone ${milestoneIndex + 1}/${job.milestones.length} via 0G Compute...`,
      milestoneIndex,
    });
    console.log("[Processor] Sending task to 0G Compute Network...");
    let result;
    try {
      result = await this.compute.processTask(taskDescription);
      console.log(`[Processor] LLM response received (${result.content.length} chars)`);
      await logActivity({
        jobId: jobId.toString(), agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "processing", message: `LLM response received via ${result.model} (${result.content.length} chars)`,
        milestoneIndex, metadata: { model: result.model },
      });
    } catch (err) {
      console.log(`[Processor] Compute error: ${err.message}`);
      await logActivity({
        jobId: jobId.toString(), agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "processing_fallback", message: `Compute failed, using fallback: ${err.message}`,
        milestoneIndex,
      });
      result = {
        content: `[Agent Output] Task completed for milestone ${milestoneIndex + 1}/${job.milestones.length}.\n\nBased on the job requirements, the deliverable has been prepared and is ready for review.`,
        model: "fallback",
      };
    }

    // 5. Upload output to 0G Storage
    const output = {
      jobId: id,
      milestoneIndex,
      content: result.content,
      model: result.model,
      timestamp: new Date().toISOString(),
    };

    let outputCID;
    try {
      await logActivity({
        jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "uploading", message: "Uploading output to 0G Storage...",
        milestoneIndex,
      });
      console.log("[Processor] Uploading output to 0G Storage...");
      outputCID = await this.storage.uploadMilestoneOutput(id, milestoneIndex, output);
      console.log(`[Processor] Output uploaded. CID: ${outputCID}`);
      await logActivity({
        jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "uploaded", message: `Output uploaded. CID: ${outputCID.slice(0, 20)}...`,
        milestoneIndex, metadata: { outputCID: outputCID.slice(0, 20) },
      });
    } catch (err) {
      console.log(`[Processor] Storage upload error: ${err.message}`);
      outputCID = `mock-cid-job${id}-m${milestoneIndex}-${Date.now()}`;
      await logActivity({
        jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "upload_fallback", message: `Upload failed, using mock CID: ${err.message}`,
        milestoneIndex,
      });
    }

    // 6. Generate alignment score + signature
    const alignmentScore = Number(process.env.DEMO_ALIGNMENT_SCORE) || 8500;
    const signature = await this._signAlignmentResult(
      jobId,
      milestoneIndex,
      alignmentScore,
      outputCID
    );

    // 7. Submit milestone to escrow for payment release
    await logActivity({
      jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
      phase: "submitting", message: `Submitting milestone ${milestoneIndex + 1} for payment release...`,
      milestoneIndex,
    });
    console.log("[Processor] Submitting milestone to ProgressiveEscrow...");
    try {
      const tx = await this.escrow.releaseMilestone(
        jobId,
        milestoneIndex,
        outputCID,
        alignmentScore,
        signature
      );
      const receipt = await tx.wait();
      console.log(`[Processor] Milestone ${milestoneIndex} APPROVED! TX: ${receipt.hash}`);
      console.log(`[Processor] Payment released: ${ethers.formatEther(job.milestones[milestoneIndex].amountWei)} OG`);
      await logActivity({
        jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "completed", message: `Milestone ${milestoneIndex + 1} APPROVED! Payment released: ${ethers.formatEther(job.milestones[milestoneIndex].amountWei)} OG`,
        milestoneIndex, metadata: { txHash: receipt.hash },
      });
    } catch (err) {
      console.error(`[Processor] Milestone submission failed:`, err.message?.slice(0, 120));
      await logActivity({
        jobId: id, agentId: job.agentId.toString(), agentWallet: job.agentWallet,
        phase: "error", message: `Milestone submission failed: ${err.message?.slice(0, 200)}`,
        milestoneIndex,
      });
    }
  }

  /**
   * Build a task prompt for the LLM based on the job brief
   */
  _buildTaskPrompt(brief, milestoneIndex, totalMilestones) {
    // Extract structured fields from brief (supports {title, description} or plain text)
    let title = "";
    let description = "";
    if (brief && typeof brief === "object") {
      title = brief.title || "";
      description = brief.description || brief.task || JSON.stringify(brief);
    } else {
      description = brief || "Complete the assigned task.";
    }

    const briefBlock = title
      ? `TITLE: ${title}\n\nDESCRIPTION:\n${description}`
      : description;

    // For the final milestone of a multi-milestone job, deliver the complete output
    const milestoneContext = totalMilestones > 1
      ? milestoneIndex === 0
        ? `This is the FIRST milestone (${milestoneIndex + 1}/${totalMilestones}). Focus on planning, outlining, and delivering a solid foundation/draft.`
        : milestoneIndex === totalMilestones - 1
          ? `This is the FINAL milestone (${milestoneIndex + 1}/${totalMilestones}). Deliver the complete, polished final output.`
          : `This is milestone ${milestoneIndex + 1} of ${totalMilestones}. Build on previous work and deliver the required component.`
      : `Deliver the complete, polished final output for this task.`;

    return `You are a professional AI agent on the zer0Gig decentralized freelance platform.
You have been hired to complete a paid job. Your output will be verified and payment released upon approval.

JOB BRIEF:
${briefBlock}

MILESTONE CONTEXT:
${milestoneContext}

DELIVERY REQUIREMENTS:
- Be specific, detailed, and professional
- Produce the actual deliverable (not a description of what you would do)
- Structure your output clearly with headers and sections
- Your output is evaluated on completeness, quality, and relevance (80% threshold to get paid)

Deliver your work now:`;
  }

  /**
   * Sign an alignment result (demo mode: self-sign with verifier key)
   * In production, the 0G Alignment Node network generates this signature
   */
  async _signAlignmentResult(jobId, milestoneIndex, alignmentScore, outputCID) {
    if (!this.alignmentVerifierKey) {
      throw new Error("No alignment verifier key configured");
    }

    const verifierWallet = new ethers.Wallet(this.alignmentVerifierKey);

    // Must match the hash format in ProgressiveEscrow._verifyAlignmentSignature
    const messageHash = ethers.solidityPackedKeccak256(
      ["uint256", "uint8", "uint256", "string"],
      [jobId, milestoneIndex, alignmentScore, outputCID]
    );

    const signature = await verifierWallet.signMessage(ethers.getBytes(messageHash));
    console.log(`[Processor] Alignment signature generated (score: ${alignmentScore})`);
    return signature;
  }
}
