/**
 * Agent Memory Service — 0G Storage Backed
 *
 * Persists agent learnings across jobs using 0G Storage:
 * - Immutable log layer: Each memory saved as independent file on 0G with Merkle proof
 * - KV layer: Fast lookup index maps client+jobType → latest memory CID
 * - LLM extraction: Feedback analyzed for actionable learnings & preferences
 *
 * Flow:
 *   Job starts → recall(clientAddress, jobType) → inject into LLM context
 *   Job ends   → save({ clientAddress, jobId, jobType, outcomeScore, chatFeedback }) → 0G Storage
 *
 * Data survives agent restarts — all data is on 0G, not in memory.
 */

export class MemoryService {
  /**
   * @param {number} agentId          - On-chain agent ID
   * @param {object} extendedCompute  - LLM service for learning extraction
   * @param {object} storageService   - 0G StorageService instance (dependency injection)
   */
  constructor(agentId, extendedCompute, storageService) {
    this.agentId = Number(agentId);
    this.compute = extendedCompute;
    this.storage = storageService;
    this.streamId = `agent:${agentId}:memories`;
    // In-memory cache for speed (repopulated from 0G on first access)
    this._cache = new Map();
  }

  /**
   * Recall memories for a specific client + job type.
   * Downloads from 0G Storage KV layer and formats for LLM context.
   *
   * @param {string} clientAddress - Ethereum address of the client
   * @param {string} jobType       - Job category (e.g., "market-analysis", "general")
   * @returns {Promise<string|null>} Formatted memory string or null
   */
  async recall(clientAddress, jobType = "general") {
    if (!clientAddress) return null;

    const key = `${clientAddress.toLowerCase()}:${jobType}`;

    // Check in-memory cache first
    const cached = this._cache.get(key);
    if (cached && cached.memory) return cached.memory;

    // Try 0G KV layer
    try {
      const entry = await this.storage.kvGet(this.streamId, key);
      if (!entry?.cid) return null;

      // Download full memory from 0G immutable log
      const memory = await this.storage.downloadData(entry.cid, `memory-${this.agentId}-${key.replace(/:/g, "-")}.json`);
      if (!memory?.learnings?.length) return null;

      // Format for LLM injection
      const formatted = this._formatForLLM(memory, jobType);

      // Cache for future calls
      this._cache.set(key, { memory: formatted, timestamp: entry.timestamp });

      return formatted;
    } catch (err) {
      console.warn(`[Memory] Recall failed for ${key}: ${err.message}`);
      return null;
    }
  }

  /**
   * Save a memory entry after job/milestone completion.
   * Uses LLM to extract structured learnings, then persists to 0G Storage.
   *
   * Two writes:
   * 1. Immutable log: Full memory entry uploaded to 0G (audit trail)
   * 2. KV index: Pointer to latest memory for fast recall
   *
   * @param {object} params
   * @param {string} params.clientAddress  - Client's Ethereum address
   * @param {string} params.jobId          - Job/subscription identifier
   * @param {string} params.jobType        - Category (default: "general")
   * @param {number} params.outcomeScore   - Alignment score (0-10000)
   * @param {string} params.chatFeedback   - Raw client feedback text
   * @param {string} params.outputSummary  - Agent's output summary
   * @returns {Promise<string>} CID of the uploaded memory
   */
  async save({ clientAddress, jobId, jobType = "general", outcomeScore, chatFeedback, outputSummary }) {
    if (!clientAddress) return null;

    const key = `${clientAddress.toLowerCase()}:${jobType}`;
    let learnings = [];
    let preferences = {};

    // Extract structured learnings from feedback using LLM
    if (chatFeedback && chatFeedback.trim().length > 10) {
      try {
        const extraction = await this.compute.processTask(
          `You are extracting actionable learnings from a client's feedback about an AI agent's work.

Client feedback:
${chatFeedback}

Agent output summary:
${(outputSummary || "").slice(0, 400)}

Respond ONLY in this exact JSON format (no extra text):
{
  "keyLearnings": ["<concise actionable learning, max 80 chars>"],
  "preferences": {
    "style": "<style preference if mentioned, else null>",
    "format": "<output format preference if mentioned, else null>",
    "constraints": "<hard constraints mentioned, else null>"
  }
}

Rules: max 5 learnings, only what's explicitly stated, omit null preferences.`,
          "", ""
        );

        const jsonMatch = extraction.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          learnings = (parsed.keyLearnings || []).slice(0, 5);
          preferences = parsed.preferences || {};
          Object.keys(preferences).forEach(k => {
            if (!preferences[k] || preferences[k] === "null") delete preferences[k];
          });
        }
      } catch (err) {
        console.log(`[Memory] Learning extraction failed: ${err.message}`);
      }
    }

    // Merge with existing memory if it exists
    const existing = this._cache.get(key)?.raw || await this._loadRawMemory(key);
    if (existing) {
      learnings = [...new Set([...(existing.learnings || []), ...learnings])].slice(0, 15);
      preferences = { ...(existing.preferences || {}), ...preferences };
    }

    // Build memory entry
    const memory = {
      agentId: this.agentId,
      clientAddress: clientAddress.toLowerCase(),
      jobId,
      jobType,
      outcomeScore,
      learnings,
      preferences,
      rawFeedback: chatFeedback?.slice(0, 2000),
      outputSummary: outputSummary?.slice(0, 1000),
      savedAt: Math.floor(Date.now() / 1000),
      version: "1.0",
    };

    // 1. Upload to 0G immutable log layer
    const cid = await this.storage.uploadData(
      memory,
      `memory-${this.agentId}-${key.replace(/:/g, "-")}-${memory.savedAt}.json`
    );

    // 2. Update KV index pointer
    await this.storage.kvSet(this.streamId, key, { cid, timestamp: memory.savedAt });

    // 3. Update in-memory cache
    this._cache.set(key, {
      raw: memory,
      memory: this._formatForLLM(memory, jobType),
      timestamp: memory.savedAt,
    });

    console.log(`[Memory] Saved for ${clientAddress.slice(0, 10)}… type=${jobType} learnings=${learnings.length} cid=${cid.slice(0, 12)}…`);
    return cid;
  }

  /**
   * Get all memories for a client across all job types.
   * Useful for building a complete client profile.
   *
   * @param {string} clientAddress - Client's Ethereum address
   * @returns {Promise<Array>} Array of { jobType, content }
   */
  async getAllMemories(clientAddress) {
    const jobTypes = ["general", "market-analysis", "chart-patterns", "risk-management", "subscription", "coding"];
    const memories = [];

    for (const jobType of jobTypes) {
      const content = await this.recall(clientAddress, jobType);
      if (content) memories.push({ jobType, content });
    }

    return memories;
  }

  /**
   * Get raw memory data for a client + job type.
   * Returns the full object (not formatted for LLM).
   *
   * @param {string} clientAddress
   * @param {string} jobType
   * @returns {Promise<object|null>}
   */
  async getRawMemory(clientAddress, jobType) {
    const key = `${clientAddress.toLowerCase()}:${jobType}`;
    const cached = this._cache.get(key);
    if (cached?.raw) return cached.raw;

    return this._loadRawMemory(key);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  /**
   * Load raw memory from 0G Storage.
   */
  async _loadRawMemory(key) {
    try {
      const entry = await this.storage.kvGet(this.streamId, key);
      if (!entry?.cid) return null;

      const memory = await this.storage.downloadData(entry.cid, `memory-raw-${key.replace(/:/g, "-")}.json`);
      if (memory?.learnings) {
        this._cache.set(key, { raw: memory, timestamp: entry.timestamp });
      }
      return memory;
    } catch {
      return null;
    }
  }

  /**
   * Format memory data for LLM context injection.
   */
  _formatForLLM(memory, jobType) {
    const lines = [`[Memory: ${jobType} — last updated ${new Date(memory.savedAt * 1000).toLocaleDateString()}]`];

    if (memory.outcomeScore !== null && memory.outcomeScore !== undefined) {
      lines.push(`  Outcome score: ${memory.outcomeScore}/10000 (${(memory.outcomeScore / 100).toFixed(1)}%)`);
    }

    if (memory.learnings?.length > 0) {
      lines.push("  Key learnings:");
      memory.learnings.forEach(l => lines.push(`    • ${l}`));
    }

    if (memory.preferences && Object.keys(memory.preferences).length > 0) {
      const prefs = Object.entries(memory.preferences)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      if (prefs) lines.push(`  Client preferences: ${prefs}`);
    }

    if (memory.rawFeedback) {
      lines.push(`  Recent feedback: "${memory.rawFeedback.slice(0, 200)}"`);
    }

    lines.push("  → Apply these learnings when working with this client.");
    return lines.join("\n");
  }
}
