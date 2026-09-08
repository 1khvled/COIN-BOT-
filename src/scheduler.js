/**
 * scheduler.js — Rolling 24h auto-collection (one sweep per day, no fixed time)
 *
 * The next sweep is always 24h after the ANCHOR: the first sweep of the most
 * recent sweep day. Sweep at 9pm → next sweep 9pm tomorrow. Extra same-day runs
 * (manual /collect) never move the clock. Late boot → one catch-up now if the
 * 24h passed, else wait out the remainder. Never twice in 24h.
 * Uses a setTimeout chain instead of node-cron so the idle process
 * does not wake up every second — nearly zero idle CPU.
 */

const db = require('./db');
const { collectWithRetry } = require('./collector');
const { decrypt } = require('./crypto');
const { formatCoins, formatResultLine, formatTime } = require('./utils');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000; // backoff when a run logged nothing at all
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
    // and sending the same failure every day.
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
 * Milliseconds until the next sweep: 24h after the ANCHOR — the first sweep
 * of the most recent sweep day. Extra same-day runs never move the clock.
 * Never swept → due now (first boot collects immediately, then clock starts).
 */
function msUntilNextSweep() {
  const anchor = db.getAnchorTime();
  if (!anchor) return 0;
  return Math.max(0, anchor + DAY_MS - Date.now());
}

/**
 * Last sweep info for status displays.
 * @returns {{lastRun: number|null, nextInMs: number}}
 */
function getNextSweep() {
  const last = db.getLastRunTime();
  const anchor = db.getAnchorTime();
  if (!anchor) return { lastRun: last, nextInMs: 0 };
  return { lastRun: last, nextInMs: Math.max(0, anchor + DAY_MS - Date.now()) };
}

/** Arm (or re-arm) the rolling timer from the last logged sweep. */
function arm() {
  const delay = msUntilNextSweep();
  if (delay <= 0) {
    console.log('📅 Sweep overdue — running now, then every 24h after completion.');
  } else {
    console.log(
      `📅 Next sweep at ${new Date(Date.now() + delay).toISOString()} (in ${Math.round(delay / 60000)}m)`
    );
  }
  currentTimer = setTimeout(async () => {
    try {
      const before = db.getLastRunTime();
      await runAllCollections();
      if (db.getLastRunTime() === before) {
        // The run logged nothing (e.g. browser missing) — retry in an hour,
        // not never and not in a hot loop.
        console.log('⚠️ Sweep logged nothing — retrying in 1h.');
        currentTimer = setTimeout(() => arm(), RETRY_MS);
        return;
      }
    } catch (err) {
      console.error('Scheduled run error:', err);
      currentTimer = setTimeout(() => arm(), RETRY_MS);
      return;
    }
    arm(); // anchor the next sweep to this completion
  }, delay);
}

/**
 * Start or restart the rolling schedule.
 * Kept signature-compatible: the stored schedule_time/timezone are now
 * display-only (see /schedule) — timing is purely 24h-after-last-sweep.
 */
function startSchedule() {
  if (currentTimer) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }
  arm();
}

/** Public re-anchor: call after any manual sweep so the 24h clock restarts. */
function reschedule() {
  startSchedule();
}

/**
 * Initialize the rolling scheduler.
 * No clock times involved: the first arm() call sweeps immediately if overdue
 * (late boot = catch-up), otherwise waits out the remainder of the 24h window.
 */
function initScheduler() {
  startSchedule();
}

/**
 * Get info about the current schedule (plus rolling-clock state for /status).
 */
function getScheduleInfo() {
  const next = getNextSweep();
  return {
    running: currentTimer !== null,
    lastRun: next.lastRun,
    nextInMs: next.nextInMs,
  };
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
  reschedule,
  initScheduler,
  getScheduleInfo,
  getNextSweep,
};
