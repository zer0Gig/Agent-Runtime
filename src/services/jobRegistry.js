/**
 * In-memory registry for active scheduler jobs
 * Persists to 0G Storage KV for recovery after restart
 * 
 * FIXED (HIGH-3): Use setKey/getKey API instead of passing keys as rootHash
 * FIXED (NEW-1): Use ESM syntax instead of CommonJS require()
 */

class JobRegistry {
  constructor(storageService) {
    this.storage = storageService;
    this.jobs = new Map();
    this.storageKey = 'scheduler:jobs';
  }

  async loadFromStorage() {
    // FIXED: Use getKey to retrieve stored rootHash, then download
    const rootHash = await this.storage.getKey(this.storageKey);
    if (!rootHash) {
      console.log('[JobRegistry] No saved jobs found (first run)');
      return;
    }
    
    try {
      const savedJobs = await this.storage.downloadData(rootHash, 'scheduler-jobs.json');
      if (savedJobs) {
        this.jobs = new Map(Object.entries(savedJobs));
        console.log(`[JobRegistry] Loaded ${this.jobs.size} jobs from storage`);
      }
    } catch (error) {
      console.error('[JobRegistry] Failed to load from storage:', error.message);
    }
  }

  async register(jobId, config) {
    this.jobs.set(jobId, config);
    await this._persist();
  }

  async unregister(jobId) {
    this.jobs.delete(jobId);
    await this._persist();
  }

  async _persist() {
    const jobsObj = Object.fromEntries(this.jobs);
    // FIXED: Upload data first to get rootHash, then store hash with setKey
    const rootHash = await this.storage.uploadData(jobsObj, 'scheduler-jobs.json');
    await this.storage.setKey(this.storageKey, rootHash);
    console.log(`[JobRegistry] Persisted ${this.jobs.size} jobs to storage (hash: ${rootHash.slice(0, 10)}...)`);
  }
}

export { JobRegistry };