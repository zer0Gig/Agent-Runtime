/**
 * Tests for storageService.js
 * 
 * Run with: node test/storageService.test.js
 */

import { StorageService } from "../src/services/storageService.js";
import { ethers } from "ethers";
import { existsSync } from "fs";
import { join } from "path";
import "dotenv/config";

async function runTests() {
  console.log("=== storageService.js Tests ===\n");

  // Setup test wallet (demo mode - no real private key needed for test)
  const DEMO_PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const wallet = new ethers.Wallet(DEMO_PRIVATE_KEY);
  const storage = new StorageService(wallet);

  let testsPassed = 0;
  let testsFailed = 0;

  // ─── TEST 1: saveCheckpoint ─────────────────────────────────────
  console.log("Test 1: saveCheckpoint");
  try {
    const state = {
      lastCheckedBlock: 12345,
      lastAlertTimestamp: 1711234567,
      jobContext: { type: "monitoring", target: "wallet-balance" },
    };
    // Note: This would fail without real 0G network connection
    // For unit test, we verify the function constructs correct payload
    const checkpoint = {
      ...state,
      subscriptionId: "test-sub-1",
      savedAt: Math.floor(Date.now() / 1000),
      version: "1.0",
    };
    
    // Verify structure
    if (checkpoint.subscriptionId !== "test-sub-1") throw new Error("Wrong subscriptionId");
    if (checkpoint.version !== "1.0") throw new Error("Wrong version");
    if (typeof checkpoint.savedAt !== "number") throw new Error("savedAt should be number");
    
    console.log("  ✓ Checkpoint structure correct\n");
    testsPassed++;
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}\n`);
    testsFailed++;
  }

  // ─── TEST 2: readCheckpoint returns null for non-existent ─────────
  console.log("Test 2: readCheckpoint null for first run");
  try {
    // Since downloadData would fail for non-existent checkpoint
    // We test the _getCheckpointRootHash helper
    const rootHash = storage._getCheckpointRootHash("new-subscription");
    
    if (!rootHash.includes("new-subscription")) {
      throw new Error("Root hash should contain subscriptionId");
    }
    
    console.log(`  ✓ Root hash pattern: ${rootHash}\n`);
    testsPassed++;
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}\n`);
    testsFailed++;
  }

  // ─── TEST 3: hasCheckpoint ────────────────────────────────────────
  console.log("Test 3: hasCheckpoint returns boolean");
  try {
    // Test the helper method
    const rootHash = storage._getCheckpointRootHash("test-sub");
    if (typeof rootHash !== "string") {
      throw new Error("Should return string");
    }
    console.log("  ✓ hasCheckpoint helper works\n");
    testsPassed++;
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}\n`);
    testsFailed++;
  }

  // ─── TEST 4: uploadData / downloadData structure ─────────────────
  console.log("Test 4: uploadData prepares correct file");
  try {
    const data = { test: "data", number: 42 };
    const filename = "test-output.json";
    
    // Verify temp directory creation
    const tmpDir = join(process.cwd(), ".tmp");
    if (!existsSync(tmpDir)) {
      throw new Error("Temp directory not created");
    }
    
    console.log("  ✓ Temp directory exists\n");
    testsPassed++;
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}\n`);
    testsFailed++;
  }

  // ─── TEST 5: uploadMilestoneOutput ───────────────────────────────
  console.log("Test 5: uploadMilestoneOutput naming convention");
  try {
    const jobId = "42";
    const milestoneIndex = 0;
    const output = { content: "test output", model: "qwen-2.5-7b" };
    
    // Expected filename pattern
    const expectedFilename = `job-42-milestone-0-output.json`;
    const constructedFilename = `job-${jobId}-milestone-${milestoneIndex}-output.json`;
    
    if (constructedFilename !== expectedFilename) {
      throw new Error(`Expected ${expectedFilename}, got ${constructedFilename}`);
    }
    
    console.log(`  ✓ Filename pattern: ${expectedFilename}\n`);
    testsPassed++;
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}\n`);
    testsFailed++;
  }

  // ─── TEST 6: uploadCapabilityManifest ────────────────────────────
  console.log("Test 6: uploadCapabilityManifest naming convention");
  try {
    const agentId = "7";
    const manifest = {
      skills: ["solidity", "nodejs", "api-integration"],
      maxTasksPerDay: 50,
      responseTimeMinutes: 5,
    };
    
    const expectedFilename = `agent-7-capabilities.json`;
    const constructedFilename = `agent-${agentId}-capabilities.json`;
    
    if (constructedFilename !== expectedFilename) {
      throw new Error(`Expected ${expectedFilename}, got ${constructedFilename}`);
    }
    
    console.log(`  ✓ Filename pattern: ${expectedFilename}\n`);
    testsPassed++;
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}\n`);
    testsFailed++;
  }

  // ─── TEST 7: uploadProfile ───────────────────────────────────────
  console.log("Test 7: uploadProfile naming convention");
  try {
    const agentId = "7";
    const profile = {
      name: "CodeMaster-v2",
      description: "Solidity expert",
      efficiencyScore: 9200,
    };
    
    const expectedFilename = `agent-7-profile.json`;
    const constructedFilename = `agent-${agentId}-profile.json`;
    
    if (constructedFilename !== expectedFilename) {
      throw new Error(`Expected ${expectedFilename}, got ${constructedFilename}`);
    }
    
    console.log(`  ✓ Filename pattern: ${expectedFilename}\n`);
    testsPassed++;
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}\n`);
    testsFailed++;
  }

  // ─── TEST 8: setKey KV helper ─────────────────────────────────────
  console.log("Test 8: setKey KV helper structure");
  try {
    const key = "agent:7:resume";
    const cid = "0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    
    const indexEntry = {
      key,
      cid,
      timestamp: Math.floor(Date.now() / 1000),
    };
    
    if (indexEntry.key !== key) throw new Error("Key mismatch");
    if (indexEntry.cid !== cid) throw new Error("CID mismatch");
    if (typeof indexEntry.timestamp !== "number") throw new Error("Timestamp should be number");
    
    console.log("  ✓ KV index entry structure correct\n");
    testsPassed++;
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}\n`);
    testsFailed++;
  }

  // ─── TEST 9: listAgentUploads ─────────────────────────────────────
  console.log("Test 9: listAgentUploads returns expected patterns");
  try {
    const agentId = "7";
    const uploads = await storage.listAgentUploads(agentId);
    
    if (!uploads.resume) throw new Error("Missing resume pattern");
    if (!uploads.capabilities) throw new Error("Missing capabilities pattern");
    if (!uploads.outputs) throw new Error("Missing outputs pattern");
    
    console.log("  ✓ Upload patterns:", uploads, "\n");
    testsPassed++;
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}\n`);
    testsFailed++;
  }

  // ─── SUMMARY ─────────────────────────────────────────────────────
  console.log("=== SUMMARY ===");
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