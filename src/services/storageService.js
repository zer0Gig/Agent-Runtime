/**
 * 0G Storage Service — Decentralized File & KV Storage
 *
 * Uses 0G Storage SDK for uploading/downloading job data,
 * agent outputs, and capability manifests.
 */

import { Indexer, ZgFile } from "@0gfoundation/0g-ts-sdk";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const INDEXER_RPC =
  process.env.OG_INDEXER_RPC ||
  "https://indexer-storage-testnet-turbo.0g.ai";
const EVM_RPC =
  process.env.OG_NEWTON_RPC || "https://evmrpc-testnet.0g.ai";

export class StorageService {
  constructor(signer) {
    this.signer = signer;
    this.indexer = new Indexer(INDEXER_RPC);
    // Use OS temp dir so it works on Railway (ephemeral /app) and locally
    this.tmpDir = process.env.TMP_DIR || join(tmpdir(), "zer0gig");

    // NEW-2 FIX: In-memory KV index for demo (survives within process lifetime)
    this._kvIndex = new Map();

    if (!existsSync(this.tmpDir)) {
      mkdirSync(this.tmpDir, { recursive: true });
    }

    console.log("[Storage] Initialized with indexer:", INDEXER_RPC);
  }

  /**
   * Upload a string/JSON to 0G Storage, returns the root hash (CID)
   */
  async uploadData(data, filename = "output.json") {
    const filePath = join(this.tmpDir, filename);

    // Write data to temp file
    const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    writeFileSync(filePath, content, "utf-8");

    console.log(`[Storage] Uploading ${filename} (${content.length} bytes)...`);

    // Create ZgFile and upload
    const file = await ZgFile.fromFilePath(filePath);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr) {
      await file.close();
      throw new Error(`Merkle tree error: ${treeErr}`);
    }

    const rootHash = tree.rootHash();
    console.log(`[Storage] Root hash: ${rootHash}`);

    const [tx, uploadErr] = await this.indexer.upload(
      file,
      EVM_RPC,
      this.signer
    );
    await file.close();

    if (uploadErr) {
      throw new Error(`Upload error: ${uploadErr}`);
    }

    console.log(`[Storage] Upload successful! TX: ${tx}`);
    return rootHash;
  }

  /**
   * Download data from 0G Storage by root hash
   */
  async downloadData(rootHash, filename = "download.json") {
    // Inline-encoded brief (txt:base64) — decode directly, no network call needed
    if (rootHash && rootHash.startsWith("txt:")) {
      console.log(`[Storage] Decoding inline txt brief...`);
      const text = Buffer.from(rootHash.slice(4), "base64").toString("utf-8");
      try {
        return JSON.parse(text);
      } catch {
        return { task: text };
      }
    }

    const outputPath = join(this.tmpDir, filename);

    console.log(`[Storage] Downloading ${rootHash}...`);

    const err = await this.indexer.download(rootHash, outputPath, true);
    if (err) {
      throw new Error(`Download error: ${err}`);
    }

    const content = readFileSync(outputPath, "utf-8");
    console.log(`[Storage] Downloaded ${content.length} bytes.`);

    // Try parsing as JSON, fallback to raw string
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  /**
   * Upload agent capability manifest to 0G Storage
   */
  async uploadCapabilityManifest(agentId, manifest) {
    return this.uploadData(manifest, `agent-${agentId}-capabilities.json`);
  }

  /**
   * Upload agent profile to 0G Storage
   */
  async uploadProfile(agentId, profile) {
    return this.uploadData(profile, `agent-${agentId}-profile.json`);
  }

  /**
   * Upload milestone output to 0G Storage
   */
  async uploadMilestoneOutput(jobId, milestoneIndex, output) {
    return this.uploadData(
      output,
      `job-${jobId}-milestone-${milestoneIndex}-output.json`
    );
  }

  // ─── CHECKPOINT METHODS (for scheduler persistence) ─────────────────────

  /**
   * Save checkpoint state for a subscription/scheduled job
   * Key pattern: checkpoint:{subscriptionId}
   * Stores the root hash in KV index for retrieval
   * @param {string} subscriptionId - The subscription/job identifier
   * @param {object} state - Checkpoint state (lastCheckedBlock, lastAlertTimestamp, context, etc.)
   * @returns {Promise<string>} CID of the uploaded checkpoint
   */
  async saveCheckpoint(subscriptionId, state) {
    const checkpoint = {
      ...state,
      subscriptionId,
      savedAt: Math.floor(Date.now() / 1000),
      version: "1.0",
    };
    const rootHash = await this.uploadData(checkpoint, `checkpoint-${subscriptionId}.json`);
    // CRIT-2 FIX: Store the real root hash in KV index
    await this.setKey(`checkpoint:${subscriptionId}`, rootHash);
    return rootHash;
  }

  /**
   * Read checkpoint state for a subscription/scheduled job
   * @param {string} subscriptionId - The subscription/job identifier
   * @returns {Promise<object|null>} Checkpoint state or null if not found
   */
  async readCheckpoint(subscriptionId) {
    try {
      // CRIT-2 FIX: Get the real root hash from KV index
      const rootHash = await this._getCheckpointRootHash(subscriptionId);
      if (!rootHash) {
        console.log(`[Storage] No checkpoint hash stored for ${subscriptionId}, starting fresh.`);
        return null;
      }
      const data = await this.downloadData(rootHash, `checkpoint-${subscriptionId}.json`);
      return data;
    } catch (err) {
      // First run — no checkpoint exists yet
      if (err.message?.includes("not found") || err.message?.includes("404")) {
        console.log(`[Storage] No checkpoint found for ${subscriptionId}, starting fresh.`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Check if a checkpoint exists for a subscription
   * @param {string} subscriptionId - The subscription/job identifier
   * @returns {Promise<boolean>}
   */
  async hasCheckpoint(subscriptionId) {
    const checkpoint = await this.readCheckpoint(subscriptionId);
    return checkpoint !== null;
  }

  /**
   * Get the storage root hash for a checkpoint
   * Retrieves from KV index where it was stored by saveCheckpoint
   * @param {string} subscriptionId - The subscription identifier
   * @returns {Promise<string|null>} Root hash or null if not found
   */
  async _getCheckpointRootHash(subscriptionId) {
    // CRIT-2 FIX: Retrieve the real root hash from KV index
    return this.getKey(`checkpoint:${subscriptionId}`);
  }

  // ─── TASK #4 SPEC FUNCTIONS ────────────────────────────────────────────
  // Simplified wrappers for job output storage (as per Task #4 specification)

  /**
   * Upload job output data to 0G Storage
   * Stores CID in KV index for retrieval by downloadOutput
   * @param {string} jobId - The job identifier
   * @param {any} data - JSON-serializable data to upload
   * @returns {Promise<string>} Storage CID
   */
  async uploadOutput(jobId, data) {
    console.log(`[Storage] Uploading output for job ${jobId}...`);
    const rootHash = await this.uploadData(data, `output-${jobId}.json`);
    // MED-2 FIX: Store the CID in KV index for retrieval
    await this.setKey(`output:${jobId}`, rootHash);
    return rootHash;
  }

  /**
   * Download job output data from 0G Storage
   * @param {string} jobId - The job identifier
   * @returns {Promise<object|null>} Parsed data or null if not found
   */
  async downloadOutput(jobId) {
    console.log(`[Storage] Downloading output for job ${jobId}...`);
    try {
      // In production, we'd query a KV index to get the CID by jobId
      // For now, use a deterministic pattern
      const cid = await this._getOutputCID(jobId);
      if (!cid) return null;
      return await this.downloadData(cid, `output-${jobId}.json`);
    } catch (err) {
      if (err.message?.includes("not found") || err.message?.includes("404")) {
        console.log(`[Storage] No output found for job ${jobId}`);
        return null;
      }
      throw err;
    }
  }

  // ─── INDEX / KV HELPERS ────────────────────────────────────────────────

  /**
   * Store a key-value mapping for quick lookups
   * Uses in-memory Map for fast retrieval (demo mode)
   * Also uploads to 0G Storage for persistence (best effort)
   * @param {string} key - Human-readable key (e.g., "agent:7:resume")
   * @param {string} cid - The 0G Storage CID
   * @returns {Promise<string>} CID of the index entry
   */
  async setKey(key, cid) {
    // NEW-2 FIX: Store in memory for immediate retrieval
    this._kvIndex.set(key, cid);
    
    // Also upload to 0G Storage for persistence (best effort)
    const indexEntry = {
      key,
      cid,
      timestamp: Math.floor(Date.now() / 1000),
    };
    return this.uploadData(indexEntry, `kv-${key.replace(/:/g, "-")}.json`);
  }

  /**
   * Get CID by key from KV index
   * Uses in-memory Map for fast retrieval (demo mode)
   * @param {string} key - Human-readable key
   * @returns {Promise<string|null>} CID or null if not found
   */
  async getKey(key) {
    // NEW-2 FIX: Retrieve from in-memory Map (works within process lifetime)
    const cid = this._kvIndex.get(key);
    if (cid) {
      return cid;
    }
    
    // Fallback: try to load from 0G Storage (not implemented for demo)
    // In production, this would query an on-chain KV index
    return null;
  }

  /**
   * Get the storage CID for a job output
   * In production, this queries a KV index or on-chain registry
   * For hackathon demo, uses deterministic pattern
   * @param {string} jobId - The job identifier
   * @returns {Promise<string|null>} CID or null if not found
   */
  async _getOutputCID(jobId) {
    // Try to fetch from KV index first
    const key = `output:${jobId}`;
    const cid = await this.getKey(key);
    if (cid) return cid;

    // Fallback: return deterministic pattern (for demo/testing)
    // In production, this would be stored on-chain or in a proper KV index
    return null;
  }

  /**
   * List all uploads for an agent (from local index)
   * This is a helper for dashboard display
   */
  async listAgentUploads(agentId) {
    // In production, this would query an on-chain index or KV store
    // For now, return the expected file patterns
    return {
      resume: `agent-${agentId}-profile.json`,
      capabilities: `agent-${agentId}-capabilities.json`,
      outputs: `agent-${agentId}-outputs.json`,
    };
  }

  // ─── PHASE 1: 0G KV LAYER ──────────────────────────────────────────────

  /**
   * Store a key-value pair in 0G KV layer via Batcher.
   * Also mirrors to in-memory KV for fast local retrieval.
   *
   * @param {string} streamId - The KV stream namespace (e.g., "agent:7:memories")
   * @param {string} key      - Human-readable key
   * @param {any}    value    - JSON-serializable value
   * @returns {Promise<string>} CID of the index entry
   */
  async kvSet(streamId, key, value) {
    // Mirror to in-memory for fast local reads
    const memKey = `kv:${streamId}:${key}`;
    this._kvIndex.set(memKey, value);

    // Upload a structured KV entry to 0G immutable log
    const entry = {
      streamId,
      key,
      value,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const rootHash = await this.uploadData(entry, `kv-${streamId.replace(/:/g, "-")}-${key.replace(/:/g, "-")}.json`);

    // Update the index for this stream
    const indexKey = `kv_index:${streamId}`;
    const index = await this.kvListIndex(streamId);
    index[key] = rootHash;
    await this.uploadData(index, `kv-index-${streamId.replace(/:/g, "-")}.json`);

    return rootHash;
  }

  /**
   * Retrieve a value from 0G KV layer.
   * Checks in-memory cache first, then downloads from 0G.
   *
   * @param {string} streamId - The KV stream namespace
   * @param {string} key      - Human-readable key
   * @returns {Promise<any>} Stored value or null
   */
  async kvGet(streamId, key) {
    // Check in-memory cache first
    const memKey = `kv:${streamId}:${key}`;
    const cached = this._kvIndex.get(memKey);
    if (cached !== undefined) return cached;

    // Try to get from 0G via index
    try {
      const index = await this.kvListIndex(streamId);
      const rootHash = index[key];
      if (!rootHash) return null;

      const data = await this.downloadData(rootHash, `kv-${streamId.replace(/:/g, "-")}-${key.replace(/:/g, "-")}.json`);
      const value = data?.value ?? data; // handle both wrapped and raw formats

      // Cache for next time
      if (value !== null) this._kvIndex.set(memKey, value);

      return value;
    } catch (err) {
      console.warn(`[Storage] kvGet failed for ${streamId}:${key}: ${err.message}`);
      return null;
    }
  }

  /**
   * Get the KV index for a stream from 0G Storage.
   */
  async kvListIndex(streamId) {
    try {
      const data = await this.downloadData(`kv-index-${streamId.replace(/:/g, "-")}.json`);
      return data || {};
    } catch {
      return {};
    }
  }

  // ─── PHASE 2: SUBSCRIPTION EXECUTION LOGS ──────────────────────────────

  /**
   * Append an execution log entry to 0G immutable log layer.
   * Each entry is stored independently with a Merkle root hash for verification.
   *
   * @param {string} subscriptionId - The subscription/job identifier
   * @param {object} logEntry       - Log data (phase, input, output, tools, etc.)
   * @returns {Promise<string>} Root hash (CID) of the uploaded log entry
   */
  async appendExecutionLog(subscriptionId, logEntry) {
    const entry = {
      ...logEntry,
      subscriptionId,
      loggedAt: Math.floor(Date.now() / 1000),
      version: "1.0",
    };

    const filename = `sub-${subscriptionId}-log-${entry.loggedAt}-${Math.random().toString(36).slice(2, 8)}.json`;
    const rootHash = await this.uploadData(entry, filename);

    // Update execution log index
    const index = await this.listExecutionLogs(subscriptionId);
    index.push({
      rootHash,
      timestamp: entry.loggedAt,
      phase: entry.phase,
    });
    await this.uploadData(index, `sub-${subscriptionId}-log-index.json`);

    console.log(`[Storage] Execution log appended: sub=${subscriptionId} rootHash=${rootHash.slice(0, 12)}…`);
    return rootHash;
  }

  /**
   * List all execution logs for a subscription.
   * Returns array of { rootHash, timestamp, phase } sorted by timestamp.
   *
   * @param {string} subscriptionId - The subscription/job identifier
   * @returns {Promise<Array>} Array of log metadata
   */
  async listExecutionLogs(subscriptionId) {
    try {
      const data = await this.downloadData(`sub-${subscriptionId}-log-index.json`);
      if (Array.isArray(data)) {
        return data.sort((a, b) => a.timestamp - b.timestamp);
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Get the latest execution result for a subscription.
   * Downloads the full log entry from 0G Storage.
   *
   * @param {string} subscriptionId - The subscription/job identifier
   * @returns {Promise<object|null>} Full log entry or null
   */
  async getLatestExecution(subscriptionId) {
    const logs = await this.listExecutionLogs(subscriptionId);
    if (logs.length === 0) return null;

    const latest = logs[logs.length - 1];
    try {
      return await this.downloadData(latest.rootHash, `latest-sub-${subscriptionId}.json`);
    } catch (err) {
      console.warn(`[Storage] getLatestExecution failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Get the full execution history for a subscription.
   * Downloads all log entries from 0G Storage.
   *
   * @param {string} subscriptionId - The subscription/job identifier
   * @param {number} limit          - Max entries to return (default: 20)
   * @returns {Promise<Array>} Array of full log entries
   */
  async getExecutionHistory(subscriptionId, limit = 20) {
    const logs = await this.listExecutionLogs(subscriptionId);
    const recent = logs.slice(-limit);
    const results = [];

    for (const log of recent) {
      try {
        const entry = await this.downloadData(log.rootHash, `hist-sub-${subscriptionId}-${log.timestamp}.json`);
        results.push(entry);
      } catch {
        results.push({ rootHash: log.rootHash, phase: log.phase, timestamp: log.timestamp, error: "Download failed" });
      }
    }

    return results;
  }

  // ─── PHASE 3: ESCROW EVENT HISTORY ─────────────────────────────────────

  /**
   * Append an escrow event to 0G immutable log layer.
   * Events from ProgressiveEscrow and SubscriptionEscrow are stored separately.
   *
   * @param {string} contractType - "ProgressiveEscrow" or "SubscriptionEscrow"
   * @param {string} eventType    - e.g., "MilestoneReleased", "SubscriptionCreated"
   * @param {object} data         - Event-specific data (jobId, amount, txHash, etc.)
   * @returns {Promise<string>} Root hash (CID) of the uploaded event
   */
  async appendEscrowEvent(contractType, eventType, data) {
    const entry = {
      contractType,
      eventType,
      ...data,
      loggedAt: Math.floor(Date.now() / 1000),
      version: "1.0",
    };

    const filename = `event-${contractType}-${eventType}-${entry.loggedAt}-${Math.random().toString(36).slice(2, 6)}.json`;
    const rootHash = await this.uploadData(entry, filename);

    // Update event index
    const index = await this.listEscrowEvents(contractType);
    index.push({
      rootHash,
      eventType,
      timestamp: entry.loggedAt,
    });
    await this.uploadData(index, `event-index-${contractType}.json`);

    console.log(`[Storage] Escrow event logged: ${contractType}.${eventType} rootHash=${rootHash.slice(0, 12)}…`);
    return rootHash;
  }

  /**
   * List all escrow events for a contract type.
   *
   * @param {string} contractType - "ProgressiveEscrow" or "SubscriptionEscrow"
   * @returns {Promise<Array>} Array of { rootHash, eventType, timestamp }
   */
  async listEscrowEvents(contractType) {
    try {
      const data = await this.downloadData(`event-index-${contractType}.json`);
      if (Array.isArray(data)) {
        return data.sort((a, b) => a.timestamp - b.timestamp);
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Get events filtered by job or subscription ID.
   *
   * @param {string} contractType - "ProgressiveEscrow" or "SubscriptionEscrow"
   * @param {string} targetId     - Job ID or Subscription ID to filter by
   * @returns {Promise<Array>} Array of full event entries
   */
  async getEventsForJob(contractType, targetId) {
    const events = await this.listEscrowEvents(contractType);
    const results = [];
    const targetStr = targetId.toString();

    for (const event of events) {
      try {
        const data = await this.downloadData(event.rootHash, `event-${contractType}-${event.timestamp}.json`);
        // Match by any of these fields
        if (
          data.jobId === targetStr ||
          data.subscriptionId === targetStr ||
          String(data.jobId) === targetStr ||
          String(data.subscriptionId) === targetStr
        ) {
          results.push(data);
        }
      } catch {
        // Skip corrupted entries
      }
    }

    return results;
  }

  /**
   * Get the latest N events of a specific type.
   *
   * @param {string} contractType - "ProgressiveEscrow" or "SubscriptionEscrow"
   * @param {string} eventType    - e.g., "MilestoneReleased"
   * @param {number} limit        - Max events to return
   * @returns {Promise<Array>} Array of full event entries
   */
  async getLatestEvents(contractType, eventType, limit = 10) {
    const events = await this.listEscrowEvents(contractType);
    const matching = events.filter(e => e.eventType === eventType).slice(-limit);
    const results = [];

    for (const event of matching) {
      try {
        const data = await this.downloadData(event.rootHash, `event-${eventType}-${event.timestamp}.json`);
        results.push(data);
      } catch {
        // Skip corrupted entries
      }
    }

    return results;
  }
}
