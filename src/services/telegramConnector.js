/**
 * Telegram Connector
 *
 * Sends milestone notifications with inline Approve / Request Changes buttons.
 * Receives button taps and free-text replies, forwarding them to:
 *   - POST /api/milestone-approval  (approve button)
 *   - POST /api/job-chat            (text feedback)
 *
 * Pairing flow:
 *   User opens deep link: https://t.me/<BOT_USERNAME>?start=true
 *   Bot captures chatId on /start → calls POST /api/telegram-link
 *   Dashboard shows "✅ Telegram Connected"
 *
 * Mode:
 *   Dev  → polling (bot.launch()) — no HTTPS needed
 *   Prod → webhook via TELEGRAM_WEBHOOK_URL env var
 */

import { Telegraf, Markup } from "telegraf";

const ACTIVITY_BASE =
  process.env.ACTIVITY_LOG_URL?.replace("/api/agent-activity", "") ||
  "http://localhost:3000";

// Singleton bot instance (shared across all agents on one dispatcher)
let _bot = null;
// chatId → { jobId, milestoneIndex } — waiting for typed feedback
const _pendingFeedback = new Map();

// ── Bot initialisation ──────────────────────────────────────────────────────

function getBot() {
  if (_bot) return _bot;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[Telegram] TELEGRAM_BOT_TOKEN not set — Telegram disabled.");
    return null;
  }

  _bot = new Telegraf(token);

  // /start — deep-link pairing
  _bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await ctx.replyWithHTML(
      `👋 Hi! I'm your <b>zer0Gig</b> agent assistant.\n\n` +
      `Your Chat ID: <code>${chatId}</code>\n\n` +
      `Paste this in your zer0Gig dashboard, or it was linked automatically if you clicked a button.`
    );

    // Auto-link: tell the frontend this chatId is now connected
    try {
      await fetch(`${ACTIVITY_BASE}/api/telegram-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, telegramUserId: ctx.from.id }),
      });
    } catch { /* frontend may not have the route yet — non-fatal */ }
  });

  // /chatid — quick lookup
  _bot.command("chatid", (ctx) =>
    ctx.replyWithHTML(`Your Chat ID: <code>${ctx.chat.id}</code>`)
  );

  // Inline button: approve
  _bot.action(/^approve:(\d+):(\d+)$/, async (ctx) => {
    const [, jobId, milestoneIndex] = ctx.match;
    await ctx.answerCbQuery("✅ Approved!");

    try {
      await fetch(`${ACTIVITY_BASE}/api/milestone-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: Number(jobId),
          milestoneIndex: Number(milestoneIndex),
        }),
      });

      // Edit the original message to show confirmed state
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); // remove buttons
      await ctx.replyWithHTML(
        `✅ <b>Milestone ${Number(milestoneIndex) + 1} approved!</b>\nPayment released — agent is continuing.`
      );
    } catch (err) {
      await ctx.reply(`⚠️ Could not process approval: ${err.message}`);
    }
  });

  // Inline button: trade YES
  _bot.action(/^trade_yes:(.+)$/, async (ctx) => {
    const [, tradeId] = ctx.match;
    await ctx.answerCbQuery("✅ Trade confirmed!");

    try {
      await fetch(`${ACTIVITY_BASE}/api/job-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: tradeId,
          sender: "user",
          message: "YES — execute the trade.",
          msgType: "trade_confirmation",
          metadata: { source: "telegram", chatId: String(ctx.chat.id), decision: "YES" },
        }),
      });

      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.replyWithHTML(`✅ <b>Trade confirmed!</b>\nThe agent will proceed with execution.`);
    } catch (err) {
      await ctx.reply(`⚠️ Could not confirm trade: ${err.message}`);
    }
  });

  // Inline button: trade NO
  _bot.action(/^trade_no:(.+)$/, async (ctx) => {
    const [, tradeId] = ctx.match;
    await ctx.answerCbQuery("❌ Trade cancelled.");

    try {
      await fetch(`${ACTIVITY_BASE}/api/job-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: tradeId,
          sender: "user",
          message: "NO — cancel the trade.",
          msgType: "trade_confirmation",
          metadata: { source: "telegram", chatId: String(ctx.chat.id), decision: "NO" },
        }),
      });

      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.replyWithHTML(`❌ <b>Trade cancelled.</b>\nThe agent will not execute this order.`);
    } catch (err) {
      await ctx.reply(`⚠️ Could not cancel trade: ${err.message}`);
    }
  });

  // Inline button: request changes
  _bot.action(/^feedback:(\d+):(\d+)$/, async (ctx) => {
    const [, jobId, milestoneIndex] = ctx.match;
    await ctx.answerCbQuery("Please type your feedback below:");

    // Store pending state so the next text message from this chat is captured
    _pendingFeedback.set(String(ctx.chat.id), {
      jobId: Number(jobId),
      milestoneIndex: Number(milestoneIndex),
    });

    await ctx.reply(
      "✏️ Please type your feedback and I'll pass it to the agent:"
    );
  });

  // Free-text messages (feedback after pressing "Request Changes")
  _bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const pending = _pendingFeedback.get(chatId);

    if (!pending) return; // no pending context — ignore unsolicited text

    _pendingFeedback.delete(chatId);

    try {
      await fetch(`${ACTIVITY_BASE}/api/job-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: pending.jobId,
          sender: "user",
          message: ctx.message.text,
          msgType: "text",
          metadata: { source: "telegram", chatId },
        }),
      });
      await ctx.reply("✅ Feedback sent to the agent!");
    } catch {
      await ctx.reply("⚠️ Failed to send feedback. Please use the dashboard.");
    }
  });

  // Launch: webhook (prod) or polling (dev)
  if (process.env.TELEGRAM_WEBHOOK_URL) {
    _bot.telegram
      .setWebhook(`${process.env.TELEGRAM_WEBHOOK_URL}/telegram-webhook`)
      .then(() => console.log("[Telegram] Webhook registered."));
    console.log("[Telegram] Webhook mode.");
  } else {
    _bot.launch({ dropPendingUpdates: false });
    console.log("[Telegram] Polling mode (dev).");
  }

  // Graceful shutdown
  process.once("SIGINT", () => _bot.stop("SIGINT"));
  process.once("SIGTERM", () => _bot.stop("SIGTERM"));

  return _bot;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a milestone-ready card with Approve / Request Changes inline buttons.
 *
 * @param {object} opts
 * @param {string} opts.chatId       – Telegram chat ID of the client
 * @param {string|number} opts.jobId
 * @param {number} opts.milestoneIndex
 * @param {string} opts.outputSummary – first ~800 chars of agent output
 */
export async function sendMilestoneCard({ chatId, jobId, milestoneIndex, outputSummary }) {
  const bot = getBot();
  if (!bot || !chatId) return;

  const preview = outputSummary.length > 700
    ? outputSummary.slice(0, 700) + "…"
    : outputSummary;

  const text =
    `🤖 <b>zer0Gig Agent</b>\n\n` +
    `✅ <b>Milestone ${milestoneIndex + 1} complete!</b>\n\n` +
    `${preview}\n\n` +
    `<i>Tap Approve to release payment and continue, or Request Changes to give feedback.</i>`;

  try {
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Approve →", `approve:${jobId}:${milestoneIndex}`),
          Markup.button.callback("✏️ Request Changes", `feedback:${jobId}:${milestoneIndex}`),
        ],
      ]),
    });
    console.log(`[Telegram] Milestone ${milestoneIndex + 1} card sent to chat ${chatId}`);
  } catch (err) {
    console.log(`[Telegram] sendMilestoneCard failed: ${err.message}`);
  }
}

/**
 * Send a plain text notification (reminders, status updates).
 *
 * @param {object} opts
 * @param {string} opts.chatId
 * @param {string} opts.message  – plain text (HTML allowed)
 */
export async function sendNotification({ chatId, message }) {
  const bot = getBot();
  if (!bot || !chatId) return;

  try {
    await bot.telegram.sendMessage(chatId, message, { parse_mode: "HTML" });
  } catch (err) {
    console.log(`[Telegram] sendNotification failed: ${err.message}`);
  }
}

/**
 * Send a job completion alert — notifies client when all milestones are done.
 *
 * @param {object} opts
 * @param {string} opts.chatId
 * @param {string|number} opts.jobId
 * @param {string} opts.title       – job title
 * @param {string} opts.summary     – short summary of deliverable
 * @param {string} opts.totalEarned – OG tokens earned (e.g. "0.15 OG")
 */
export async function sendJobCompletionAlert({ chatId, jobId, title, summary, totalEarned }) {
  const bot = getBot();
  if (!bot || !chatId) return;

  const preview = summary.length > 400 ? summary.slice(0, 400) + "…" : summary;

  const text =
    `🎉 <b>Job Completed!</b>\n\n` +
    `📋 <b>${title}</b>\n` +
    `Job ID: <code>${jobId}</code>\n\n` +
    `${preview}\n\n` +
    `💰 <b>Total Earned:</b> ${totalEarned || "N/A"}\n\n` +
    `<i>View the full deliverable on your zer0Gig dashboard.</i>`;

  try {
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.url("📄 View on Dashboard", `${process.env.FRONTEND_URL || "http://localhost:3000"}/dashboard/jobs/${jobId}`)],
      ]),
    });
    console.log(`[Telegram] Job completion alert sent for job ${jobId}`);
  } catch (err) {
    console.log(`[Telegram] sendJobCompletionAlert failed: ${err.message}`);
  }
}

/**
 * Send a trade confirmation request — YES/NO dialog for high-value trades.
 *
 * @param {object} opts
 * @param {string} opts.chatId
 * @param {string} opts.symbol      – e.g. "AAPL"
 * @param {string} opts.side        – "BUY" or "SELL"
 * @param {number} opts.quantity
 * @param {number} opts.estimatedValue  – USD value
 * @param {string} opts.reason      – why this trade (strategy signal)
 * @param {string} opts.tradeId     – unique identifier for this trade
 */
export async function sendTradeConfirmation({ chatId, symbol, side, quantity, estimatedValue, reason, tradeId }) {
  const bot = getBot();
  if (!bot || !chatId) return;

  const text =
    `⚠️ <b>Trade Confirmation Required</b>\n\n` +
    `${side === "BUY" ? "🟢" : "🔴"} <b>${side} ${quantity} ${symbol}</b>\n` +
    `Estimated Value: $${estimatedValue.toFixed(2)}\n\n` +
    `📊 Signal: ${reason}\n\n` +
    `<i>Reply YES to execute or NO to cancel.\nThis trade will be logged to your zer0Gig dashboard.</i>`;

  try {
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(`✅ YES — Buy ${quantity} ${symbol}`, `trade_yes:${tradeId}`),
          Markup.button.callback(`❌ NO — Cancel`, `trade_no:${tradeId}`),
        ],
      ]),
    });
    console.log(`[Telegram] Trade confirmation sent for ${tradeId}`);
  } catch (err) {
    console.log(`[Telegram] sendTradeConfirmation failed: ${err.message}`);
  }
}

/**
 * Send a daily market/portfolio summary.
 *
 * @param {object} opts
 * @param {string} opts.chatId
 * @param {string} opts.summary  – formatted market/portfolio summary
 */
export async function sendDailySummary({ chatId, summary }) {
  const bot = getBot();
  if (!bot || !chatId) return;

  const text =
    `📊 <b>Daily Summary</b>\n\n` +
    summary.slice(0, 3000) +
    `\n\n<i>— zer0Gig Trading Agent</i>`;

  try {
    await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (err) {
    console.log(`[Telegram] sendDailySummary failed: ${err.message}`);
  }
}

/**
 * Send a risk alert — triggered when risk thresholds are breached.
 *
 * @param {object} opts
 * @param {string} opts.chatId
 * @param {string} opts.alertType  – "DRAWDOWN" | "POSITION_SIZE" | "DAILY_LOSS"
 * @param {string} opts.details    – what triggered the alert
 */
export async function sendRiskAlert({ chatId, alertType, details }) {
  const bot = getBot();
  if (!bot || !chatId) return;

  const emoji = { DRAWDOWN: "🚨", POSITION_SIZE: "⚠️", DAILY_LOSS: "🛑" }[alertType] || "⚠️";

  const text =
    `${emoji} <b>Risk Alert: ${alertType}</b>\n\n` +
    `${details}\n\n` +
    `<i>Trading paused. Check your zer0Gig dashboard for details.</i>`;

  try {
    await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (err) {
    console.log(`[Telegram] sendRiskAlert failed: ${err.message}`);
  }
}

// ── CUSTOMER SERVICE BOT ─────────────────────────────────────────────────────

export class CustomerServiceBot {
  constructor(config) {
    this.botToken = config.botToken;
    this.allowedChats = config.allowedChats || [];
    this.extendedCompute = config.extendedCompute;
    this.memoryService = config.memoryService;
    this.storage = config.storageService;
    this.bot = null;
    this._pendingEscalations = new Map();
  }

  async start() {
    if (this.bot) return;

    const { Telegraf } = await import("telegraf");
    this.bot = new Telegraf(this.botToken);

    this.bot.on("text", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const message = ctx.message.text;

      if (this.allowedChats.length > 0 && !this.allowedChats.includes(chatId)) {
        await ctx.reply("⚠️ This bot is not configured for this chat.");
        return;
      }

      console.log(`[CS Bot] Message from ${chatId}: "${message.slice(0, 50)}..."`);
      await this._logMessage(chatId, "user", message);

      if (this._checkEscalation(message)) {
        await this._handleEscalation(ctx, chatId, message);
        return;
      }

      try {
        const reply = await this._generateReply(chatId, message);
        await ctx.reply(reply, { parse_mode: "HTML" });
        await this._logMessage(chatId, "agent", reply);
      } catch (err) {
        console.error(`[CS Bot] Reply failed: ${err.message}`);
        await ctx.reply("⚠️ I'm having trouble responding right now. A human will assist shortly.");
        await this._logMessage(chatId, "agent", `[ERROR] ${err.message}`);
      }
    });

    this.bot.command("help", (ctx) =>
      ctx.replyWithHTML(
        `🤖 <b>AI Customer Service</b>\n\n` +
        `I'm an AI assistant powered by zer0Gig. I can help you with:\n` +
        `• Product inquiries\n• Order status\n• Technical support\n\n` +
        `Type "human" anytime to speak with a real person.`
      )
    );

    this.bot.command("human", async (ctx) => {
      await this._handleEscalation(ctx, String(ctx.chat.id), "User requested human agent");
    });

    // launch() returns a promise that rejects on fatal polling errors (e.g. 409 conflict).
    // Don't await it — let it run in the background and catch errors non-fatally.
    this.bot.launch({ dropPendingUpdates: true }).catch((err) => {
      if (err?.response?.error_code === 409) {
        console.warn(`[CS Bot] 409 Conflict — another instance is already polling this token. Stopping duplicate.`);
      } else {
        console.error(`[CS Bot] Polling error: ${err.message}`);
      }
      this.bot = null;
    });
    console.log(`[CS Bot] Started on client bot.`);
  }

  async stop() {
    if (this.bot) {
      this.bot.stop("SIGTERM");
      this.bot = null;
      console.log("[CS Bot] Stopped.");
    }
  }

  async _generateReply(chatId, message) {
    const context = this.memoryService
      ? await this.memoryService.recall(`telegram:${chatId}`, "customer-service")
      : null;

    const systemPrompt =
      `You are a helpful customer service representative. ` +
      `Be polite, concise, and helpful. Use HTML formatting. ` +
      `If you don't know the answer, say so and offer to escalate. ` +
      `Keep responses under 500 characters.`;

    const userMessage = context
      ? `${context}\n\nCustomer: ${message}`
      : `Customer: ${message}`;

    const result = await this.extendedCompute.processTask(userMessage, systemPrompt, "");
    return result.content.slice(0, 1000);
  }

  _checkEscalation(message) {
    const lower = message.toLowerCase();
    const triggers = [
      "human", "agent", "person", "real person", "real human",
      "speak to someone", "talk to someone", "customer service",
      "complaint", "refund", "cancel order", "angry", "frustrated",
    ];
    return triggers.some((t) => lower.includes(t));
  }

  async _handleEscalation(ctx, chatId, message) {
    this._pendingEscalations.set(chatId, {
      message,
      timestamp: Date.now(),
    });

    await ctx.replyWithHTML(
      `⚠️ <b>Escalating to human agent...</b>\n\n` +
      `A human representative will assist you shortly.\n` +
      `Your reference: <code>${chatId}-${Date.now()}</code>`
    );

    await this._logMessage(chatId, "escalation", message);

    if (process.env.ESCALATION_WEBHOOK_URL) {
      try {
        await fetch(process.env.ESCALATION_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId, message, timestamp: Date.now() }),
        });
      } catch { /* ignore */ }
    }
  }

  async _logMessage(chatId, sender, message) {
    if (!this.storage) return;

    const entry = {
      chatId,
      sender,
      message: message.slice(0, 2000),
      timestamp: Math.floor(Date.now() / 1000),
    };

    try {
      await this.storage.appendExecutionLog(`cs-${chatId}`, entry);
    } catch (err) {
      console.warn(`[CS Bot] Failed to log message: ${err.message}`);
    }
  }

  async getHistory(chatId, limit = 10) {
    if (!this.storage) return [];
    const logs = await this.storage.listExecutionLogs(`cs-${chatId}`);
    return logs.slice(-limit);
  }
}

/**
 * Initialise the bot eagerly (call once from platform-index.js).
 * Safe to call multiple times — returns existing instance.
 */
export function initTelegram() {
  return getBot();
}
