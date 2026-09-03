/**
 * scheduler.js — Cron-based auto-collection every 12 hours
 *
 * Runs collectWithRetry() for every stored account twice a day
 * (schedule_time and schedule_time + 12h).
 * Uses a setTimeout chain instead of node-cron so the idle process
 * does not wake up every second — nearly zero idle CPU.
 */

const db = require('./db');
const { collectWithRetry } = require('./collector');
const { decrypt } = require('./crypto');
const { formatCoins, formatResultLine, formatTime } = require('./utils');

const HALF_DAY_MINUTES = 12 * 60;
let currentTimer = null;
let botInstance = null;

/**
 * Register the bot instance so the scheduler can send messages
 */
function setBotInstance(bot) {
  botInstance = bot;
}

/**
 * Run collection for all accounts belonging to a chat
 * @param {string} chatId
 * @returns {Promise<void>}
 */
async function runCollectionForChat(chatId) {
  const accounts = db.getAccountsByChat(chatId);
  if (!accounts.length) return;

  for (const account of accounts) {
    // A previous run already confirmed this session cannot authenticate.
    // Skip it until the user adds fresh cookies instead of opening Chromium
    // and sending the same failure every 12 hours.
    if (account.last_status === 'expired') {
      console.log(`[scheduler] Skipping expired account #${account.id}`);
      continue;
    }

    let cookies;
    try {
      cookies = decrypt(account.cookies_enc);
    } catch {
      db.updateAccountStatus(account.id, 'decrypt_error');
      await notify(chatId, `❌ *Account #${account.id}* (${account.alias || 'unnamed'})\nFailed to decrypt cookies. Re-add with /addaccount`);
      continue;
    }

    const result = await collectWithRetry(cookies, {
      alreadyClaimedToday: db.wasClaimedToday(account.id),
    });

    // Update DB
    db.updateAccountStatus(
      account.id,
      result.expired ? 'expired' : result.totalCoins > 0 ? 'collected' : 'done',
      result.totalCoins
    );
    db.addLog(
      account.id,
      result.totalCoins,
      result.results.map((r) => r.task),
      result.expired ? 'Session expired' : null
    );

    // Build notification
    const lines = [];
    const label = account.alias || `#${account.id}`;

    if (result.expired) {
      lines.push(`⚠️ *Account ${label}* — Session expired!`);
      lines.push('Please update cookies with /addaccount');
    } else {
      lines.push(`📊 *Account ${label}*`);
      for (const r of result.results) {
        lines.push(formatResultLine(r.task, r.coins, r.success, r.message));
      }
      lines.push(`\n💰 Total: ${formatCoins(result.totalCoins)}`);
      if (result.balance !== undefined) {
        lines.push(`🏦 Balance: ${formatCoins(result.balance)}`);
      }
    }

    await notify(chatId, lines.join('\n'));
  }
}

/**
 * Run collection for ALL accounts across all users (for the cron job)
 */
async function runAllCollections() {
  console.log(`🕐 [${new Date().toISOString()}] Scheduled collection starting...`);

  const allAccounts = db.getAllAccounts();
  // Group by chat_id
  const chatIds = [...new Set(allAccounts.map((a) => a.chat_id))];

  for (const chatId of chatIds) {
    try {
      await runCollectionForChat(chatId);
    } catch (err) {
      console.error(`Error running collection for chat ${chatId}:`, err.message);
      await notify(chatId, `❌ Scheduled collection failed: ${err.message}`);
    }
  }

  console.log(`✅ [${new Date().toISOString()}] Scheduled collection complete.`);
}

/**
 * Milliseconds until the next run slot in the given timezone.
 * Run slots: schedule_time and schedule_time + 12h (e.g. 08:00 / 20:00).
 */
function msUntilNextRun(time, timezone) {
  const [hh, mm] = time.split(':').map(Number);
  const base = (hh * 60 + mm) % 1440;
  const slots = [base, (base + HALF_DAY_MINUTES) % 1440].sort((a, b) => a - b);

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const nowMin =
    Number(parts.find((p) => p.type === 'hour').value) * 60 +
    Number(parts.find((p) => p.type === 'minute').value);

  const next = slots.find((s) => s > nowMin);
  const deltaMin = next !== undefined ? next - nowMin : 1440 - nowMin + slots[0];

  // +1s safety so we never fire a second early
  return deltaMin * 60000 + 1000;
}

/**
 * Start or restart the 12-hour schedule
 * @param {string} time – "HH:MM" format (base slot)
 * @param {string} timezone – IANA timezone string
 */
function startSchedule(time = '08:00', timezone = 'UTC') {
  // Stop existing timer
  if (currentTimer) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }

  const [hh, mm] = time.split(':');
  const second = `${String((parseInt(hh) + 12) % 24).padStart(2, '0')}:${mm}`;

  console.log(
    `📅 Scheduling collection every 12h at ${time} & ${second} (${timezone})`
  );

  const arm = () => {
    currentTimer = setTimeout(() => {
      // Re-arm first so a slow collection never shifts the next slot
      arm();
      runAllCollections().catch((err) =>
        console.error('Scheduled run error:', err)
      );
    }, msUntilNextRun(time, timezone));
  };
  arm();
}

/**
 * Initialize scheduler from DB settings
 * Uses the admin's settings or defaults
 */
function initScheduler() {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (!adminChatId) {
    console.warn('⚠️  No ADMIN_CHAT_ID set — using default schedule 08:00 UTC');
    startSchedule('08:00', 'UTC');
    return;
  }

  const settings = db.getSettings(adminChatId);
  startSchedule(settings.schedule_time, settings.timezone);
}

/**
 * Get info about the current schedule
 */
function getScheduleInfo() {
  return {
    running: currentTimer !== null,
  };
}

/**
 * True if the scheduled collection time has already passed today
 * AND no collection has been logged yet — i.e. the PC was off at
 * schedule time and a catch-up run is needed.
 */
function shouldCatchUp() {
  try {
    const adminChatId = process.env.ADMIN_CHAT_ID;
    const settings = db.getSettings(adminChatId);
    const [hh, mm] = settings.schedule_time.split(":");

    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: settings.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const h = parseInt(parts.find((p) => p.type === "hour").value, 10);
    const m = parseInt(parts.find((p) => p.type === "minute").value, 10);

    const schedMin = parseInt(hh, 10) * 60 + parseInt(mm, 10);
    const nowMin = h * 60 + m;

    if (nowMin < schedMin) return false;
    if (db.hasLogsToday()) return false;
    return true;
  } catch (err) {
    console.error("shouldCatchUp error:", err.message);
    return false;
  }
}

/**
 * Send a message via the bot
 */
async function notify(chatId, text) {
  if (!botInstance) {
    console.log(`[notify ${chatId}] ${text}`);
    return;
  }
  try {
    await botInstance.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`Failed to notify ${chatId}:`, err.message);
  }
}

module.exports = {
  setBotInstance,
  runCollectionForChat,
  runAllCollections,
  startSchedule,
  initScheduler,
  getScheduleInfo,
  shouldCatchUp,
};
