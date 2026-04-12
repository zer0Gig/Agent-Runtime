/**
 * Capability Manifest Schema v2
 * 
 * Defines the structure of the JSON object stored at `capabilityCID` on 0G Storage.
 * This manifest allows the Platform Dispatcher to route jobs correctly based on
 * the agent's configured tools, runtime mode, and LLM providers.
 */

// ─── CONSTANTS ─────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = "v2.0.0";

export const RUNTIME_TYPES = {
  PLATFORM: "platform",       // Agent runs on the Platform Dispatcher (Path B)
  SELF_HOSTED: "self-hosted"  // Agent runs on user's own server (Path A)
};

export const LLM_PROVIDERS = {
  OPEN_ROUTER: "openrouter",    // OpenRouter API
  ALIBABA: "alibaba",           // Alibaba/DashScope (Qwen)
  GOOGLE: "google",             // Google Generative AI (Gemini)
  ANTHROPIC: "anthropic",       // Anthropic API (Claude)
  OPEN_AI: "openai",            // OpenAI API (GPT-4o)
  GROQ: "groq",                 // Groq API (Llama)
  ZERO_G: "0g-compute"          // 0G Compute Network (Decentralized)
};

export const TOOL_TYPES = {
  HTTP: "http",               // External HTTP Endpoint
  MCP: "mcp"                  // Model Context Protocol Server
};

// ─── VALIDATION ─────────────────────────────────────────────────────────────

/**
 * Validates a capability manifest against the v2 schema.
 * @param {object} manifest - The manifest object from 0G Storage
 * @returns {object} { valid: boolean, errors: string[] }
 */
export function validateCapabilityManifest(manifest) {
  const errors = [];

  // 1. Version Check
  if (!manifest.version) {
    errors.push("Missing 'version' field.");
  } else if (manifest.version !== SCHEMA_VERSION) {
    errors.push(`Invalid version '${manifest.version}'. Expected '${SCHEMA_VERSION}'.`);
  }

  // 2. Runtime Type Check
  if (!manifest.runtimeMode) {
    errors.push("Missing 'runtimeMode' field.");
  } else if (!Object.values(RUNTIME_TYPES).includes(manifest.runtimeMode)) {
    errors.push(`Invalid runtimeMode '${manifest.runtimeMode}'. Must be one of: ${Object.values(RUNTIME_TYPES).join(", ")}`);
  }

  // 3. Platform Config Validation (Only for Platform Managed Agents)
  if (manifest.runtimeMode === RUNTIME_TYPES.PLATFORM) {
    if (!manifest.platformConfig) {
      errors.push("Missing 'platformConfig' for platform-managed agent.");
    } else {
      if (!manifest.platformConfig.llmProvider) {
        errors.push("Missing 'platformConfig.llmProvider'.");
      } else if (!Object.values(LLM_PROVIDERS).includes(manifest.platformConfig.llmProvider)) {
        errors.push(`Invalid llmProvider '${manifest.platformConfig.llmProvider}'.`);
      }
    }
  }

  // 4. Tool Configuration Validation
  if (manifest.tools && Array.isArray(manifest.tools)) {
    manifest.tools.forEach((tool, index) => {
      if (!tool.type) {
        errors.push(`Tool at index ${index}: Missing 'type'.`);
      } else if (!Object.values(TOOL_TYPES).includes(tool.type)) {
        errors.push(`Tool at index ${index}: Invalid type '${tool.type}'.`);
      } else {
        // HTTP Tool Requirements
        if (tool.type === TOOL_TYPES.HTTP) {
          if (!tool.config || !tool.config.endpoint) {
            errors.push(`Tool at index ${index} (HTTP): Missing 'config.endpoint'.`);
          }
          if (!tool.config || !tool.config.method) {
            errors.push(`Tool at index ${index} (HTTP): Missing 'config.method'.`);
          }
        }
        // MCP Tool Requirements
        else if (tool.type === TOOL_TYPES.MCP) {
          if (!tool.config || !tool.config.url) {
            errors.push(`Tool at index ${index} (MCP): Missing 'config.url'.`);
          }
        }
      }

      // API Key Encryption (if sensitive)
      if (tool.config && tool.config.apiKey && !tool.config.apiKey.startsWith("0x") && !tool.config.apiKey.startsWith("sk-")) {
        // In production, check for ECIES encryption prefix. For demo, we accept plaintext.
        console.warn(`[Schema] Tool ${index} API Key is plaintext. In production, use ECIES encryption.`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// ─── BUILDER ────────────────────────────────────────────────────────────────

/**
 * Helper function to build a valid capability manifest.
 * This is used by the Frontend Registration Flow.
 * @param {object} params - Manifest parameters
 * @returns {object} The capability manifest object
 */
export function buildCapabilityManifest({
  model = "qwen-2.5-7b",
  skills = [],
  runtimeMode = RUNTIME_TYPES.PLATFORM,
  platformConfig = {
    llmProvider: LLM_PROVIDERS.ZERO_G,
    systemPrompt: ""
  },
  tools = [],
  webhooks = {}
}) {
  return {
    version: SCHEMA_VERSION,
    model,
    skills,
    runtimeMode,
    platformConfig,
    tools,
    webhooks
  };
}

// ─── INLINE TEST ────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].includes("capabilitySchema.js")) {
  console.log("Running Capability Schema v2 Tests...");

  // Test 1: Valid Platform Manifest
  const validManifest = buildCapabilityManifest({
    model: "gpt-4o",
    skills: ["web_search", "code_execution"],
    runtimeMode: RUNTIME_TYPES.PLATFORM,
    platformConfig: {
      llmProvider: LLM_PROVIDERS.OPEN_AI,
      systemPrompt: "You are a helpful coding assistant."
    },
    tools: [
      {
        type: TOOL_TYPES.HTTP,
        config: {
          endpoint: "https://api.example.com/search",
          method: "POST",
          apiKey: "sk-encrypted..."
        }
      }
    ]
  });

  const result1 = validateCapabilityManifest(validManifest);
  if (result1.valid) {
    console.log("✅ Test 1 Passed: Valid platform manifest accepted.");
  } else {
    console.error("❌ Test 1 Failed:", result1.errors);
  }

  // Test 2: Invalid Version
  const invalidManifest = { ...validManifest, version: "v1.0.0" };
  const result2 = validateCapabilityManifest(invalidManifest);
  if (!result2.valid && result2.errors[0].includes("version")) {
    console.log("✅ Test 2 Passed: Invalid version rejected.");
  } else {
    console.error("❌ Test 2 Failed:", result2.errors);
  }

  console.log("Tests complete.");
}
