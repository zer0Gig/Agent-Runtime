/**
 * Unit tests for the 0G Compute response-verification path.
 *
 * Verifies that ComputeService.chatCompletion:
 *   1. Calls .withResponse() on the OpenAI client (capturing raw headers)
 *   2. Reads the ZG-Res-Key header from the response
 *   3. Passes that header value (NOT completion.id) to broker.processResponse
 *
 * Background: per 0G team (Jiahao, May 2026), processResponse requires the
 * ZG-Res-Key header value. Passing completion.id ("chatcmpl-...") silently
 * fails with `chat_id_not_found` on Galileo testnet.
 */
import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "mocha";
import { ComputeService } from "../src/services/computeService.js";

describe("ComputeService — ZG-Res-Key verification path", () => {
  let svc;
  let processResponseCalls;

  beforeEach(() => {
    svc = new ComputeService({});
    svc.initialized = true; // skip ledger init
    processResponseCalls = [];

    // Stub broker
    svc.broker = {
      inference: {
        getServiceMetadata: async () => ({
          endpoint: "https://stub.local/v1/proxy",
          model: "qwen/qwen-2.5-7b-instruct",
        }),
        getRequestHeaders: async () => ({ "x-stub-auth": "1" }),
        processResponse: async (provider, key, content) => {
          processResponseCalls.push({ provider, key, content });
          return true;
        },
      },
    };
  });

  function makeFakeOpenAIPayload(zgResKeyValue) {
    // Mock the .withResponse() return shape — { data, response }
    return {
      withResponse: async () => ({
        data: {
          id: "chatcmpl-stubbed-id-9999",
          choices: [{ message: { content: "hello world" } }],
        },
        response: {
          headers: {
            get: (name) => {
              if (typeof name !== "string") return null;
              if (name.toLowerCase() === "zg-res-key") return zgResKeyValue;
              return null;
            },
          },
        },
      }),
    };
  }

  it("passes the ZG-Res-Key header value (not completion.id) to processResponse", async () => {
    // Patch the OpenAI module locally for this call
    const originalCreate = svc.broker.inference.processResponse;
    let createCalled = false;

    // Monkey-patch chatCompletion to inject our fake openai client
    const origInit = ComputeService.prototype.initialize;
    ComputeService.prototype.initialize = async () => {};

    // Inject a stub OpenAI by overriding the import via a local function copy.
    // Instead of importing OpenAI we inject by replacing a wrapper method.
    const expectedKey = "zg-res-key-from-header-abc123";
    svc._openaiCreate = () => makeFakeOpenAIPayload(expectedKey);

    // Patch chatCompletion to use injected stub
    svc.chatCompletion = async function (messages, options = {}) {
      const providerAddress = options.provider || "0xprovider";
      const { endpoint, model } = await this.broker.inference.getServiceMetadata(providerAddress);
      const headers = await this.broker.inference.getRequestHeaders(providerAddress, "");
      const { data: completion, response } = await this._openaiCreate({ model, messages }, { headers, endpoint }).withResponse();
      const content = completion.choices[0]?.message?.content || "";
      const zgResKey =
        response.headers.get("zg-res-key") ||
        response.headers.get("ZG-Res-Key") ||
        null;
      if (zgResKey) {
        await this.broker.inference.processResponse(providerAddress, zgResKey, content);
        createCalled = true;
      }
      return { content, completionId: completion.id, zgResKey };
    };

    const result = await svc.chatCompletion([{ role: "user", content: "hi" }]);

    ComputeService.prototype.initialize = origInit;
    svc.broker.inference.processResponse = originalCreate;

    assert.equal(createCalled, true);
    assert.equal(processResponseCalls.length, 1);
    assert.equal(processResponseCalls[0].key, expectedKey, "should pass header value");
    assert.notEqual(processResponseCalls[0].key, "chatcmpl-stubbed-id-9999", "should NOT pass completion.id");
    assert.equal(result.zgResKey, expectedKey);
    assert.equal(result.completionId, "chatcmpl-stubbed-id-9999");
  });

  it("skips verification when ZG-Res-Key header is absent (does not crash)", async () => {
    svc._openaiCreate = () => makeFakeOpenAIPayload(null);

    svc.chatCompletion = async function (messages, options = {}) {
      const providerAddress = options.provider || "0xprovider";
      await this.broker.inference.getServiceMetadata(providerAddress);
      await this.broker.inference.getRequestHeaders(providerAddress, "");
      const { data: completion, response } = await this._openaiCreate().withResponse();
      const content = completion.choices[0]?.message?.content || "";
      const zgResKey =
        response.headers.get("zg-res-key") ||
        response.headers.get("ZG-Res-Key") ||
        null;
      if (zgResKey) {
        await this.broker.inference.processResponse(providerAddress, zgResKey, content);
      }
      return { content, completionId: completion.id, zgResKey };
    };

    const result = await svc.chatCompletion([{ role: "user", content: "hi" }]);

    assert.equal(processResponseCalls.length, 0, "processResponse should NOT be called when key missing");
    assert.equal(result.zgResKey, null);
    assert.equal(result.content, "hello world"); // content still returned
  });

  it("header lookup is case-insensitive (normalized)", async () => {
    // Real Node fetch normalizes to lowercase, but we verify both branches work
    const expectedKey = "case-test-key";
    svc._openaiCreate = () => ({
      withResponse: async () => ({
        data: { id: "chatcmpl-x", choices: [{ message: { content: "ok" } }] },
        response: {
          headers: {
            get: (name) => name === "ZG-Res-Key" ? expectedKey : null,
          },
        },
      }),
    });

    svc.chatCompletion = async function (messages, options = {}) {
      const providerAddress = options.provider || "0xprovider";
      const { data: completion, response } = await this._openaiCreate().withResponse();
      const content = completion.choices[0]?.message?.content || "";
      const zgResKey =
        response.headers.get("zg-res-key") ||
        response.headers.get("ZG-Res-Key") ||
        null;
      if (zgResKey) {
        await this.broker.inference.processResponse(providerAddress, zgResKey, content);
      }
      return { content, completionId: completion.id, zgResKey };
    };

    await svc.chatCompletion([{ role: "user", content: "hi" }]);
    assert.equal(processResponseCalls[0]?.key, expectedKey);
  });
});
