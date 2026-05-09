/**
 * Unit tests for ECIES skill-config encryption.
 *
 * Verifies that the runtime's decryptApiKey can recover plaintext from
 * the same hex blob format the frontend's encryptSecret produces.
 */
import { strict as assert } from "node:assert";
import { describe, it, before, after } from "mocha";
import { PrivateKey, encrypt as eciesEncrypt } from "eciesjs";
import { decryptApiKey } from "../src/services/toolExecutor.js";

describe("Skill-config ECIES encryption", () => {
  let originalKey;
  let pkHex;

  before(() => {
    originalKey = process.env.PLATFORM_ENCRYPTION_PRIVATE_KEY;
    const sk = new PrivateKey();
    process.env.PLATFORM_ENCRYPTION_PRIVATE_KEY = "0x" + sk.toHex();
    pkHex = sk.publicKey.toHex(true);
  });

  after(() => {
    if (originalKey === undefined) delete process.env.PLATFORM_ENCRYPTION_PRIVATE_KEY;
    else process.env.PLATFORM_ENCRYPTION_PRIVATE_KEY = originalKey;
  });

  it("returns empty string for empty input", () => {
    assert.equal(decryptApiKey(""), "");
    assert.equal(decryptApiKey(null), "");
    assert.equal(decryptApiKey(undefined), "");
  });

  it("passes plaintext values through unchanged (legacy rows)", () => {
    assert.equal(decryptApiKey("sk-plain-12345"), "sk-plain-12345");
    assert.equal(decryptApiKey("0xshort"), "0xshort"); // 0x but too short → not encrypted
  });

  it("decrypts a frontend-style encrypted blob round-trip", () => {
    const plaintext = "sk-secret-real-api-key-67890";
    const cipher    = eciesEncrypt(pkHex, Buffer.from(plaintext, "utf8"));
    const blob      = "0x" + Buffer.from(cipher).toString("hex");

    assert.ok(blob.length > 200, "encrypted blob should exceed 200 chars");
    assert.equal(decryptApiKey(blob), plaintext);
  });

  it("returns empty string and does not throw on malformed cipher", () => {
    const fake = "0x" + "ab".repeat(150); // 300 chars but not a valid ECIES cipher
    const result = decryptApiKey(fake);
    assert.equal(result, "");
  });

  it("returns empty string when private key is not configured", () => {
    const saved = process.env.PLATFORM_ENCRYPTION_PRIVATE_KEY;
    delete process.env.PLATFORM_ENCRYPTION_PRIVATE_KEY;

    const sk2     = new PrivateKey();
    const cipher  = eciesEncrypt(sk2.publicKey.toHex(true), Buffer.from("anything", "utf8"));
    const blob    = "0x" + Buffer.from(cipher).toString("hex");

    assert.equal(decryptApiKey(blob), "");
    process.env.PLATFORM_ENCRYPTION_PRIVATE_KEY = saved;
  });
});
