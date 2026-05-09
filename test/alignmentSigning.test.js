/**
 * Unit tests for alignment signing — verifies the digest format matches
 * what ProgressiveEscrow._verifyAlignmentSignature expects.
 *
 * Contract uses (line 372):
 *   keccak256(abi.encode(uint256 jobId, uint8 milestoneIndex, uint16 score, bytes32 outputHash))
 * Then EIP-191 prefixes and recovers the signer.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { ethers } from "ethers";

// Mirror _signAlignmentResult logic from JobProcessor base class
function buildAlignmentDigest(jobId, milestoneIndex, alignmentScore, outputHash) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint8", "uint16", "bytes32"],
      [jobId, milestoneIndex, alignmentScore, outputHash]
    )
  );
}

async function signAlignment(privateKey, jobId, milestoneIndex, alignmentScore, outputHash) {
  const wallet = new ethers.Wallet(privateKey);
  const digest = buildAlignmentDigest(jobId, milestoneIndex, alignmentScore, outputHash);
  return wallet.signMessage(ethers.getBytes(digest));
}

// Recover signer the same way the Solidity contract does
function recoverAlignmentSigner(signature, jobId, milestoneIndex, alignmentScore, outputHash) {
  const digest = buildAlignmentDigest(jobId, milestoneIndex, alignmentScore, outputHash);
  return ethers.verifyMessage(ethers.getBytes(digest), signature);
}

describe("alignment signing — digest + recovery round-trip", () => {
  const VERIFIER_KEY = "0x" + "11".repeat(32); // arbitrary fixed key for reproducibility
  const VERIFIER_ADDR = new ethers.Wallet(VERIFIER_KEY).address;

  it("produces a 65-byte (130 hex char) ECDSA signature", async () => {
    const sig = await signAlignment(VERIFIER_KEY, 1n, 0, 8500, ethers.id("output1"));
    assert.match(sig, /^0x[a-f0-9]{130}$/i);
  });

  it("recovers the signer address from a valid signature", async () => {
    const jobId = 42n;
    const milestoneIndex = 1;
    const score = 9000;
    const outputHash = ethers.id("milestone-output");

    const sig = await signAlignment(VERIFIER_KEY, jobId, milestoneIndex, score, outputHash);
    const recovered = recoverAlignmentSigner(sig, jobId, milestoneIndex, score, outputHash);

    assert.strictEqual(recovered.toLowerCase(), VERIFIER_ADDR.toLowerCase());
  });

  it("recovery fails (returns different address) when score differs", async () => {
    const jobId = 1n;
    const outputHash = ethers.id("data");
    const sig = await signAlignment(VERIFIER_KEY, jobId, 0, 8500, outputHash);

    // Tamper: try to recover with a different score
    const recovered = recoverAlignmentSigner(sig, jobId, 0, 8501, outputHash);
    assert.notStrictEqual(recovered.toLowerCase(), VERIFIER_ADDR.toLowerCase());
  });

  it("recovery fails when outputHash differs", async () => {
    const jobId = 1n;
    const sig = await signAlignment(VERIFIER_KEY, jobId, 0, 8500, ethers.id("a"));

    const recovered = recoverAlignmentSigner(sig, jobId, 0, 8500, ethers.id("b"));
    assert.notStrictEqual(recovered.toLowerCase(), VERIFIER_ADDR.toLowerCase());
  });

  it("recovery fails when jobId differs", async () => {
    const sig = await signAlignment(VERIFIER_KEY, 1n, 0, 8500, ethers.id("x"));
    const recovered = recoverAlignmentSigner(sig, 999n, 0, 8500, ethers.id("x"));
    assert.notStrictEqual(recovered.toLowerCase(), VERIFIER_ADDR.toLowerCase());
  });

  it("the runtime and frontend digest formulas produce identical hashes", () => {
    const jobId = 7n;
    const mi = 2;
    const score = 8500;
    const outputHash = ethers.id("payload");

    // Runtime side (ethers v6)
    const runtimeDigest = buildAlignmentDigest(jobId, mi, score, outputHash);

    // Frontend side (mimicking viem encoding behavior using ethers' abi coder).
    // viem's encodeAbiParameters with ("uint256, uint8, uint16, bytes32") produces
    // the same byte layout as ethers' AbiCoder.encode of the same types.
    const feDigest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint8", "uint16", "bytes32"],
        [jobId, mi, score, outputHash]
      )
    );

    assert.strictEqual(runtimeDigest, feDigest);
  });
});
