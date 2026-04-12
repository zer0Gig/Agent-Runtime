import { StorageService } from "./storageService.js";

export class StateManager {
  /**
   * @param {StorageService} storageService 
   */
  constructor(storageService) {
    this.storage = storageService;
    this.cache = new Map();
    this.syncIntervalMs = 60000; // 1 minute
    this.pendingWrites = new Set();
    this.syncTimer = null;
  }

  /**
   * Initialize state for a specific job/subscription
   * @param {string} jobId 
   * @param {object} defaultState 
   */
  async initializeState(jobId, defaultState = {}) {
    let state = await this.storage.readCheckpoint(jobId);
    
    if (!state) {
      console.log(`[StateManager] No existing state for ${jobId}, initializing default.`);
      state = { ...defaultState, initializedAt: Date.now() };
      await this.storage.saveCheckpoint(jobId, state);
    } else {
      console.log(`[StateManager] Loaded existing state for ${jobId}.`);
    }
    
    this.cache.set(jobId, state);
    return state;
  }

  /**
   * Get current state (from cache)
   * @param {string} jobId 
   */
  getState(jobId) {
    return this.cache.get(jobId) || null;
  }

  /**
   * Update state and queue for persistence
   * @param {string} jobId 
   * @param {object} updates 
   */
  updateState(jobId, updates) {
    const currentState = this.cache.get(jobId) || {};
    const newState = { ...currentState, ...updates, updatedAt: Date.now() };
    
    this.cache.set(jobId, newState);
    this.pendingWrites.add(jobId);
  }

  /**
   * Force an immediate sync to 0G Storage
   * @param {string} jobId 
   */
  async forceSync(jobId) {
    const state = this.cache.get(jobId);
    if (state) {
      await this.storage.saveCheckpoint(jobId, state);
      this.pendingWrites.delete(jobId);
      console.log(`[StateManager] Synced state for ${jobId} to 0G Storage.`);
    }
  }

  /**
   * Start background sync worker
   */
  startBackgroundSync() {
    if (this.syncTimer) return;
    
    console.log(`[StateManager] Starting background sync every ${this.syncIntervalMs}ms`);
    this.syncTimer = setInterval(async () => {
      for (const jobId of this.pendingWrites) {
        try {
          await this.forceSync(jobId);
        } catch (err) {
          console.error(`[StateManager] Failed to sync ${jobId}:`, err.message);
        }
      }
    }, this.syncIntervalMs);
  }

  /**
   * Stop background sync worker
   */
  stopBackgroundSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      console.log(`[StateManager] Stopped background sync`);
    }
  }
}
