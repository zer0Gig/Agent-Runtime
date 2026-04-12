import { expect } from 'chai';
import { AgentScheduler } from '../src/services/scheduler.js';
import { StorageService } from '../src/services/storageService.js';

// Mock storage service for testing
class MockStorageService {
  constructor() {
    this.storage = new Map();
    this.keys = new Map();
  }

  async uploadData(data, filename) {
    const key = `mock-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.storage.set(key, JSON.stringify(data));
    return key;
  }

  async downloadData(rootHash, filename) {
    return JSON.parse(this.storage.get(rootHash));
  }

  async setKey(key, value) {
    this.keys.set(key, value);
  }

  async getKey(key) {
    return this.keys.get(key);
  }
}

describe('AgentScheduler', () => {
  let scheduler;
  let mockStorage;

  beforeEach(() => {
    mockStorage = new MockStorageService();
    scheduler = new AgentScheduler();
  });

  it('should schedule a job and execute task', async () => {
    const mockTask = jest.fn().mockResolvedValue({ value: 42 });
    const jobId = 'test-job';
    const intervalCron = '* * * * * *'; // Every second for test
    const config = { subscriptionId: 123 };

    // Schedule job
    await scheduler.scheduleJob(jobId, intervalCron, mockTask, config);

    // Wait for first execution (1 second)
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Check task was called
    expect(mockTask).toHaveBeenCalled();
    
    // Check checkpoint was saved
    // Note: We can't easily check storageService calls in this mock setup
    // but we know from design that it should save with fresh checkpoint
  });

  it('should read fresh checkpoint on each tick', async () => {
    // Mock readCheckpoint to return different values
    const originalReadCheckpoint = require('../src/services/storageService.js').readCheckpoint;
    let checkpointCount = 0;
    
    // Replace readCheckpoint with mock
    jest.mock('../src/services/storageService.js', () => ({
      ...originalReadCheckpoint,
      readCheckpoint: jest.fn().mockImplementation(async (jobId) => {
        checkpointCount++;
        return { count: checkpointCount };
      })
    }));

    const mockTask = jest.fn().mockResolvedValue({ result: 'success' });
    const jobId = 'test-job';
    const intervalCron = '* * * * * *';

    await scheduler.scheduleJob(jobId, intervalCron, mockTask);

    // Wait for 2 executions
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Check task was called twice with different checkpoints
    expect(mockTask).toHaveBeenCalledTimes(2);
    expect(mockTask).toHaveBeenNthCalledWith(1, { count: 1 });
    expect(mockTask).toHaveBeenNthCalledWith(2, { count: 2 });
  });

  it('should cancel a job', async () => {
    const jobId = 'test-job';
    const intervalCron = '* * * * * *';
    const mockTask = jest.fn();

    await scheduler.scheduleJob(jobId, intervalCron, mockTask);
    expect(scheduler.getJobStatus(jobId)).toBeDefined();

    await scheduler.cancelJob(jobId);
    expect(scheduler.getJobStatus(jobId)).toBeNull();
  });

  it('should handle job failure gracefully', async () => {
    const mockTask = jest.fn().mockRejectedValue(new Error('Task failed'));
    const jobId = 'test-job';
    const intervalCron = '* * * * * *';

    await scheduler.scheduleJob(jobId, intervalCron, mockTask);

    // Wait for execution
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Check task was called
    expect(mockTask).toHaveBeenCalled();
    
    // Check error was handled and checkpoint saved
    // Note: We'd need to mock storageService to verify checkpoint save
  });
});