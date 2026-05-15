/**
 * Tool Executor Service
 *
 * Responsible for executing external tools defined in an agent's Capability Manifest.
 * Supports HTTP endpoints, MCP (Model Context Protocol) servers, and pre-built skills
 * from the Skills Registry (Supabase catalog).
 * Aggregates tool results into a context string for the LLM.
 */

import { TOOL_TYPES } from "../schemas/capabilitySchema.js";
import { decrypt as eciesDecrypt } from "eciesjs";

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

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

/**
 * Persist a skill config update back to Supabase agent_skills table.
 * Called after credential collection to save credentials for future runs.
 */
export async function updateAgentSkillConfig(agentId, skillId, configPatch) {
  if (!agentId || !skillId || !SUPABASE_URL || !SUPABASE_KEY) return false;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/agent_skills?agent_id=eq.${agentId}&skill_id=eq.${skillId}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ config: configPatch }),
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) {
      // Row doesn't exist yet — insert it
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/agent_skills`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ agent_id: agentId, skill_id: skillId, config: configPatch, is_active: true }),
        signal: AbortSignal.timeout(5000),
      });
      return ins.ok;
    }
    return true;
  } catch (err) {
    console.warn(`[ToolExecutor] updateAgentSkillConfig error: ${err.message}`);
    return false;
  }
}

// ─── BUILTIN SKILL HANDLERS ─────────────────────────────────────────────────

/**
 * web_search — uses Serper.dev REST API if an apiKey is configured.
 */
async function builtinWebSearch(skill, jobBrief) {
  const apiKey = decryptApiKey(skill.config?.apiKey);
  if (!apiKey) {
    // Fallback: use DuckDuckGo instant answer API (no key needed)
    const q = typeof jobBrief === "string" ? jobBrief : `${jobBrief.title || ""} ${jobBrief.description || ""}`;
    try {
      const ddgRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q.slice(0, 200))}&format=json&no_html=1`, {
        signal: AbortSignal.timeout(5000),
      });
      const ddg = await ddgRes.json();
      const answer = ddg.AbstractText || ddg.Answer || ddg.Definition || "";
      const topics = (ddg.RelatedTopics || []).slice(0, 5).map(t => `• ${t.Text} (${t.FirstURL || "no URL"})`).filter(Boolean).join("\n");
      const abstractUrl = ddg.AbstractURL || "";
      if (answer || topics) {
        let result = `Web search for "${q.slice(0, 100)}":\n`;
        if (answer) result += `${answer}\n`;
        if (abstractUrl) result += `Source: ${abstractUrl}\n`;
        if (topics) result += `Related:\n${topics}\n`;
        return result;
      }
      // If DuckDuckGo instant answers fail, try HTML search for real results
      try {
        const htmlRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q.slice(0, 200))}`, {
          signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        const html = await htmlRes.text();
        const results = [];
        const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
        const snippetRe = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;
        let m;
        while ((m = titleRe.exec(html)) !== null) {
          results.push({ title: m[2].replace(/<[^>]*>/g, ""), url: m[1] });
        }
        if (results.length > 0) {
          const snippets = results.slice(0, 5).map(r => `• ${r.title}: ${r.url}`).join("\n");
          return `Web search for "${q.slice(0, 100)}":\n${snippets}`;
        }
      } catch {}
      return `[web_search] No results found for "${q.slice(0, 80)}".`;
    } catch { return "[web_search] Search failed. No API key configured."; }
  }

  const query = typeof jobBrief === "string"
    ? jobBrief.slice(0, 200)
    : `${jobBrief.title || ""} ${jobBrief.description || ""}`.slice(0, 200);
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
  const token = decryptApiKey(skill.config?.token);
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
  const token = decryptApiKey(skill.config?.botToken) || process.env.TELEGRAM_BOT_TOKEN;
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

// ─── TRADING SKILL HANDLERS ──────────────────────────────────────────────────

/**
 * market_analysis — Fetches real-time and historical market data via MCP.
 * Supports Alpaca API (trading) and Polygon API (data) as MCP endpoints.
 *
 * Config:
 *   {
 *     provider: "alpaca" | "polygon",
 *     apiKey: "YOUR_API_KEY",
 *     symbols: ["AAPL", "TSLA", "BTC-USD"],
 *     timeframe: "1D" | "1H" | "1Min",
 *     indicators: ["RSI", "MACD", "BB"]
 *   }
 */
async function builtinMarketAnalysis(skill, jobBrief) {
  const apiKey = decryptApiKey(skill.config?.apiKey) || process.env.ALPACA_API_KEY || process.env.POLYGON_API_KEY;
  const provider = skill.config?.provider || "alpaca";
  const symbols = skill.config?.symbols || jobBrief.metadata?.symbols || ["AAPL"];
  const timeframe = skill.config?.timeframe || "1D";

  if (!apiKey) {
    return "[market_analysis] No API key configured. Set ALPACA_API_KEY or POLYGON_API_KEY env var.";
  }

  const results = [];

  for (const symbol of symbols.slice(0, 5)) { // Cap at 5 symbols
    try {
      if (provider === "alpaca") {
        // Alpaca Markets API — get bar data
        const res = await fetch(
          `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=20`,
          { headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "" } }
        );
        if (!res.ok) throw new Error(`Alpaca API error: ${res.status}`);
        const data = await res.json();
        const bars = data.bars?.slice(-5).map(b =>
          `  ${b.t}: O=${b.o} H=${b.h} L=${b.l} C=${b.c} V=${b.v}`
        ).join("\n") || "No data";
        results.push(`📊 ${symbol} (${timeframe}):\n${bars}`);
      } else if (provider === "polygon") {
        // Polygon API — get aggregate bars
        const today = new Date();
        const from = new Date(today.getTime() - 30 * 86400000).toISOString().split("T")[0];
        const to = today.toISOString().split("T")[0];
        const res = await fetch(
          `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?apiKey=${apiKey}`
        );
        if (!res.ok) throw new Error(`Polygon API error: ${res.status}`);
        const data = await res.json();
        const bars = data.results?.slice(-5).map(b =>
          `  ${b.t}: O=${b.o} H=${b.h} L=${b.l} C=${b.c} V=${b.v}`
        ).join("\n") || "No data";
        results.push(`📊 ${symbol} (30D daily):\n${bars}`);
      }
    } catch (err) {
      results.push(`⚠️ ${symbol}: ${err.message}`);
    }
  }

  return `Market Analysis Report (${provider}):\n\n${results.join("\n\n")}`;
}

/**
 * order_execution — Places a trade via Alpaca Trading API.
 * SAFETY: Requires confirmation for trades above threshold.
 *
 * Config:
 *   {
 *     apiKey: "YOUR_ALPACA_KEY",
 *     secretKey: "YOUR_ALPACA_SECRET",
 *     paper: true,
 *     maxOrderValue: 1000,
 *     requireConfirmationAbove: 500
 *   }
 *
 * Usage: Job brief metadata should include:
 *   { orderExecution: { symbol, quantity, side, type, limitPrice? } }
 */
async function builtinOrderExecution(skill, jobBrief) {
  const apiKey = decryptApiKey(skill.config?.apiKey) || process.env.ALPACA_API_KEY;
  const secretKey = decryptApiKey(skill.config?.secretKey) || process.env.ALPACA_SECRET_KEY;
  const paper = skill.config?.paper !== false; // Default to paper trading
  const maxOrderValue = skill.config?.maxOrderValue || 1000;

  if (!apiKey || !secretKey) {
    return "[order_execution] Alpaca API credentials not configured.";
  }

  const order = jobBrief.metadata?.orderExecution || {};
  const { symbol, quantity, side, type, limitPrice } = order;

  if (!symbol || !quantity || !side) {
    return "[order_execution] Missing required order params (symbol, quantity, side) in job metadata.";
  }

  // Safety: Check order value
  const estimatedValue = type === "limit" && limitPrice
    ? quantity * limitPrice
    : quantity * 150; // rough estimate if market order
  if (estimatedValue > maxOrderValue) {
    return `[order_execution] ⚠️ Order value $${estimatedValue.toFixed(2)} exceeds max $${maxOrderValue}. Require human confirmation.`;
  }

  const baseUrl = paper
    ? "https://paper-api.alpaca.markets"
    : "https://api.alpaca.markets";

  try {
    const orderPayload = {
      symbol,
      qty: quantity,
      side, // "buy" or "sell"
      type: type || "market",
      time_in_force: "day",
    };
    if (limitPrice) orderPayload.limit_price = limitPrice;

    const res = await fetch(`${baseUrl}/v2/orders`, {
      method: "POST",
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": secretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(orderPayload),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Alpaca order error: ${res.status} — ${errData.message || res.statusText}`);
    }

    const orderResult = await res.json();
    return `✅ Order Placed!\n` +
      `  ID: ${orderResult.id}\n` +
      `  Symbol: ${orderResult.symbol}\n` +
      `  Side: ${orderResult.side}\n` +
      `  Qty: ${orderResult.qty}\n` +
      `  Type: ${orderResult.type}\n` +
      `  Status: ${orderResult.status}\n` +
      `  ${paper ? "(Paper Trading)" : "(LIVE)"}`;
  } catch (err) {
    return `[order_execution] Failed: ${err.message}`;
  }
}

/**
 * chart_patterns — Technical analysis with indicators (RSI, MACD, Bollinger Bands).
 * Calculates indicators from market data and identifies patterns.
 *
 * Config:
 *   {
 *     provider: "alpaca" | "polygon",
 *     apiKey: "YOUR_API_KEY",
 *     symbols: ["AAPL"],
 *     indicators: ["RSI", "MACD", "BB", "SMA", "EMA"]
 *   }
 */
async function builtinChartPatterns(skill, jobBrief) {
  const apiKey = decryptApiKey(skill.config?.apiKey) || process.env.POLYGON_API_KEY || process.env.ALPACA_API_KEY;
  const provider = skill.config?.provider || "polygon";
  const symbols = skill.config?.symbols || jobBrief.metadata?.symbols || ["AAPL"];
  const indicators = skill.config?.indicators || ["RSI", "MACD", "BB"];

  if (!apiKey) {
    return "[chart_patterns] No API key configured.";
  }

  const results = [];

  for (const symbol of symbols.slice(0, 3)) {
    try {
      // Fetch historical data
      let prices = [];
      if (provider === "polygon") {
        const today = new Date();
        const from = new Date(today.getTime() - 90 * 86400000).toISOString().split("T")[0];
        const to = today.toISOString().split("T")[0];
        const res = await fetch(
          `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?apiKey=${apiKey}`
        );
        if (!res.ok) throw new Error(`Polygon API error: ${res.status}`);
        const data = await res.json();
        prices = (data.results || []).map(r => r.c);
      } else {
        const res = await fetch(
          `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=1Day&limit=90`,
          { headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY || "" } }
        );
        if (!res.ok) throw new Error(`Alpaca API error: ${res.status}`);
        const data = await res.json();
        prices = (data.bars || []).map(b => b.c);
      }

      if (prices.length < 20) {
        results.push(`⚠️ ${symbol}: Insufficient data (${prices.length} points, need 20+)`);
        continue;
      }

      const currentPrice = prices[prices.length - 1];
      const analysis = [];

      // RSI (14-period)
      if (indicators.includes("RSI")) {
        const rsi = calculateRSI(prices, 14);
        const signal = rsi < 30 ? "OVERSOLD → Buy signal" : rsi > 70 ? "OVERBOUGHT → Sell signal" : "Neutral";
        analysis.push(`  RSI(14): ${rsi.toFixed(1)} — ${signal}`);
      }

      // MACD
      if (indicators.includes("MACD")) {
        const macd = calculateMACD(prices);
        const signal = macd.histogram > 0 ? "Bullish crossover" : "Bearish crossover";
        analysis.push(`  MACD: ${macd.macd.toFixed(2)}, Signal: ${macd.signal.toFixed(2)}, Histogram: ${macd.histogram.toFixed(2)} — ${signal}`);
      }

      // Bollinger Bands
      if (indicators.includes("BB")) {
        const bb = calculateBollingerBands(prices, 20, 2);
        const position = currentPrice > bb.upper ? "Above upper band (overbought)" :
                         currentPrice < bb.lower ? "Below lower band (oversold)" :
                         "Within bands (normal)";
        analysis.push(`  Bollinger Bands: Upper=${bb.upper.toFixed(2)}, Middle=${bb.middle.toFixed(2)}, Lower=${bb.lower.toFixed(2)} — ${position}`);
      }

      // Simple Moving Averages
      if (indicators.includes("SMA")) {
        const sma20 = calcSMA(prices, 20);
        const sma50 = prices.length >= 50 ? calcSMA(prices, 50) : null;
        const trend = sma50 ? (sma20 > sma50 ? "Golden cross (bullish)" : "Death cross (bearish)") : "N/A (need 50+ data points)";
        analysis.push(`  SMA(20): ${sma20.toFixed(2)}${sma50 ? `, SMA(50): ${sma50.toFixed(2)}` : ""} — ${trend}`);
      }

      results.push(`📈 ${symbol} @ $${currentPrice.toFixed(2)}:\n${analysis.join("\n")}`);
    } catch (err) {
      results.push(`⚠️ ${symbol}: ${err.message}`);
    }
  }

  return `Technical Analysis Report:\n\n${results.join("\n\n")}`;
}

// ─── Technical Analysis Helper Functions ─────────────────────────────────────

function calcSMA(prices, period) {
  if (prices.length < period) return 0;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
  if (prices.length < slow + signal) return { macd: 0, signal: 0, histogram: 0 };
  const emaFast = calcEMA(prices, fast);
  const emaSlow = calcEMA(prices, slow);
  const macdLine = emaFast - emaSlow;
  // Simplified signal line
  const signalLine = macdLine * 0.9; // rough approximation
  return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
}

function calcEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = prices.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, p) => sum + Math.pow(p - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: middle + stdDev * std,
    middle,
    lower: middle - stdDev * std,
  };
}

/**
 * risk_management — Portfolio risk assessment.
 * Analyzes current positions and provides risk metrics.
 *
 * Config:
 *   {
 *     provider: "alpaca",
 *     apiKey: "YOUR_ALPACA_KEY",
 *     maxPositionSize: 0.3,     // Max 30% in one position
 *     maxDrawdown: 0.1,         // Max 10% drawdown
 *     dailyLossLimit: 500       // Max $500 daily loss
 *   }
 */
async function builtinRiskManagement(skill, jobBrief) {
  const apiKey = decryptApiKey(skill.config?.apiKey) || process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  const maxPositionSize = skill.config?.maxPositionSize || 0.3;
  const maxDrawdown = skill.config?.maxDrawdown || 0.1;

  if (!apiKey) {
    return "[risk_management] No API key configured.";
  }

  try {
    // Get account info
    const accountRes = await fetch("https://paper-api.alpaca.markets/v2/account", {
      headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": secretKey || "" },
    });
    if (!accountRes.ok) throw new Error(`Account API error: ${accountRes.status}`);
    const account = await accountRes.json();

    // Get open positions
    const positionsRes = await fetch("https://paper-api.alpaca.markets/v2/positions", {
      headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": secretKey || "" },
    });
    const positions = positionsRes.ok ? await positionsRes.json() : [];

    const equity = parseFloat(account.equity || 0);
    const cash = parseFloat(account.cash || 0);
    const buyingPower = parseFloat(account.buying_power || 0);
    const todayPL = parseFloat(account.today_pl || account.last_equity - equity || 0);

    // Risk analysis
    const warnings = [];
    const positionAnalysis = [];

    for (const pos of positions) {
      const marketValue = parseFloat(pos.market_value || 0);
      const positionPct = equity > 0 ? marketValue / equity : 0;
      const unrealizedPL = parseFloat(pos.unrealized_pl || 0);
      const unrealizedPLPct = parseFloat(pos.unrealized_plpc || 0) * 100;

      positionAnalysis.push(
        `  ${pos.symbol}: ${pos.qty} shares, Value: $${marketValue.toFixed(2)}, ` +
        `P&L: ${unrealizedPLPct.toFixed(1)}% ($${unrealizedPL.toFixed(2)}), ` +
        `Portfolio: ${positionPct.toFixed(1)}%`
      );

      if (positionPct > maxPositionSize) {
        warnings.push(`⚠️ ${pos.symbol} exceeds max position size (${positionPct.toFixed(1)}% > ${maxPositionSize * 100}%)`);
      }
    }

    // Drawdown check
    if (todayPL < 0 && equity > 0) {
      const drawdownPct = Math.abs(todayPL) / equity;
      if (drawdownPct > maxDrawdown) {
        warnings.push(`🚨 Daily drawdown ${drawdownPct.toFixed(1)}% exceeds max ${maxDrawdown * 100}%`);
      }
    }

    const riskScore = warnings.length === 0 ? "LOW" : warnings.length <= 2 ? "MEDIUM" : "HIGH";

    return `Risk Assessment Report:\n\n` +
      `💰 Account: Equity $${equity.toFixed(2)}, Cash $${cash.toFixed(2)}, Buying Power $${buyingPower.toFixed(2)}\n` +
      `📊 Today's P&L: ${todayPL >= 0 ? "+" : ""}$${todayPL.toFixed(2)}\n\n` +
      `Positions (${positions.length}):\n${positionAnalysis.join("\n") || "  No open positions"}\n\n` +
      `⚖️ Risk Level: ${riskScore}\n` +
      (warnings.length > 0 ? `Warnings:\n${warnings.join("\n")}` : "✅ No risk warnings");
  } catch (err) {
    return `[risk_management] Failed: ${err.message}`;
  }
}

/**
 * n8n_manager — full n8n REST API management skill.
 * Allows the agent to autonomously: design a workflow, create it in n8n,
 * activate it, execute it, and retrieve the result.
 *
 * skill.config: { n8nUrl, apiKey, action?, workflowId? }
 * jobBrief.metadata.n8n: {
 *   action: "create" | "execute" | "create_and_execute",
 *   workflowJson?: object,   -- n8n workflow definition (LLM-generated)
 *   workflowId?: string,     -- for execute/status
 * }
 *
 * If n8nUrl or apiKey missing → emits CREDENTIAL_REQUEST.
 */
async function builtinN8nManager(skill, jobBrief) {
  const n8nUrl  = (skill.config?.n8nUrl || "").replace(/\/$/, "");
  const apiKey  = decryptApiKey(skill.config?.apiKey);

  if (!n8nUrl || !apiKey) {
    return (
      `[n8n_manager] CREDENTIAL_REQUEST\n` +
      `This task requires access to your n8n instance but credentials are missing.\n\n` +
      `Please ask the user to provide:\n` +
      `  1. n8n instance URL  — e.g. https://your-n8n.app.n8n.cloud\n` +
      `  2. n8n API key       — Settings → API → Create API key\n\n` +
      `Once configured, the agent will autonomously design and execute workflows on your behalf.`
    );
  }

  const n8nMeta = (typeof jobBrief === "object" ? jobBrief?.metadata?.n8n : null) || {};
  const action  = n8nMeta.action || skill.config?.action || "create_and_execute";
  const headers = { "Content-Type": "application/json", "X-N8N-API-KEY": apiKey };

  // ── CREATE workflow ──────────────────────────────────────────────────────
  async function createWorkflow(workflowJson) {
    if (!workflowJson) return { error: "No workflow JSON provided" };
    const res = await fetch(`${n8nUrl}/api/v1/workflows`, {
      method: "POST", headers,
      body: JSON.stringify(workflowJson),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { error: `Create failed: HTTP ${res.status} — ${err.slice(0, 200)}` };
    }
    const data = await res.json();
    console.log(`[ToolExecutor:n8n] Created workflow id=${data.id} name="${data.name}"`);
    return { workflowId: data.id, name: data.name };
  }

  // ── ACTIVATE workflow ────────────────────────────────────────────────────
  async function activateWorkflow(workflowId) {
    const res = await fetch(`${n8nUrl}/api/v1/workflows/${workflowId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ active: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  }

  // ── EXECUTE workflow ─────────────────────────────────────────────────────
  async function executeWorkflow(workflowId) {
    const res = await fetch(`${n8nUrl}/api/v1/workflows/${workflowId}/execute`, {
      method: "POST", headers,
      body: JSON.stringify({ workflowData: {} }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { error: `Execute failed: HTTP ${res.status} — ${err.slice(0, 200)}` };
    }
    const data = await res.json();
    return { executionId: data.executionId || data.id, status: data.status };
  }

  // ── GET execution result ─────────────────────────────────────────────────
  async function getExecution(executionId) {
    const res = await fetch(`${n8nUrl}/api/v1/executions/${executionId}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { status: "unknown" };
    return res.json();
  }

  // ── LIST workflows ───────────────────────────────────────────────────────
  async function listWorkflows() {
    const res = await fetch(`${n8nUrl}/api/v1/workflows?limit=50`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `List failed: HTTP ${res.status}` };
    const data = await res.json();
    return { workflows: (data.data || []).map(w => ({ id: w.id, name: w.name, active: w.active, updatedAt: w.updatedAt })) };
  }

  // ── UPDATE workflow ──────────────────────────────────────────────────────
  async function updateWorkflow(workflowId, patchJson) {
    const res = await fetch(`${n8nUrl}/api/v1/workflows/${workflowId}`, {
      method: "PUT", headers,
      body: JSON.stringify(patchJson),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { const err = await res.text().catch(() => ""); return { error: `Update failed: HTTP ${res.status} — ${err.slice(0,200)}` }; }
    const data = await res.json();
    return { workflowId: data.id, name: data.name, active: data.active };
  }

  // ── DELETE workflow ──────────────────────────────────────────────────────
  async function deleteWorkflow(workflowId) {
    const res = await fetch(`${n8nUrl}/api/v1/workflows/${workflowId}`, { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) });
    return res.ok ? { deleted: workflowId } : { error: `Delete failed: HTTP ${res.status}` };
  }

  // ── GET EXECUTIONS for workflow ──────────────────────────────────────────
  async function getWorkflowExecutions(workflowId) {
    const res = await fetch(`${n8nUrl}/api/v1/executions?workflowId=${workflowId}&limit=10`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `Executions fetch failed: HTTP ${res.status}` };
    const data = await res.json();
    return { executions: (data.data || []).map(e => ({ id: e.id, status: e.status, startedAt: e.startedAt, stoppedAt: e.stoppedAt })) };
  }

  // ── CREATE CREDENTIAL in n8n ─────────────────────────────────────────────
  async function createCredential(type, name, credData) {
    const res = await fetch(`${n8nUrl}/api/v1/credentials`, {
      method: "POST", headers,
      body: JSON.stringify({ type, name, data: credData }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) { const err = await res.text().catch(() => ""); return { error: `Create credential failed: HTTP ${res.status} — ${err.slice(0,200)}` }; }
    const data = await res.json();
    console.log(`[ToolExecutor:n8n] Created credential id=${data.id} type="${type}"`);
    return { credentialId: data.id, name: data.name, type: data.type };
  }

  // ── DISPATCH ─────────────────────────────────────────────────────────────
  try {
    if (action === "list") {
      const result = await listWorkflows();
      if (result.error) return `[n8n_manager] ${result.error}`;
      const wfList = result.workflows.map(w => `  • [${w.id}] ${w.name} (active: ${w.active})`).join("\n");
      return `[n8n_manager] ${result.workflows.length} workflow(s) in your n8n instance:\n${wfList}`;
    }

    if (action === "update") {
      const wfId = n8nMeta.workflowId || skill.config?.workflowId;
      const patchJson = n8nMeta.workflowJson;
      if (!wfId || !patchJson) return `[n8n_manager] action="update" requires workflowId and workflowJson`;
      const result = await updateWorkflow(wfId, patchJson);
      if (result.error) return `[n8n_manager] ${result.error}`;
      const { createHash } = await import("crypto");
      const newHash = createHash("sha256").update(JSON.stringify(patchJson)).digest("hex");
      return `[n8n_manager] Workflow updated.\n  ID: ${result.workflowId}\n  Name: ${result.name}\n  Hash: ${newHash}`;
    }

    if (action === "delete") {
      const wfId = n8nMeta.workflowId || skill.config?.workflowId;
      if (!wfId) return `[n8n_manager] action="delete" requires workflowId`;
      const result = await deleteWorkflow(wfId);
      if (result.error) return `[n8n_manager] ${result.error}`;
      return `[n8n_manager] Workflow ${wfId} deleted.`;
    }

    if (action === "get_executions") {
      const wfId = n8nMeta.workflowId || skill.config?.workflowId;
      if (!wfId) return `[n8n_manager] action="get_executions" requires workflowId`;
      const result = await getWorkflowExecutions(wfId);
      if (result.error) return `[n8n_manager] ${result.error}`;
      const execList = result.executions.map(e => `  • [${e.id}] ${e.status} — started ${e.startedAt}`).join("\n");
      return `[n8n_manager] ${result.executions.length} execution(s) for workflow ${wfId}:\n${execList}`;
    }

    if (action === "create_credential") {
      const { credType, credName, credData } = n8nMeta;
      if (!credType || !credData) return `[n8n_manager] action="create_credential" requires credType and credData in metadata.n8n`;
      const result = await createCredential(credType, credName || credType, credData);
      if (result.error) return `[n8n_manager] ${result.error}`;
      return `[n8n_manager] Credential registered in n8n.\n  ID: ${result.credentialId}\n  Type: ${result.type}\n  Name: ${result.name}`;
    }

    if (action === "create" || action === "create_and_execute") {
      const workflowJson = n8nMeta.workflowJson;
      if (!workflowJson) {
        return `[n8n_manager] action="${action}" requires jobBrief.metadata.n8n.workflowJson — the LLM should generate this as a valid n8n workflow JSON object.`;
      }

      const created = await createWorkflow(workflowJson);
      if (created.error) return `[n8n_manager] ${created.error}`;

      // Compute workflow hash for on-chain proof
      const { createHash } = await import("crypto");
      const workflowHash = createHash("sha256")
        .update(JSON.stringify(workflowJson))
        .digest("hex");

      if (action === "create") {
        return `[n8n_manager] Workflow created.\n  ID: ${created.workflowId}\n  Name: ${created.name}\n  Hash: ${workflowHash}`;
      }

      // create_and_execute
      await activateWorkflow(created.workflowId);
      const exec = await executeWorkflow(created.workflowId);
      if (exec.error) return `[n8n_manager] Workflow created (id=${created.workflowId}) but execution failed: ${exec.error}`;

      // Poll for completion (max 5 attempts × 4s)
      let execResult = exec;
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(r => setTimeout(r, 4000));
        execResult = await getExecution(exec.executionId);
        if (["success", "error", "crashed"].includes(execResult.status)) break;
      }

      return (
        `[n8n_manager] Workflow designed and executed autonomously.\n` +
        `  Workflow ID:   ${created.workflowId}\n` +
        `  Workflow Hash: ${workflowHash}\n` +
        `  Execution ID:  ${exec.executionId}\n` +
        `  Status:        ${execResult.status || "running"}\n` +
        `  Output:\n${JSON.stringify(execResult.data || {}, null, 2).slice(0, 1500)}`
      );
    }

    if (action === "execute") {
      const wfId = n8nMeta.workflowId || skill.config?.workflowId;
      if (!wfId) return `[n8n_manager] action="execute" requires workflowId`;
      const exec = await executeWorkflow(wfId);
      if (exec.error) return `[n8n_manager] ${exec.error}`;
      return `[n8n_manager] Execution triggered.\n  Execution ID: ${exec.executionId}\n  Status: ${exec.status}`;
    }

    return `[n8n_manager] Unknown action: "${action}". Supported: create | execute | create_and_execute | list | update | delete | get_executions | create_credential`;
  } catch (err) {
    return `[n8n_manager] Error: ${err.message}`;
  }
}

/**
 * n8n_webhook — triggers an n8n workflow via webhook and returns its output.
 *
 * If webhookUrl is missing the skill emits a CREDENTIAL_REQUEST that the LLM
 * relays to the user, asking them to provide the URL (and optional API key).
 *
 * skill.config:
 *   { webhookUrl, apiKey?, uploadFilesToStorage? }
 *
 * n8n workflow should respond with JSON. Special keys surfaced as file outputs:
 *   fileUrl | outputUrl | mp3Url | mp4Url | pdfUrl | audioUrl | videoUrl
 */
async function builtinN8nWebhook(skill, jobBrief, _storageService = null) {
  const webhookUrl = skill.config?.webhookUrl;
  const apiKey = decryptApiKey(skill.config?.apiKey);

  if (!webhookUrl) {
    return (
      `[n8n_webhook] CREDENTIAL_REQUEST\n` +
      `This task requires an n8n automation workflow but no webhook URL is configured.\n\n` +
      `Please ask the user to provide:\n` +
      `  1. n8n Webhook URL  — open your n8n workflow → Webhook trigger node → copy the URL\n` +
      `  2. n8n API key      — optional, only if your n8n instance uses header auth\n\n` +
      `Once the user supplies these, update this skill's config and the workflow will run automatically.`
    );
  }

  const payload = {
    source: "zer0gig-agent",
    timestamp: new Date().toISOString(),
    brief: typeof jobBrief === "string" ? { task: jobBrief } : jobBrief,
  };

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  console.log(`[ToolExecutor:n8n] Triggering webhook: ${webhookUrl.slice(0, 80)}`);

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return `[n8n_webhook] Webhook failed: HTTP ${res.status} — ${errText.slice(0, 300)}`;
  }

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await res.text();
    return `[n8n_webhook] Workflow completed:\n${text.slice(0, 3000)}`;
  }

  const data = await res.json();

  // Surface file output URLs (MP3, MP4, PDF, etc.)
  const FILE_KEYS = ["fileUrl", "outputUrl", "mp3Url", "mp4Url", "pdfUrl", "audioUrl", "videoUrl", "documentUrl"];
  const files = FILE_KEYS.filter(k => data[k]).map(k => `  ${k}: ${data[k]}`);

  let summary = `[n8n_webhook] Workflow completed.\n`;
  if (files.length) summary += `\nOutput files:\n${files.join("\n")}\n`;
  summary += `\nResponse:\n${JSON.stringify(data, null, 2).slice(0, 2000)}`;

  // Auto-upload any file URLs to 0G Storage if storageService provided
  if (_storageService && files.length) {
    const uploaded = [];
    for (const key of FILE_KEYS.filter(k => data[k])) {
      try {
        const fileRes = await fetch(data[key], { signal: AbortSignal.timeout(60_000) });
        if (!fileRes.ok) continue;
        const buf = Buffer.from(await fileRes.arrayBuffer());
        const ext = data[key].split(".").pop()?.split("?")[0] || "bin";
        const cid = await _storageService.uploadBinaryFile(buf, `n8n-output-${Date.now()}.${ext}`);
        uploaded.push(`  ${key} → 0G CID: ${cid}`);
        data[`${key}_cid`] = cid;
      } catch (upErr) {
        console.warn(`[ToolExecutor:n8n] File upload failed for ${key}: ${upErr.message}`);
      }
    }
    if (uploaded.length) summary += `\n0G Storage uploads:\n${uploaded.join("\n")}\n`;
  }

  return summary;
}

/**
 * email_send — sends email via SMTP (Gmail App Password, Outlook, custom SMTP).
 *
 * skill.config requires: { smtpHost, smtpPort, user, password, from, to }
 * Optional: { secure (default port-based), subject, body, replyTo }
 *
 * For Gmail: smtpHost="smtp.gmail.com", smtpPort=465, secure=true,
 * user="you@gmail.com", password="<16-char App Password>" — see
 * https://myaccount.google.com/apppasswords
 *
 * The job brief is used to compose the body when subject/body aren't provided
 * (LLM-generated transactional notification).
 */
async function builtinEmailSend(skill, jobBrief) {
  const cfg = skill.config || {};
  const required = ["smtpHost", "smtpPort", "user", "password", "from", "to"];
  const missing = required.filter(k => !cfg[k]);
  if (missing.length) {
    return `[email_send] Missing config: ${missing.join(", ")}. For Gmail use smtp.gmail.com:465 with an App Password.`;
  }

  let nodemailer;
  try {
    nodemailer = await import("nodemailer");
  } catch {
    return `[email_send] nodemailer not installed. Run: npm install nodemailer`;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: Number(cfg.smtpPort),
      secure: cfg.secure ?? Number(cfg.smtpPort) === 465,
      auth: { user: cfg.user, pass: decryptApiKey(cfg.password) },
    });

    const subject = cfg.subject
      || (typeof jobBrief === "object" ? jobBrief.title : null)
      || "Notification from your zer0Gig agent";
    const body = cfg.body
      || (typeof jobBrief === "object" ? jobBrief.description : String(jobBrief))
      || "(no body provided)";

    const info = await transporter.sendMail({
      from: cfg.from,
      to: cfg.to,
      replyTo: cfg.replyTo,
      subject: subject.slice(0, 200),
      text: String(body).slice(0, 5000),
    });

    return `[email_send] Sent to ${cfg.to} — messageId=${info.messageId}`;
  } catch (err) {
    return `[email_send] Failed: ${err.message?.slice(0, 200)}`;
  }
}

// ─── RARE & HIGH-VALUE SKILL HANDLERS ───────────────────────────────────────

/**
 * marketstack — Global stock market data (EOD, intraday, real-time, EDGAR).
 * Documentation: Docs/RESOURCES/finance/Dokumentasi Lengkap Marketstack API v2.0.0.md
 */
async function builtinMarketstack(skill, jobBrief) {
  const apiKey = decryptApiKey(skill.config?.apiKey) || process.env.MARKETSTACK_API_KEY;
  const endpoint = skill.config?.endpoint || "https://api.marketstack.com/v2";
  const symbol = skill.config?.symbol || jobBrief.metadata?.symbol || "AAPL";
  const dataType = skill.config?.dataType || "eod"; // eod | intraday | stockprice

  if (!apiKey) return "[marketstack] No API key configured. Set MARKETSTACK_API_KEY env var or skill config.";

  try {
    let url;
    if (dataType === "eod") {
      url = `${endpoint}/eod/latest?access_key=${apiKey}&symbols=${symbol}`;
    } else if (dataType === "intraday") {
      url = `${endpoint}/intraday/latest?access_key=${apiKey}&symbols=${symbol}&interval=1hour`;
    } else {
      url = `${endpoint}/stockprice?access_key=${apiKey}&ticker=${symbol}`;
    }

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const item = data.data?.[0];
    if (!item) return `[marketstack] No data returned for ${symbol}.`;

    const lines = [
      `📈 Marketstack ${dataType.toUpperCase()} — ${symbol}`,
      `  Open:     ${item.open}`,
      `  High:     ${item.high}`,
      `  Low:      ${item.low}`,
      `  Close:    ${item.close}`,
      `  Volume:   ${item.volume}`,
    ];
    if (item.adj_close) lines.push(`  Adj Close: ${item.adj_close}`);
    if (item.split_factor) lines.push(`  Split Factor: ${item.split_factor}`);
    if (item.dividend) lines.push(`  Dividend: ${item.dividend}`);
    lines.push(`  Date: ${item.date || item.trade_last || "N/A"}`);

    return lines.join("\n");
  } catch (err) {
    return `[marketstack] Error: ${err.message}`;
  }
}

/**
 * aletheia — Insider trading, earnings calls, financial statements.
 * Rare alternative data for alpha generation.
 */
async function builtinAletheia(skill, jobBrief) {
  const apiKey = decryptApiKey(skill.config?.apiKey) || process.env.ALETHEIA_API_KEY;
  const symbol = skill.config?.symbol || jobBrief.metadata?.symbol || "AAPL";
  const dataType = skill.config?.dataType || "insider"; // insider | earnings | financials

  if (!apiKey) return "[aletheia] No API key configured. Set ALETHEIA_API_KEY env var or skill config.";

  try {
    let url;
    if (dataType === "insider") {
      url = `https://api.aletheiaapi.com/InsiderTrades?symbol=${symbol}&pageSize=5`;
    } else if (dataType === "earnings") {
      url = `https://api.aletheiaapi.com/Earnings?symbol=${symbol}&pageSize=5`;
    } else {
      url = `https://api.aletheiaapi.com/BalanceSheet?symbol=${symbol}`;
    }

    const res = await fetch(url, { headers: { "Authorization": `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (dataType === "insider") {
      const trades = (data || []).slice(0, 3).map(t =>
        `  • ${t.insiderName || "Unknown"}: ${t.transactionType} ${t.shares} shares @ $${t.price} (${t.transactionDate})`
      ).join("\n");
      return `📰 Aletheia Insider Trades — ${symbol}:\n${trades || "No recent insider trades."}`;
    } else if (dataType === "earnings") {
      const reports = (data || []).slice(0, 3).map(e =>
        `  • ${e.fiscalDateEnding}: EPS ${e.reportedEPS} (Est ${e.estimatedEPS || "N/A"}), Rev $${e.totalRevenue}`
      ).join("\n");
      return `📊 Aletheia Earnings — ${symbol}:\n${reports || "No earnings data."}`;
    } else {
      return `📋 Aletheia Financials — ${symbol}:\n${JSON.stringify(data, null, 2).slice(0, 2000)}`;
    }
  } catch (err) {
    return `[aletheia] Error: ${err.message}`;
  }
}

/**
 * wolfram_alpha — Symbolic computation, math, science, data analysis.
 * Turns the agent into a super-intelligent computational engine.
 */
async function builtinWolframAlpha(skill, jobBrief) {
  const appId = decryptApiKey(skill.config?.appId) || process.env.WOLFRAM_APP_ID;
  const query = skill.config?.query || jobBrief.metadata?.wolframQuery || (typeof jobBrief === "string" ? jobBrief : jobBrief.description);

  if (!appId) return "[wolfram_alpha] No App ID configured. Set WOLFRAM_APP_ID env var or skill config.";
  if (!query) return "[wolfram_alpha] No query provided.";

  try {
    const url = `https://api.wolframalpha.com/v2/query?input=${encodeURIComponent(query)}&format=plaintext&output=JSON&appid=${appId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const pods = data.queryresult?.pods || [];
    if (pods.length === 0) return `[wolfram_alpha] No results for: ${query}`;

    const results = pods.slice(0, 5).map(pod => {
      const text = pod.subpods?.map(sp => sp.plaintext).filter(Boolean).join("; ");
      return `  [${pod.title}]\n    ${text || "(no plaintext)"}`;
    }).join("\n");

    return `🔬 WolframAlpha — "${query}":\n${results}`;
  } catch (err) {
    return `[wolfram_alpha] Error: ${err.message}`;
  }
}

/**
 * shodan — Search engine for Internet-connected devices.
 * OSINT / cybersecurity scanning. Extremely rare for AI agents.
 */
async function builtinShodan(skill, jobBrief) {
  const apiKey = decryptApiKey(skill.config?.apiKey) || process.env.SHODAN_API_KEY;
  const query = skill.config?.query || jobBrief.metadata?.shodanQuery || (typeof jobBrief === "string" ? jobBrief : jobBrief.description);

  if (!apiKey) return "[shodan] No API key configured. Set SHODAN_API_KEY env var or skill config.";
  if (!query) return "[shodan] No search query provided.";

  try {
    const url = `https://api.shodan.io/shodan/host/search?key=${apiKey}&query=${encodeURIComponent(query)}&limit=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const matches = (data.matches || []).slice(0, 5).map(m => {
      const ip = m.ip_str;
      const org = m.org || "Unknown";
      const os = m.os || "Unknown";
      const ports = m.port;
      const hostnames = (m.hostnames || []).join(", ") || "N/A";
      return `  • ${ip}:${ports} — ${org} | OS: ${os} | Hosts: ${hostnames}`;
    }).join("\n");

    return `🔍 Shodan Search — "${query}" (${data.total || 0} total results):\n${matches || "No matches found."}`;
  } catch (err) {
    return `[shodan] Error: ${err.message}`;
  }
}

/**
 * marketaux — Live stock market news with sentiment analysis.
 * Alternative data for market-moving events.
 */
async function builtinMarketAux(skill, jobBrief) {
  const apiKey = decryptApiKey(skill.config?.apiKey) || process.env.MARKETAUX_API_KEY;
  const symbol = skill.config?.symbol || jobBrief.metadata?.symbol || "AAPL";
  const limit = skill.config?.limit || 5;

  if (!apiKey) return "[marketaux] No API key configured. Set MARKETAUX_API_KEY env var or skill config.";

  try {
    const url = `https://api.marketaux.com/v1/news/all?symbols=${symbol}&filter_entities=true&language=en&api_token=${apiKey}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const articles = (data.data || []).slice(0, limit).map(a => {
      const sentiment = a.entities?.[0]?.sentiment_score || 0;
      const sentimentLabel = sentiment > 0.2 ? "🟢 Bullish" : sentiment < -0.2 ? "🔴 Bearish" : "⚪ Neutral";
      return `  • ${a.title}\n    ${a.description?.slice(0, 120) || ""}…\n    Sentiment: ${sentimentLabel} (${sentiment.toFixed(2)}) | Source: ${a.source} | ${a.published_at}`;
    }).join("\n\n");

    return `📰 MarketAux News — ${symbol}:\n${articles || "No news found."}`;
  } catch (err) {
    return `[marketaux] Error: ${err.message}`;
  }
}

/** Dispatch to the correct builtin handler. */
async function executeBuiltinSkill(skill, jobBrief, storageService = null) {
  const id = skill.id || skill.skill_id || "";
  console.log(`[ToolExecutor] Executing builtin skill: ${id}`);
  switch (id) {
    case "web_search":        return builtinWebSearch(skill, jobBrief);
    case "http_fetch":        return builtinHttpFetch(skill, jobBrief);
    case "github_reader":     return builtinGithubReader(skill, jobBrief);
    case "telegram_notify":   return builtinTelegramNotify(skill, jobBrief);
    case "code_exec":         return builtinCodeExec(skill, jobBrief);
    case "market_analysis":   return builtinMarketAnalysis(skill, jobBrief);
    case "order_execution":   return builtinOrderExecution(skill, jobBrief);
    case "chart_patterns":    return builtinChartPatterns(skill, jobBrief);
    case "risk_management":   return builtinRiskManagement(skill, jobBrief);
    case "email_send":        return builtinEmailSend(skill, jobBrief);
    case "n8n_webhook":       return builtinN8nWebhook(skill, jobBrief, storageService);
    case "n8n_manager":       return builtinN8nManager(skill, jobBrief);
    case "marketstack":       return builtinMarketstack(skill, jobBrief);
    case "aletheia":          return builtinAletheia(skill, jobBrief);
    case "wolfram_alpha":     return builtinWolframAlpha(skill, jobBrief);
    case "shodan":            return builtinShodan(skill, jobBrief);
    case "marketaux":         return builtinMarketAux(skill, jobBrief);
    default:
      console.warn(`[ToolExecutor] No handler for builtin skill: ${id}`);
      return `[${id}] Builtin handler not implemented yet.`;
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
export async function executeForJob(jobBrief, tools = [], prebuiltSkillIds = [], agentId = null, storageService = null) {
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
    console.log(`[ToolExecutor] Resolved ${skills.length} skill(s): ${skills.map(s => s.id || s.name).join(", ")}`);
    for (const skill of skills) {
      try {
        let result = "";
        // DB column is `tool_name`, not `tool_type`
        const toolType = skill.tool_name || skill.tool_type || "builtin";
        if (toolType === "builtin") {
          result = await executeBuiltinSkill(skill, jobBrief, storageService);
        } else if (toolType === "http") {
          result = await executeHttpTool(
            { name: skill.name, config: { endpoint: skill.endpoint_url || skill.config?.endpoint, method: "POST", ...skill.config } },
            jobBrief
          );
        } else if (toolType === "mcp") {
          result = await executeMcpTool(
            { name: skill.name, config: { url: skill.endpoint_url || skill.config?.url, ...skill.config } },
            jobBrief
          );
        } else {
          console.warn(`[ToolExecutor] Skill ${skill.id} has unknown type: ${toolType}`);
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
  let { endpoint, method, apiKey, headers: extraHeaders, body: bodyTemplate } = tool.config;

  // Normalize URL — add https:// if protocol is missing
  if (endpoint && !endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
    endpoint = "https://" + endpoint;
  }

  const headers = { "Content-Type": "application/json", ...(extraHeaders || {}) };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const httpMethod = (method || "GET").toUpperCase();

  // Build request body only for methods that accept one
  let body = undefined;
  if (!["GET", "HEAD"].includes(httpMethod)) {
    if (bodyTemplate) {
      // Allow custom body template with {{jobBrief}} placeholder
      body = bodyTemplate.replace("{{jobBrief}}", typeof jobBrief === "string" ? jobBrief : JSON.stringify(jobBrief));
    } else {
      body = JSON.stringify({ query: jobBrief, timestamp: new Date().toISOString() });
    }
  }

  console.log(`[ToolExecutor:HTTP] ${httpMethod} ${endpoint}`);

  const response = await fetch(endpoint, {
    method: httpMethod,
    headers,
    body,
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${endpoint}: ${errText.slice(0, 200)}`);
  }

  const text = await response.text();
  return text.slice(0, 5000);
}

// ─── MCP TOOL ───────────────────────────────────────────────────────────────

/**
 * Executes an MCP tool using the official @modelcontextprotocol/sdk.
 *
 * Supports two transport modes based on tool.config:
 *
 * 1. HTTP/SSE transport (remote MCP server):
 *    config: { url: "https://my-mcp-server.com/mcp", toolName?: "my_tool" }
 *
 * 2. Stdio transport (local subprocess MCP server):
 *    config: { command: "python", args: ["-m", "my_mcp"], env: {}, toolName?: "my_tool" }
 *
 * @param {object} tool - { name, config }
 * @param {string} jobBrief - The task/question to pass to the tool
 */
export async function executeMcpTool(tool, jobBrief) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { config, name: toolDisplayName } = tool;

  let transport;
  let transportType;

  if (config.command) {
    // ── Stdio transport: spawn a subprocess MCP server ──────────────────────
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    transportType = "stdio";
    transport = new StdioClientTransport({
      command: config.command,
      args:    config.args  || [],
      env:     { ...process.env, ...(config.env || {}) },
    });
    console.log(`[ToolExecutor:MCP] stdio — ${config.command} ${(config.args || []).join(" ")}`);

  } else if (config.url) {
    // ── HTTP/SSE transport: connect to a remote MCP server ──────────────────
    let url = config.url;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    transportType = "http";

    // Try StreamableHTTP first (MCP spec 2025-03-26), fall back to SSE (older servers)
    try {
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      transport = new StreamableHTTPClientTransport(new URL(url));
      console.log(`[ToolExecutor:MCP] StreamableHTTP — ${url}`);
    } catch {
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      transport = new SSEClientTransport(new URL(url));
      console.log(`[ToolExecutor:MCP] SSE fallback — ${url}`);
    }

  } else {
    throw new Error(`[ToolExecutor:MCP] Tool "${toolDisplayName}" needs config.url (HTTP) or config.command (stdio)`);
  }

  const client = new Client({ name: "zer0gig-agent", version: "2.0.0" });

  try {
    await client.connect(transport);

    // 1. List available tools from the MCP server
    const { tools } = await client.listTools();
    if (!tools?.length) throw new Error("MCP server has no tools");

    // 2. Pick the right tool — prefer config.toolName, then match by keyword, then first
    const targetName = config.toolName || tool.name;
    const picked =
      tools.find(t => t.name === targetName) ||
      tools.find(t => t.name.toLowerCase().includes((targetName || "").toLowerCase())) ||
      tools[0];

    console.log(`[ToolExecutor:MCP] Calling tool "${picked.name}" (${transportType})`);

    // 3. Build arguments — pass jobBrief as the primary input, mapped to the tool's first string param
    const toolArgs = {};
    const schema = picked.inputSchema?.properties || {};
    const firstKey = Object.keys(schema)[0];
    if (firstKey) {
      toolArgs[firstKey] = typeof jobBrief === "string" ? jobBrief : JSON.stringify(jobBrief);
    }
    // Merge any extra static args from tool config
    Object.assign(toolArgs, config.args_override || {});

    // 4. Call the tool
    const result = await client.callTool({ name: picked.name, arguments: toolArgs });

    // 5. Extract text from content array
    const parts = (result.content || [])
      .map(c => (c.type === "text" ? c.text : JSON.stringify(c)))
      .filter(Boolean);

    return parts.join("\n").slice(0, 5000);

  } finally {
    await client.close().catch(() => {});
  }
}

// ─── API KEY DECRYPTION (ECIES) ─────────────────────────────────────────────

/**
 * Decrypts a skill-config secret. Plaintext values pass through (legacy rows).
 * Encrypted values are hex blobs prefixed with `0x`, generated by the
 * frontend's `encryptSkillConfig` using the platform public key.
 *
 * @param {string} value - Plaintext or `0x`-prefixed ECIES blob.
 * @returns {string} The plaintext secret, or "" on missing input / decrypt failure.
 */
export function decryptApiKey(value) {
  if (!value) return "";
  // Heuristic: encrypted blobs are always >200 hex chars after `0x`.
  if (typeof value !== "string" || !value.startsWith("0x") || value.length < 200) {
    return value;
  }

  const sk = process.env.PLATFORM_ENCRYPTION_PRIVATE_KEY;
  if (!sk) {
    console.warn("[ToolExecutor] PLATFORM_ENCRYPTION_PRIVATE_KEY not set — cannot decrypt skill config. Run setup-encryption-keys.js.");
    return "";
  }

  try {
    const skHex   = sk.startsWith("0x") ? sk.slice(2) : sk;
    const cipher  = Buffer.from(value.slice(2), "hex");
    const plain   = eciesDecrypt(skHex, cipher);
    return Buffer.from(plain).toString("utf8");
  } catch (err) {
    console.error(`[ToolExecutor] Skill config decrypt failed: ${err.message}`);
    return "";
  }
}
