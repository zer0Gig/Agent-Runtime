import cron from 'node-cron';

class AgentScheduler {
  constructor({ storageService, alertDelivery } = {}) {
    this.jobs = new Map(); // jobId → { cronJob, lastRun, config }
    this.storage = storageService; // Store storage service instance
    this.alertDelivery = alertDelivery;
  }

  /**
   * Register a new recurring job
   * @param {string} jobId - Unique job identifier
   * @param {string} intervalCron - Cron expression (e.g., '0 * * * *' = hourly)
   * @param {Function} taskFn - Async function to execute on each tick
   * @param {object} config - Job config (subscriptionId, agentId, etc.)
   */
  async scheduleJob(jobId, intervalCron, taskFn, config = {}) {
    // Create cron job
    const cronJob = cron.schedule(intervalCron, async () => {
      console.log(`[Scheduler] Executing job ${jobId}...`);
      
      try {
        // CRITICAL FIX (HIGH-1): Read checkpoint FRESH each tick, not at setup
        // Use instance method from storageService
        const checkpoint = await this.storage?.readCheckpoint(jobId) || null;
        
        // Execute task with fresh checkpoint
        const result = await taskFn(checkpoint);
        
        // Save new checkpoint with updated state
        await this.storage?.saveCheckpoint(jobId, {
          ...checkpoint,
          lastRun: Date.now(),
          lastResult: result,
        });
        
        // Check for anomaly → trigger alert
        if (this._detectAnomaly(result, config)) {
          await this._triggerAlert(jobId, result, config);
        }
        
      } catch (error) {
        console.error(`[Scheduler] Job ${jobId} failed:`, error);
        // Read current checkpoint to preserve existing state
        const checkpoint = await this.storage?.readCheckpoint(jobId) || null;
        // Save error state
        await this.storage?.saveCheckpoint(jobId, {
          ...checkpoint,
          lastError: error.message,
          errorTimestamp: Date.now(),
        });
      }
    }, {
      scheduled: true,
      timezone: 'UTC',
    });

    // Store job reference
    this.jobs.set(jobId, {
      cronJob,
      config,
      createdAt: Date.now(),
    });

    console.log(`[Scheduler] Job ${jobId} scheduled with cron "${intervalCron}"`);
  }

  /**
   * Stop and remove a job
   */
  async cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (job) {
      job.cronJob.stop();
      this.jobs.delete(jobId);
      console.log(`[Scheduler] Job ${jobId} cancelled`);
    }
  }

  /**
   * Get job status
   * Note: node-cron doesn't expose a getStatus() method, so we track running state manually
   */
  getJobStatus(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    
    return {
      jobId,
      running: true, // Cron task is active (node-cron doesn't expose status API)
      config: job.config,
      createdAt: job.createdAt,
    };
  }

  /**
   * Get all active jobs
   */
  getAllJobs() {
    return Array.from(this.jobs.entries()).map(([jobId, job]) => ({
      jobId,
      ...this.getJobStatus(jobId),
    }));
  }

  // Private helpers
  _detectAnomaly(result, config) {
    // Implement anomaly detection logic based on config
    // Example: if result.value < config.threshold → anomaly
    return false; // Placeholder
  }

  async _triggerAlert(jobId, result, config) {
    if (!this.alertDelivery) {
      console.warn(`[Scheduler] No alert delivery system configured for job ${jobId}`);
      return;
    }

    try {
      // Extract subscription ID from job ID (format: sub-{subscriptionId})
      const subscriptionId = jobId.startsWith('sub-') ? jobId.substring(4) : jobId;

      // Send anomaly detected alert
      await this.alertDelivery.sendAnomalyDetected(
        subscriptionId,
        config.agentId || 'unknown',
        result.type || 'monitoring',
        result.threshold || 0,
        result.value || 0
      );

      console.log(`[Scheduler] Alert successfully delivered for job ${jobId}`);
    } catch (error) {
      console.error(`[Scheduler] Failed to deliver alert for job ${jobId}:`, error.message);
    }
  }
}

export { AgentScheduler };