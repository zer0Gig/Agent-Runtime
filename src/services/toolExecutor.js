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
  const apiKey = skill.config?.apiKey || process.env.ALPACA_API_KEY || process.env.POLYGON_API_KEY;
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
  const apiKey = skill.config?.apiKey || process.env.ALPACA_API_KEY;
  const secretKey = skill.config?.secretKey || process.env.ALPACA_SECRET_KEY;
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
  const apiKey = skill.config?.apiKey || process.env.POLYGON_API_KEY || process.env.ALPACA_API_KEY;
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
  const apiKey = skill.config?.apiKey || process.env.ALPACA_API_KEY;
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
