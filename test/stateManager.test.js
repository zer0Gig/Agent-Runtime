import { StateManager } from "../src/services/stateManager.js";
import { StorageService } from "../src/services/storageService.js";
import { ethers } from "ethers";

// Mocking the StorageService
class MockStorageService {
  constructor() {
    this.store = new Map();
  }
  async saveCheckpoint(jobId, state) {
    this.store.set(jobId, state);
    return "mock-cid-123";
  }
  async readCheckpoint(jobId) {
    return this.store.get(jobId) || null;
  }
}

async function runTests() {
  console.log("=== stateManager.js Tests ===\n");
  
  let testsPassed = 0;
  let testsFailed = 0;

  const mockStorage = new MockStorageService();
  const stateManager = new StateManager(mockStorage);
  
  // Disable console.log for cleaner test output
  const originalLog = console.log;
  console.log = () => {};

  // ─── TEST 1: initializeState ─────────────────────────────────────
  try {
    const defaultState = { foo: "bar", count: 0 };
    const state = await stateManager.initializeState("job-1", defaultState);
    
    if (state.foo !== "bar" || state.count !== 0) throw new Error("Default state not set correctly");
    if (!state.initializedAt) throw new Error("initializedAt missing");
    
    const cachedState = stateManager.getState("job-1");
    if (!cachedState) throw new Error("State not cached");
    
    originalLog("Test 1: initializeState -> ✓ Correctly initialized and cached");
    testsPassed++;
  } catch (err) {
    originalLog(`Test 1: initializeState -> ✗ Failed: ${err.message}`);
    testsFailed++;
  }

  // ─── TEST 2: updateState (deferred sync) ─────────────────────────
  try {
    stateManager.updateState("job-1", { count: 1 });
    
    const cachedState = stateManager.getState("job-1");
    if (cachedState.count !== 1) throw new Error("Cache not updated");
    if (!stateManager.pendingWrites.has("job-1")) throw new Error("job-1 not in pending writes");
    
    const storedState = await mockStorage.readCheckpoint("job-1");
    if (storedState.count === 1) throw new Error("State was synced prematurely");
    
    originalLog("Test 2: updateState -> ✓ Correctly deferred network write");
    testsPassed++;
  } catch (err) {
    originalLog(`Test 2: updateState -> ✗ Failed: ${err.message}`);
    testsFailed++;
  }

  // ─── TEST 3: forceSync ───────────────────────────────────────────
  try {
    await stateManager.forceSync("job-1");
    
    if (stateManager.pendingWrites.has("job-1")) throw new Error("job-1 still in pending writes");
    
    const storedState = await mockStorage.readCheckpoint("job-1");
    if (storedState.count !== 1) throw new Error("Storage not updated");
    if (!storedState.updatedAt) throw new Error("updatedAt missing");
    
    originalLog("Test 3: forceSync -> ✓ Correctly wrote to storage");
    testsPassed++;
  } catch (err) {
    originalLog(`Test 3: forceSync -> ✗ Failed: ${err.message}`);
    testsFailed++;
  }

  // ─── TEST 4: load existing state ─────────────────────────────────
  try {
    const existingState = { foo: "baz", existing: true };
    mockStorage.store.set("job-2", existingState);
    
    const state = await stateManager.initializeState("job-2", { foo: "bar" });
    if (state.foo !== "baz") throw new Error("Did not load existing state");
    if (!state.existing) throw new Error("Did not load existing state completely");
    
    originalLog("Test 4: load existing state -> ✓ Correctly loaded existing state");
    testsPassed++;
  } catch (err) {
    originalLog(`Test 4: load existing state -> ✗ Failed: ${err.message}`);
    testsFailed++;
  }

  // Restore console.log
  console.log = originalLog;

  console.log("\n=== SUMMARY ===");
  console.log(`Passed: ${testsPassed}/${testsPassed + testsFailed}`);
  console.log(`Failed: ${testsFailed}/${testsPassed + testsFailed}`);
  
  if (testsFailed === 0) {
    console.log("\n✓ All tests passed!");
    process.exit(0);
  } else {
    console.log("\n✗ Some tests failed.");
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
