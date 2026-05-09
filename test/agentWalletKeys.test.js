/**
 * Unit tests for AGENT_WALLET_KEYS env parser.
 *
 * The parser is inline in platform-index.js, so we replicate it here and
 * verify the parsing logic. If the parser changes, these tests must be updated.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "mocha";

// Inline copy of the parser from platform-index.js:42-50
function parseAgentWalletKeys(envValue) {
  const out = {};
  if (!envValue) return out;
  for (const entry of envValue.split(",")) {
    const [id, key] = entry.trim().split(":");
    if (id && key) out[id.trim()] = key.trim();
  }
  return out;
}

describe("parseAgentWalletKeys — AGENT_WALLET_KEYS parser", () => {
  it("returns empty object for undefined", () => {
    assert.deepStrictEqual(parseAgentWalletKeys(undefined), {});
  });

  it("returns empty object for empty string", () => {
    assert.deepStrictEqual(parseAgentWalletKeys(""), {});
  });

  it("parses a single agent:key entry", () => {
    const result = parseAgentWalletKeys("2:4a21299af3b511d36889b8432466d25f4afb29024b7b9b3382d42b86b5ed6911");
    assert.deepStrictEqual(result, {
      "2": "4a21299af3b511d36889b8432466d25f4afb29024b7b9b3382d42b86b5ed6911",
    });
  });

  it("parses multiple comma-separated entries", () => {
    const result = parseAgentWalletKeys("1:abc123,2:def456,3:ghi789");
    assert.deepStrictEqual(result, { "1": "abc123", "2": "def456", "3": "ghi789" });
  });

  it("trims whitespace around entries", () => {
    const result = parseAgentWalletKeys("  1:abc , 2:def ,  3:ghi  ");
    assert.deepStrictEqual(result, { "1": "abc", "2": "def", "3": "ghi" });
  });

  it("skips malformed entries missing the key", () => {
    const result = parseAgentWalletKeys("1:abc,2,3:ghi");
    assert.deepStrictEqual(result, { "1": "abc", "3": "ghi" });
  });

  it("skips malformed entries missing the id", () => {
    const result = parseAgentWalletKeys("1:abc,:def,3:ghi");
    assert.deepStrictEqual(result, { "1": "abc", "3": "ghi" });
  });

  it("preserves last duplicate id (override semantics)", () => {
    const result = parseAgentWalletKeys("1:first,1:second");
    assert.deepStrictEqual(result, { "1": "second" });
  });
});
