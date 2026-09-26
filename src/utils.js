/**
 * utils.js — Formatting & helper utilities
 *
 * All output is optimised for Telegram mobile (short, emoji-rich, monospace blocks).
 */

/**
 * Mask a cookie string: show first 6 + last 4 chars
 * "abcdefghijk1234567890" → "abcdef…7890"
 */
function maskCookies(str) {
  if (!str || str.length <= 12) return '••••••';
  return str.slice(0, 6) + '…' + str.slice(-4);
}

/**
 * Format coin count with emoji
 */
function formatCoins(n) {
  if (n === 0) return '0 coins';
  return `🪙 ${n} coin${n !== 1 ? 's' : ''}`;
}

/**
 * Build a compact monospace status block for Telegram
 * @param {Array<{alias: string, coins: number, status: string}>} results
 * @returns {string}
 */
function formatStatusTable(results) {
  if (!results.length) return '```\nNo accounts found.\n```';

  const lines = ['Account          Coins  Status'];
  lines.push('─'.repeat(34));

  for (const r of results) {
    const name = (r.alias || `#${r.id}`).padEnd(16).slice(0, 16);
    const coins = String(r.coins ?? 0).padStart(5);
    const status = r.status || '—';
    lines.push(`${name} ${coins}  ${status}`);
  }

  return '```\n' + lines.join('\n') + '\n```';
}

/**
 * Format a Date for display in a given IANA timezone
 */
function formatTime(date, tz = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: 'short',
      hour12: false,
    }).format(date instanceof Date ? date : new Date(date));
  } catch {
    return String(date);
  }
}

/**
 * Escape special chars for Telegram MarkdownV2
 */
function escapeMarkdown(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Format a single collection result line
 */
function formatResultLine(taskName, coins, success, message) {
  let line;
  if (success) {
    line = coins > 0 ? `✅ ${taskName}: +${coins} coins` : `✅ ${taskName}`;
  } else {
    line = `❌ ${taskName}: failed`;
  }
  return message ? `${line} — ${message}` : line;
}

/**
 * Sleep helper
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse schedule input like "09:30 Africa/Algiers"
 * @param {string} input
 * @returns {{ time: string, timezone: string } | null}
 */
function parseSchedule(input) {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})\s*(.+)?$/);
  if (!match) return null;
  const hh = match[1].padStart(2, '0');
  const mm = match[2];
  const tz = (match[3] || process.env.TZ || 'UTC').trim();
  return { time: `${hh}:${mm}`, timezone: tz };
}

/**
 * Deliver a result message to Telegram, surviving transient API failures
 * (429 flood-wait, 502s — both observed in the wild). Tries editing the
 * progress message first, then sends a fresh message; honors Telegram's
 * retry_after; logs visibly instead of dropping results silently.
 * @returns {Promise<boolean>} true if delivered
 */
async function sendResilient(bot, chatId, text, opts = {}) {
  const editMessageId = opts.editMessageId || null;
  const retries = opts.retries || 4;
  // Default legacy Markdown; pass parseMode: "MarkdownV2" for V2-escaped text,
  // or parseMode: null for plain text.
  const parseMode = opts.parseMode === undefined ? "Markdown" : opts.parseMode;
  const base = { ...(parseMode ? { parse_mode: parseMode } : {}), ...(opts.extra || {}) };
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      let res;
      if (editMessageId && attempt === 1) {
        res = await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: editMessageId,
          ...base,
        });
      } else {
        res = await bot.sendMessage(chatId, text, base);
      }
      // NOTE: bot methods are guarded (see createBot) and resolve null instead
      // of throwing — treat that as failure so retries + plain fallback engage.
      if (res === null || res === undefined || res === false) {
        throw new Error("delivery failed (guarded, detail logged above)");
      }
      return true;
    } catch (err) {
      lastErr = err;
      let waitMs = 2000 * attempt;
      try {
        const ra = err && err.response && err.response.body && err.response.body.parameters;
        if (ra && Number.isFinite(ra.retry_after)) waitMs = ra.retry_after * 1000 + 500;
      } catch {}
      console.error(`[telegram] delivery attempt ${attempt}/${retries} failed: ${err && err.message}`);
      if (attempt < retries) await sleep(waitMs);
    }
  }
  // Last resort: plain text with no parse mode — always parses, so a Markdown
  // entity error in dynamic content (alias, page text) degrades instead of dying.
  try {
    const res = await bot.sendMessage(chatId, text);
    if (res === null || res === undefined || res === false) {
      throw new Error("plain fallback failed (guarded, detail logged above)");
    }
    console.error("[telegram] delivered as plain-text fallback");
    return true;
  } catch (err) {
    lastErr = err;
  }
  console.error(
    `[telegram] GIVING UP delivering ${text.length}-char result to ${chatId}: ${lastErr && lastErr.message}`
  );
  return false;
}

module.exports = {
  maskCookies,
  formatCoins,
  formatStatusTable,
  formatTime,
  escapeMarkdown,
  formatResultLine,
  sleep,
  parseSchedule,
  sendResilient,
};
