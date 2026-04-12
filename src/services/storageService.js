/**
 * 0G Storage Service — Decentralized File & KV Storage
 *
 * Uses 0G Storage SDK for uploading/downloading job data,
 * agent outputs, and capability manifests.
 */

import { Indexer, ZgFile } from "@0gfoundation/0g-ts-sdk";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const INDEXER_RPC =
  process.env.OG_INDEXER_RPC ||
  "https://indexer-storage-testnet-turbo.0g.ai";
const EVM_RPC =
  process.env.OG_NEWTON_RPC || "https://evmrpc-testnet.0g.ai";

export class StorageService {
  constructor(signer) {
    this.signer = signer;
    this.indexer = new Indexer(INDEXER_RPC);
    this.tmpDir = join(process.cwd(), ".tmp");

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
    return this.uploadData(checkpoint, `checkpoint-${subscriptionId}.json`);
  }

  /**
   * Read checkpoint state for a subscription/scheduled job
   * @param {string} subscriptionId - The subscription/job identifier
   * @returns {Promise<object|null>} Checkpoint state or null if not found
   */
  async readCheckpoint(subscriptionId) {
    try {
      const data = await this.downloadData(
        this._getCheckpointRootHash(subscriptionId),
        `checkpoint-${subscriptionId}.json`
      );
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
    try {
      await this.readCheckpoint(subscriptionId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the storage root hash for a checkpoint
   * In production, this would be stored on-chain or in a KV index
   * For hackathon demo, we use a deterministic hash pattern
   */
  _getCheckpointRootHash(subscriptionId) {
    // For now, return a placeholder — in production this would query an index
    // or be stored as metadata in the subscription contract
    return `checkpoint-${subscriptionId}`;
  }

  // ─── INDEX / KV HELPERS ────────────────────────────────────────────────

  /**
   * Store a key-value mapping for quick lookups
   * Used to track CIDs by human-readable keys
   * @param {string} key - Human-readable key (e.g., "agent:7:resume")
   * @param {string} cid - The 0G Storage CID
   * @returns {Promise<string>} CID of the index entry
   */
  async setKey(key, cid) {
    const indexEntry = {
      key,
      cid,
      timestamp: Math.floor(Date.now() / 1000),
    };
    return this.uploadData(indexEntry, `kv-${key.replace(/:/g, "-")}.json`);
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
}
