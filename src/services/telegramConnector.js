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
 * Initialise the bot eagerly (call once from platform-index.js).
 * Safe to call multiple times — returns existing instance.
 */
export function initTelegram() {
  return getBot();
}
