/**
 * Tool Executor Service
 *
 * Responsible for executing external tools defined in an agent's Capability Manifest.
 * Supports HTTP endpoints, MCP (Model Context Protocol) servers, and pre-built skills
 * from the Skills Registry (Supabase catalog).
 * Aggregates tool results into a context string for the LLM.
 */

import { TOOL_TYPES } from "../schemas/capabilitySchema.js";

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// ─── SKILLS REGISTRY ────────────────────────────────────────────────────────

/**
 * Fetch installed skills for an agent from Supabase (agent_skills JOIN skills).
 * Returns an array of resolved skill objects with their configs.
 */
async function resolveSkills(agentId, prebuiltSkillIds = []) {
  if (!agentId || prebuiltSkillIds.length === 0) return [];
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("[ToolExecutor] No Supabase env vars — skipping skill resolution");
    return [];
  }

  try {
    // Fetch agent's installed skills that match the manifest's prebuiltSkills list
    const url = `${SUPABASE_URL}/rest/v1/agent_skills?agent_id=eq.${agentId}&skill_id=in.(${prebuiltSkillIds.join(",")})&select=config,is_active,skills(*)`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[ToolExecutor] Skill resolve failed: ${res.status}`);
      return [];
    }

    const rows = await res.json();
    // Filter active only; merge agent-level config overrides onto skill defaults
    return rows
      .filter(row => row.is_active && row.skills)
      .map(row => ({
        ...row.skills,
        config: { ...row.skills.config_schema, ...row.config }, // agent overrides win
      }));
  } catch (err) {
    console.warn(`[ToolExecutor] resolveSkills error: ${err.message}`);
    return [];
  }
}

// ─── BUILTIN SKILL HANDLERS ─────────────────────────────────────────────────

/**
 * web_search — uses Serper.dev REST API if an apiKey is configured.
 */
async function builtinWebSearch(skill, jobBrief) {
  const apiKey = skill.config?.apiKey;
  if (!apiKey) {
    return "[web_search] No API key configured. Skipping live search.";
  }

  const query = `${jobBrief.title} ${jobBrief.description}`.slice(0, 200);
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: skill.config?.maxResults || 5 }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Serper error: ${res.status}`);
  const data = await res.json();

  const snippets = (data.organic || [])
    .slice(0, 5)
    .map(r => `• ${r.title}: ${r.snippet} (${r.link})`)
    .join("\n");

  return `Web search results for "${query}":\n${snippets}`;
}

/**
 * http_fetch — fetches a URL and returns the text content.
 */
async function builtinHttpFetch(skill, jobBrief) {
  const targetUrl = skill.config?.url || jobBrief.metadata?.fetchUrl;
  if (!targetUrl) return "[http_fetch] No target URL configured.";

  const res = await fetch(targetUrl, {
    headers: { "User-Agent": "zer0Gig-Agent/1.0" },
    signal: AbortSignal.timeout(10000),
  });

  const text = await res.text();
  return `Fetched content from ${targetUrl}:\n${text.slice(0, 3000)}`;
}

/**
 * github_reader — reads a file or directory listing from a GitHub repo.
 */
async function builtinGithubReader(skill, jobBrief) {
  const token = skill.config?.token;
  const repo = skill.config?.repo || jobBrief.metadata?.githubRepo;
  if (!repo) return "[github_reader] No repo configured.";

  const headers = { "User-Agent": "zer0Gig-Agent/1.0" };
  if (token) headers["Authorization"] = `token ${token}`;

  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json();

  return `GitHub repo "${repo}" info:\n- Stars: ${data.stargazers_count}\n- Description: ${data.description}\n- Language: ${data.language}\n- Updated: ${data.updated_at}`;
}

/**
 * telegram_notify — sends a message to the agent's configured Telegram chat.
 */
async function builtinTelegramNotify(skill, jobBrief) {
  const token = skill.config?.botToken || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = skill.config?.chatId;
  if (!token || !chatId) return "[telegram_notify] Bot token or chatId not configured.";

  const text = `[zer0Gig Agent] Job "${jobBrief.title}" is being processed...`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) throw new Error(`Telegram API error: ${res.status}`);
  return `[telegram_notify] Notification sent to chat ${chatId}`;
}

/**
 * code_exec — executes real code using the Piston API (free, public, no setup).
 * This is what makes zer0Gig agents TRUE agents — not just LLM chat.
 * Supported languages: python, javascript, typescript, ruby, go, rust, java, c++, etc.
 *
 * The agent can:
 * - Run Python/JS to process data, files, API responses
 * - Execute algorithms, crunch numbers, generate reports
 * - Build and test real software
 *
 * Usage: The job brief's metadata should include { codeExec: { language, code } }
 * or the skill config specifies a default language/code template.
 */
async function builtinCodeExec(skill, jobBrief) {
  const execConfig = jobBrief.metadata?.codeExec || skill.config || {};
  const language = execConfig.language || "python";
  const code = execConfig.code || execConfig.script;

  if (!code) {
    return "[code_exec] No code provided in job metadata.codeExec.code — skipping.";
  }

  const runtimeMap = {
    python:        { language: "python",  version: "3.10.0",     apiLanguage: "python" },
    javascript:    { language: "javascript", version: "18.15.0", apiLanguage: "javascript" },
    typescript:    { language: "typescript", version: "5.0.3",   apiLanguage: "typescript" },
    ruby:          { language: "ruby",    version: "3.0.1",     apiLanguage: "ruby" },
    go:            { language: "go",      version: "1.16.2",     apiLanguage: "go" },
    rust:          { language: "rust",    version: "1.68.2",     apiLanguage: "rust" },
    java:          { language: "java",    version: "15.0.2",    apiLanguage: "java" },
    cpp:           { language: "c++",     version: "10.2.0",     apiLanguage: "cpp" },
    c:             { language: "c",       version: "10.2.0",     apiLanguage: "c" },
    php:           { language: "php",     version: "8.2.3",      apiLanguage: "php" },
    swift:         { language: "swift",   version: "5.3.3",     apiLanguage: "swift" },
    kotlin:        { language: "kotlin",  version: "1.8.20",    apiLanguage: "kotlin" },
  };

  const runtime = runtimeMap[language.toLowerCase()];
  if (!runtime) {
    return `[code_exec] Unsupported language: ${language}. Supported: ${Object.keys(runtimeMap).join(", ")}`;
  }

  console.log(`[ToolExecutor:code_exec] Running ${language} via Piston API...`);

  let result;
  try {
    const res = await fetch("https://emkc.org/api/v2/piston/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: runtime.apiLanguage,
        version: runtime.version,
        files: [{ content: code }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) throw new Error(`Piston API error: ${res.status}`);
    result = await res.json();
  } catch (err) {
    return `[code_exec] Execution failed: ${err.message}`;
  }

  const stdout = result.run?.stdout || "";
  const stderr = result.run?.stderr || "";
  const compileOutput = result.compile?.stdout || "";
  const exitCode = result.run?.code ?? 0;

  let summary = `[code_exec] ${language} execution result:\n`;
  summary += `Exit code: ${exitCode}\n`;
  if (compileOutput) summary += `Compiler output: ${compileOutput.slice(0, 500)}\n`;
  if (stdout)        summary += `Output:\n${stdout.slice(0, 2000)}\n`;
  if (stderr)        summary += `Errors:\n${stderr.slice(0, 500)}\n`;
  if (!stdout && !stderr && exitCode === 0) summary += "(no output — program exited cleanly with no stdout)\n";

  console.log(`[ToolExecutor:code_exec] Done. Exit: ${exitCode}, stdout: ${stdout.slice(0, 100)}`);
  return summary;
}

/** Dispatch to the correct builtin handler. */
async function executeBuiltinSkill(skill, jobBrief) {
  switch (skill.id) {
    case "web_search":        return builtinWebSearch(skill, jobBrief);
    case "http_fetch":        return builtinHttpFetch(skill, jobBrief);
    case "github_reader":     return builtinGithubReader(skill, jobBrief);
    case "telegram_notify":   return builtinTelegramNotify(skill, jobBrief);
    case "code_exec":         return builtinCodeExec(skill, jobBrief);
    default:
      return `[${skill.id}] Builtin handler not implemented yet.`;
  }
}

// ─── MAIN EXECUTOR ──────────────────────────────────────────────────────────

/**
 * Executes all configured tools AND pre-built skills for a job.
 * @param {object} jobBrief - The job details and context.
 * @param {Array}  tools    - Custom tool configs from capability manifest.
 * @param {Array}  prebuiltSkillIds - Skill IDs from Skills Registry (e.g. ["web_search"]).
 * @param {number} agentId  - Agent ID for Supabase skill config lookup.
 * @returns {string} Aggregated context string from all tools + skills.
 */
export async function executeForJob(jobBrief, tools = [], prebuiltSkillIds = [], agentId = null) {
  const results = [];

  // ── Custom tools (HTTP / MCP) ──────────────────────────────────────────
  for (const tool of tools) {
    try {
      let result = "";
      if (tool.type === TOOL_TYPES.HTTP) {
        result = await executeHttpTool(tool, jobBrief);
      } else if (tool.type === TOOL_TYPES.MCP) {
        result = await executeMcpTool(tool, jobBrief);
      } else {
        console.warn(`[ToolExecutor] Unknown tool type: ${tool.type}`);
      }
      if (result) results.push(`[Tool: ${tool.name || tool.type}]\n${result}`);
    } catch (error) {
      console.error(`[ToolExecutor] Failed: ${tool.name || tool.type}: ${error.message}`);
    }
  }

  // ── Pre-built skills from Skills Registry ──────────────────────────────
  if (prebuiltSkillIds.length > 0) {
    const skills = await resolveSkills(agentId, prebuiltSkillIds);
    for (const skill of skills) {
      try {
        let result = "";
        if (skill.tool_type === "builtin") {
          result = await executeBuiltinSkill(skill, jobBrief);
        } else if (skill.tool_type === "http") {
          result = await executeHttpTool(
            { name: skill.name, config: { endpoint: skill.endpoint_url, method: "POST", ...skill.config } },
            jobBrief
          );
        } else if (skill.tool_type === "mcp") {
          result = await executeMcpTool(
            { name: skill.name, config: { url: skill.endpoint_url, ...skill.config } },
            jobBrief
          );
        }
        if (result) results.push(`[Skill: ${skill.name}]\n${result}`);
      } catch (error) {
        console.error(`[ToolExecutor] Skill ${skill.id} failed: ${error.message}`);
      }
    }
  }

  return results.join("\n\n");
}

// ─── HTTP TOOL ──────────────────────────────────────────────────────────────

/**
 * Executes an HTTP tool by sending a POST request to the configured endpoint.
 * @param {object} tool - Tool configuration (config: { endpoint, method, apiKey }).
 * @param {object} jobBrief - Job context to include in the payload.
 * @returns {string} Truncated response body.
 */
export async function executeHttpTool(tool, jobBrief) {
  const { endpoint, method, apiKey } = tool.config;
  
  // Prepare headers
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    // In production, decrypt API key here. For demo, use as-is.
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Prepare payload
  const payload = {
    jobBrief,
    timestamp: new Date().toISOString()
  };

  console.log(`[ToolExecutor:HTTP] Calling ${method} ${endpoint}`);
  
  const response = await fetch(endpoint, {
    method: method || "POST",
    headers,
    body: JSON.stringify(payload),
    // Timeout protection: fail if endpoint takes too long
    signal: AbortSignal.timeout(5000) 
  });

  if (!response.ok) {
    throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  // Cap result size to prevent context overflow
  return text.slice(0, 2000);
}

// ─── MCP TOOL ───────────────────────────────────────────────────────────────

/**
 * Executes an MCP tool by communicating with an MCP server.
 * 1. Lists available tools.
 * 2. Calls the appropriate tool with job context.
 * @param {object} tool - Tool configuration (config: { url }).
 * @param {object} jobBrief - Job context.
 * @returns {string} Tool execution result.
 */
export async function executeMcpTool(tool, jobBrief) {
  const { url } = tool.config;
  
  // Check reachability
  try {
    await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(`MCP Server unreachable at ${url}`);
  }

  console.log(`[ToolExecutor:MCP] Connecting to ${url}`);

  // 1. List Tools
  const listRes = await fetch(`${url}/tools/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  
  const listData = await listRes.json();
  if (!listData.result?.tools?.length) {
    throw new Error("No tools available on MCP server");
  }

  // 2. Call Tool (We use the first available tool for demo; in production, match by name)
  const toolName = listData.result.tools[0].name;
  
  const callRes = await fetch(`${url}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: { jobBrief } }
    })
  });

  const callData = await callRes.json();
  
  // Extract content from result
  if (callData.result?.content) {
    const textContent = callData.result.content.map(c => c.text).join(" ");
    return textContent.slice(0, 2000);
  }
  
  return JSON.stringify(callData.result).slice(0, 2000);
}

// ─── API KEY DECRYPTION (STUB) ──────────────────────────────────────────────

/**
 * Decrypts an API key stored in the capability manifest.
 * In production, this uses ECIES decryption with the agent's private key.
 * For the hackathon demo, we assume keys are stored in plaintext or a simple format.
 * 
 * @param {string} encryptedApiKey - The key to decrypt.
 * @returns {string} The plaintext API key.
 */
export function decryptApiKey(encryptedApiKey) {
  if (!encryptedApiKey) return "";
  
  // Check if it looks like an ECIES encrypted blob (starts with 0x...)
  // For demo, we just return it as-is and warn if it's not a standard SK- prefix
  if (encryptedApiKey.startsWith("0x") && encryptedApiKey.length > 100) {
    console.warn("[ToolExecutor] ECIES encrypted key detected. Using stub decryption (returns key as-is).");
  }
  
  return encryptedApiKey;
}
