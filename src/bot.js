/**
 * bot.js — Telegram bot command handlers
 *
 * Mobile-optimized: short messages, emoji-rich, inline keyboards.
 * All messages edit in-place where possible to avoid spam.
 */

const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const { encrypt, decrypt } = require("./crypto");
const {
  collectWithRetry,
  debugInspect,
  isCollecting,
  clearDebugFiles,
} = require("./collector");
const {
  maskCookies,
  formatCoins,
  formatStatusTable,
  formatTime,
  formatResultLine,
  parseSchedule,
} = require("./utils");
const scheduler = require("./scheduler");

const REQUIRED_COOKIES = ["_m_h5_tk", "_m_h5_tk_enc"];
const OPTIONAL_COOKIES = ["xman_us_f", "cna", "xman_t", "acs_usuc_t"];

// Track users who are mid-flow for /addaccount
const pendingAddAccount = new Map();

/**
 * Create and configure the Telegram bot
 * @returns {TelegramBot}
 */
function createBot() {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN not set in .env");

  // 3s polling interval + 25s long-poll timeout = fewer HTTP round-trips and
  // less CPU churn while still delivering updates within a few seconds.
  const bot = new TelegramBot(token, {
    polling: { interval: 3000, params: { timeout: 25 } },
  });

  // Register the bot with the scheduler so it can send notifications
  scheduler.setBotInstance(bot);

  // ─── Auth Guard ──────────────────────────────────────
  function isAuthorized(chatId) {
    if (process.env.MULTI_USER === "true") return true;
    return String(chatId) === String(process.env.ADMIN_CHAT_ID);
  }

  function unauthorized(chatId) {
    bot.sendMessage(chatId, "🔒 This bot is private. Contact the admin.");
  }

  // ─── /start ──────────────────────────────────────────
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return unauthorized(chatId);

    const text = [
      "🤖 *AliExpress Coin Collector*",
      "",
      "Automatically collect your daily AliExpress coins\\!",
      "",
      "🚀 *Quick Setup:*",
      "1\\. Extract cookies from AliExpress",
      "2\\. Add your account with /addaccount",
      "3\\. Bot collects coins daily\\!",
      "",
      "Tap a button below to get started 👇",
    ].join("\n");

    bot.sendMessage(chatId, text, {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "➕ Add Account", callback_data: "cmd_addaccount" },
            { text: "📊 Status", callback_data: "cmd_status" },
          ],
          [
            { text: "🪙 Collect Now", callback_data: "cmd_collect_all" },
            { text: "❓ Help", callback_data: "cmd_help" },
          ],
        ],
      },
    });
  });

  // ─── /help ───────────────────────────────────────────
  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return unauthorized(chatId);
    sendHelp(chatId);
  });

  function sendHelp(chatId) {
    const text = [
      "📖 *Commands*",
      "",
      "/addaccount — Add AliExpress account",
      "/removeaccount — Remove an account",
      "/accounts — List your accounts",
      "/collect — Collect coins now",
      "/status — Today's summary",
      "/schedule HH:MM TZ — Set daily time",
      "/debug — Diagnose collection issues",
      "/help — This message",
      "",
      "━━━━━━━━━━━━━━━━━━━━━",
      "🍪 *Get cookies (2 ways):*",
      "",
      "📦 *Easy way — bundled Chrome extension:*",
      "It came with the bot download, in the `extension` folder.",
      "1. Chrome → `chrome://extensions` → Developer mode ON",
      "2. Load unpacked → pick the `extension` folder → pin it",
      "3. On aliexpress.com click it → Copy All Cookies",
      "4. Paste into the bot (full steps: TUTORIAL.md Step 7)",
      "",
      "🛠 *Manual way:*",
      "1. Open aliexpress.com in Chrome (logged in)",
      "2. F12 → Application → Cookies",
      "3. Right-click any cookie → Select All → Copy",
      "4. Paste when /addaccount asks",
      "",
      "⚠️ Include ALL cookies — not just the two listed.",
      "Cookies expire every ~2-4 weeks.",
    ].join("\n");

    bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  }

  // ─── /addaccount ─────────────────────────────────────
  bot.onText(/\/addaccount/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return unauthorized(chatId);

    pendingAddAccount.set(chatId, { step: "awaiting_cookies" });

    const text = [
      "➕ *Add AliExpress Account*",
      "",
      "Paste ALL cookies from aliexpress.com (incl. session cookies):",
      "",
      "`_m_h5_tk=xxx; _m_h5_tk_enc=xxx; cna=xxx; xman_us_f=xxx; ...`",
      "",
      "Use the bundled AE Cookie Extractor (`extension` folder in your bot download:",
      "Chrome → `chrome://extensions` → Load unpacked),",
      "or paste the full cookie string from Chrome DevTools.",
      "",
      "Need help? Tap 👇",
    ].join("\n");

    bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📖 Cookie Guide", callback_data: "cmd_help" }],
          [{ text: "❌ Cancel", callback_data: "cancel_add" }],
        ],
      },
    });
  });

  // ─── /removeaccount ─────────────────────────────────
  bot.onText(/\/removeaccount(?:\s+(\d+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return unauthorized(chatId);

    const accountId = match?.[1];

    if (accountId) {
      // Direct removal
      const result = db.removeAccount(parseInt(accountId), String(chatId));
      if (result.changes > 0) {
        bot.sendMessage(chatId, `✅ Account #${accountId} removed.`);
      } else {
        bot.sendMessage(chatId, `❌ Account #${accountId} not found.`);
      }
      return;
    }

    // Show inline keyboard with accounts
    const accounts = db.getAccountsByChat(String(chatId));
    if (!accounts.length) {
      bot.sendMessage(chatId, "📭 No accounts found. Add one with /addaccount");
      return;
    }

    const keyboard = accounts.map((a) => [
      {
        text: `🗑 ${a.alias || `Account #${a.id}`}`,
        callback_data: `remove_${a.id}`,
      },
    ]);
    keyboard.push([{ text: "❌ Cancel", callback_data: "cancel_remove" }]);

    bot.sendMessage(chatId, "🗑 *Select account to remove:*", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // ─── /accounts ───────────────────────────────────────
  bot.onText(/\/accounts/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return unauthorized(chatId);
    sendAccountsList(chatId);
  });

  function sendAccountsList(chatId, page = 0) {
    const accounts = db.getAccountsByChat(String(chatId));
    if (!accounts.length) {
      bot.sendMessage(
        chatId,
        "📭 No accounts yet. Use /addaccount to add one!",
      );
      return;
    }

    const pageSize = 3;
    const totalPages = Math.ceil(accounts.length / pageSize);
    const pageAccounts = accounts.slice(page * pageSize, (page + 1) * pageSize);

    const lines = [`📋 *Your Accounts* (${page + 1}/${totalPages})`, ""];

    for (const a of pageAccounts) {
      let cookies = "";
      try {
        cookies = maskCookies(decrypt(a.cookies_enc));
      } catch {
        cookies = "⚠️ decrypt error";
      }

      const statusEmoji =
        a.last_status === "collected"
          ? "✅"
          : a.last_status === "expired"
            ? "⚠️"
            : a.last_status === "new"
              ? "🆕"
              : "⏳";

      lines.push(`*#${a.id}* ${a.alias || "unnamed"} ${statusEmoji}`);
      lines.push(`  🍪 ${cookies}`);
      lines.push(`  💰 Last: ${formatCoins(a.last_coins)}`);
      lines.push(
        `  🕐 ${a.last_run ? formatTime(a.last_run, process.env.TZ) : "Never run"}`,
      );
      lines.push("");
    }

    const keyboard = [];
    const navRow = [];
    if (page > 0)
      navRow.push({
        text: "◀️ Prev",
        callback_data: `accounts_page_${page - 1}`,
      });
    if (page < totalPages - 1)
      navRow.push({
        text: "Next ▶️",
        callback_data: `accounts_page_${page + 1}`,
      });
    if (navRow.length) keyboard.push(navRow);

    keyboard.push([
      { text: "🪙 Collect All", callback_data: "cmd_collect_all" },
      { text: "➕ Add", callback_data: "cmd_addaccount" },
    ]);

    bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  // ─── /collect ────────────────────────────────────────
  bot.onText(/\/collect(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return unauthorized(chatId);

    const arg = match?.[1]?.trim();

    if (arg && arg !== "all") {
      // Collect for specific account
      runCollectionForAccount(chatId, parseInt(arg));
    } else {
      // Show picker or collect all
      const accounts = db.getAccountsByChat(String(chatId));
      if (!accounts.length) {
        bot.sendMessage(chatId, "📭 No accounts. Add one with /addaccount");
        return;
      }

      if (accounts.length === 1 || arg === "all") {
        runCollectionForAllAccounts(chatId);
        return;
      }

      // Show picker
      const keyboard = accounts.map((a) => [
        {
          text: `🪙 ${a.alias || `Account #${a.id}`}`,
          callback_data: `collect_${a.id}`,
        },
      ]);
      keyboard.push([
        { text: "🪙 Collect ALL", callback_data: "cmd_collect_all" },
      ]);

      bot.sendMessage(chatId, "🪙 *Select account to collect:*", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    }
  });

  async function runCollectionForAccount(chatId, accountId) {
    const account = db.getAccount(accountId);
    if (!account || account.chat_id !== String(chatId)) {
      bot.sendMessage(chatId, "❌ Account not found.");
      return;
    }

    const label = account.alias || `#${account.id}`;

    // Send progress message
    const progressMsg = await bot.sendMessage(
      chatId,
      `⏳ Collecting for *${label}*...`,
      {
        parse_mode: "Markdown",
      },
    );

    let cookies;
    try {
      cookies = decrypt(account.cookies_enc);
    } catch {
      bot.editMessageText(
        `❌ *${label}*: Failed to decrypt cookies. Re-add with /addaccount`,
        {
          chat_id: chatId,
          message_id: progressMsg.message_id,
          parse_mode: "Markdown",
        },
      );
      return;
    }

    const result = await collectWithRetry(cookies, {
      alreadyClaimedToday: db.wasClaimedToday(account.id),
    });

    if (result.skipped) {
      bot.editMessageText(`⏳ *${label}*: ${result.results[0]?.message || "already running"}`, {
        chat_id: chatId,
        message_id: progressMsg.message_id,
        parse_mode: "Markdown",
      });
      return;
    }

    // Update DB
    db.updateAccountStatus(
      account.id,
      result.expired ? "expired" : result.totalCoins > 0 ? "collected" : "done",
      result.totalCoins,
    );
    db.addLog(
      account.id,
      result.totalCoins,
      result.results.map((r) => r.task),
      result.expired ? "Session expired" : null,
    );

    // Format result
    const lines = [];
    if (result.expired) {
      lines.push(`⚠️ *${label}* — Session expired!`);
      lines.push("Update cookies with /addaccount");
    } else {
      lines.push(`📊 *${label}*`);
      for (const r of result.results) {
        lines.push(formatResultLine(r.task, r.coins, r.success, r.message));
      }
      lines.push(`\n💰 Total: ${formatCoins(result.totalCoins)}`);
      if (result.balance > 0) {
        lines.push(`🏦 Balance: ${formatCoins(result.balance)}`);
      }
      if (result.sources && result.sources.length) {
        lines.push("", "🧩 *Source breakdown:*");
        for (const s of result.sources) {
          lines.push(`• ${s.source}: ${formatCoins(s.coins)}${s.status ? " " + s.status : ""}`);
        }
      }
    }

    bot.editMessageText(lines.join("\n"), {
      chat_id: chatId,
      message_id: progressMsg.message_id,
      parse_mode: "Markdown",
    });
  }

  async function runCollectionForAllAccounts(chatId) {
    const accounts = db.getAccountsByChat(String(chatId));
    if (!accounts.length) {
      bot.sendMessage(chatId, "📭 No accounts found.");
      return;
    }

    const progressMsg = await bot.sendMessage(
      chatId,
      `⏳ Collecting for *${accounts.length} account(s)*...`,
      { parse_mode: "Markdown" },
    );

    const allLines = ["🪙 *Collection Results*", ""];
    let grandTotal = 0;

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const label = account.alias || `#${account.id}`;

      // Update progress
      try {
        await bot.editMessageText(
          `⏳ Collecting *${label}* (${i + 1}/${accounts.length})...`,
          {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            parse_mode: "Markdown",
          },
        );
      } catch {
        /* ignore edit errors */
      }

      let cookies;
      try {
        cookies = decrypt(account.cookies_enc);
      } catch {
        allLines.push(`❌ *${label}*: decrypt error`);
        continue;
      }

      const result = await collectWithRetry(cookies, {
        alreadyClaimedToday: db.wasClaimedToday(account.id),
      });
      grandTotal += result.totalCoins;

      if (result.skipped) {
        allLines.push(`⏳ *${label}*: ${result.results[0]?.message || "already running"}`);
        continue;
      }

      db.updateAccountStatus(
        account.id,
        result.expired
          ? "expired"
          : result.totalCoins > 0
            ? "collected"
            : "done",
        result.totalCoins,
      );
      db.addLog(
        account.id,
        result.totalCoins,
        result.results.map((r) => r.task),
        result.expired ? "Session expired" : null,
      );

      if (result.expired) {
        allLines.push(`⚠️ *${label}* — expired`);
      } else if (result.totalCoins === 0) {
        const allOk = result.results.every((r) => r.success);
        if (allOk) {
          const balanceInfo = result.balance > 0 ? ` 🏦 ${formatCoins(result.balance)}` : "";
          allLines.push(`✅ *${label}*: already done${balanceInfo}`);
        } else {
          const why = result.results.map((r) => r.message).filter(Boolean).join("; ");
          allLines.push(`⚠️ *${label}*: ${why}`);
        }
      } else {
        const taskSummary = result.results
          .filter((r) => r.coins > 0)
          .map((r) => `+${r.coins}`)
          .join(", ");
        const balanceInfo = result.balance > 0 ? ` 🏦 ${formatCoins(result.balance)}` : "";
        allLines.push(
          `✅ *${label}*: ${formatCoins(result.totalCoins)}${balanceInfo} ${taskSummary ? `(${taskSummary})` : ""}`,
        );
      }
    }

    allLines.push("");
    allLines.push(`💰 *Grand Total: ${formatCoins(grandTotal)}*`);

    try {
      await bot.editMessageText(allLines.join("\n"), {
        chat_id: chatId,
        message_id: progressMsg.message_id,
        parse_mode: "Markdown",
      });
    } catch {
      bot.sendMessage(chatId, allLines.join("\n"), { parse_mode: "Markdown" });
    }
  }

  // ─── /status ─────────────────────────────────────────
  bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return unauthorized(chatId);
    sendStatus(chatId);
  });

  function sendStatus(chatId) {
    const accounts = db.getAccountsByChat(String(chatId));
    const settings = db.getSettings(String(chatId));
    const schedInfo = scheduler.getScheduleInfo();

    const rows = accounts.map((a) => ({
      id: a.id,
      alias: a.alias || `Account`,
      coins: a.last_coins || 0,
      status:
        a.last_status === "collected"
          ? "✅"
          : a.last_status === "expired"
            ? "⚠️"
            : a.last_status === "new"
              ? "🆕"
              : "—",
    }));

    const table = formatStatusTable(rows);

    const totalCoins = rows.reduce((sum, r) => sum + r.coins, 0);

    const lines = [
      "📊 *Today's Status*",
      "",
      table,
      "",
      `💰 Total: ${formatCoins(totalCoins)}`,
      `📅 Schedule: ${settings.schedule_time} (${settings.timezone})`,
      `⏱ Scheduler: ${schedInfo.running ? "✅ Active" : "❌ Stopped"}`,
      `📋 Accounts: ${accounts.length}`,
    ];

    bot.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🪙 Collect Now", callback_data: "cmd_collect_all" },
            { text: "🔄 Refresh", callback_data: "cmd_status" },
          ],
        ],
      },
    });
  }

  // ─── /schedule ───────────────────────────────────────
  bot.onText(/\/schedule(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return unauthorized(chatId);

    const input = match?.[1]?.trim();
    if (!input) {
      const settings = db.getSettings(String(chatId));
      bot.sendMessage(
        chatId,
        [
          "📅 *Schedule Settings*",
          "",
          `Current: *${settings.schedule_time}* (${settings.timezone})`,
          "",
          "Usage: `/schedule HH:MM Timezone`",
          "Example: `/schedule 09:30 Africa/Algiers`",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
      return;
    }

    const parsed = parseSchedule(input);
    if (!parsed) {
      bot.sendMessage(
        chatId,
        "❌ Invalid format. Use: `/schedule 09:30 Africa/Algiers`",
        {
          parse_mode: "Markdown",
        },
      );
      return;
    }

    db.updateSettings(String(chatId), parsed.time, parsed.timezone);
    scheduler.startSchedule(parsed.time, parsed.timezone);

    bot.sendMessage(
      chatId,
      `✅ Schedule updated!\n\n📅 Daily collection at *${parsed.time}* (${parsed.timezone})`,
      { parse_mode: "Markdown" },
    );
  });

  // ─── /debug ─────────────────────────────────────────
  bot.onText(/\/debug/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return unauthorized(chatId);

    const accounts = db.getAccountsByChat(String(chatId));
    if (!accounts.length) {
      bot.sendMessage(chatId, "📭 No accounts. Add one with /addaccount");
      return;
    }

    const account = accounts[0];
    let cookies;
    try {
      cookies = decrypt(account.cookies_enc);
    } catch {
      bot.sendMessage(chatId, "❌ Failed to decrypt cookies. Re-add with /addaccount");
      return;
    }

    await bot.sendMessage(chatId, `🔍 Inspecting coin page for *${account.alias || `#${account.id}`}*...`, {
      parse_mode: "Markdown",
    });

    if (isCollecting()) {
      await bot.sendMessage(chatId, "⏳ A collection is running right now — run /debug in a minute.");
      return;
    }

    const info = await debugInspect(cookies);

    const lines = ["🔍 *Debug Report*", ""];
    if (info.error) {
      lines.push(`❌ Error: ${info.error}`);
    } else {
      lines.push(`URL: \`${info.url || "(empty)"}\``);
      lines.push(`Session: ${info.login ? "⚠️ EXPIRED (login page)" : "✅ logged in"}`);
      lines.push(`Balance: ${formatCoins(info.balance)}`);
      lines.push("");
      lines.push("*Visible buttons:*");
      if (info.texts.length) {
        for (const t of info.texts.slice(0, 12)) lines.push(`• ${t}`);
      } else {
        lines.push("• (none)");
      }
      lines.push("");
      lines.push("*aecoin classes:*");
      if (info.aecoinClasses.length) {
        for (const c of info.aecoinClasses.slice(0, 8)) lines.push(`• \`${c}\``);
      } else {
        lines.push("• (none)");
      }
    }

    try {
      await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
    } catch {
      await bot.sendMessage(chatId, lines.join("\n"));
    }

    if (info.shotPath) {
      await bot
        .sendPhoto(chatId, info.shotPath, {
          caption: "📸 Screenshot",
        })
        .catch(() => {});
    }

    if (process.env.DEBUG_ARTIFACTS !== "true") clearDebugFiles();
  });

  // ─── Callback Queries (inline keyboard) ──────────────
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    bot.answerCallbackQuery(query.id);

    if (!isAuthorized(chatId)) return unauthorized(chatId);

    // Command shortcuts
    if (data === "cmd_addaccount") {
      pendingAddAccount.set(chatId, { step: "awaiting_cookies" });
      bot.sendMessage(
        chatId,
        [
          "➕ *Add AliExpress Account*",
          "",
          "Paste ALL cookies from aliexpress.com:",
          "`_m_h5_tk=xxx; _m_h5_tk_enc=xxx; cna=xxx; xman_us_f=xxx; ...`",
          "Use the AE Cookie Extractor extension for easy copy.",
        ].join("\n"),
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📖 Cookie Guide", callback_data: "cmd_help" }],
              [{ text: "❌ Cancel", callback_data: "cancel_add" }],
            ],
          },
        },
      );
      return;
    }

    if (data === "cmd_help") {
      sendHelp(chatId);
      return;
    }

    if (data === "cmd_status") {
      sendStatus(chatId);
      return;
    }

    if (data === "cmd_collect_all") {
      runCollectionForAllAccounts(chatId);
      return;
    }

    if (data === "cmd_accounts") {
      sendAccountsList(chatId);
      return;
    }

    if (data === "cancel_add" || data === "cancel_remove") {
      pendingAddAccount.delete(chatId);
      bot.sendMessage(chatId, "👍 Cancelled.");
      return;
    }

    // Account removal
    if (data.startsWith("remove_")) {
      const id = parseInt(data.replace("remove_", ""));
      const result = db.removeAccount(id, String(chatId));
      if (result.changes > 0) {
        bot.sendMessage(chatId, `✅ Account #${id} removed.`);
      } else {
        bot.sendMessage(chatId, `❌ Account #${id} not found.`);
      }
      return;
    }

    // Collect specific account
    if (data.startsWith("collect_")) {
      const id = parseInt(data.replace("collect_", ""));
      runCollectionForAccount(chatId, id);
      return;
    }

    // Pagination
    if (data.startsWith("accounts_page_")) {
      const page = parseInt(data.replace("accounts_page_", ""));
      sendAccountsList(chatId, page);
      return;
    }

    // Alias confirmation
    if (data === "skip_alias") {
      const pending = pendingAddAccount.get(chatId);
      if (pending && pending.step === "awaiting_alias") {
        finishAddAccount(chatId, pending.cookiesEnc, "");
      }
      return;
    }
  });

  // ─── Text message handler (for conversational flows) ─
  bot.on("message", (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    const pending = pendingAddAccount.get(chatId);
    if (!pending) return;

    if (pending.step === "awaiting_cookies") {
      handleCookieInput(chatId, msg.text);
    } else if (pending.step === "awaiting_alias") {
      finishAddAccount(
        chatId,
        pending.cookiesEnc,
        msg.text.trim().slice(0, 30),
      );
    }
  });

  function handleCookieInput(chatId, text) {
    const cookies = text.trim();

    // Validate: check that required cookie names are present
    const missing = REQUIRED_COOKIES.filter(
      (name) => !cookies.includes(name + "="),
    );

    if (missing.length > 0) {
      bot.sendMessage(
        chatId,
        [
          "❌ Missing cookies:",
          missing.map((c) => `  • \`${c}\``).join("\n"),
          "",
          "Make sure you copy ALL required cookies.",
          "See /help for the guide.",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
      return;
    }

    // Encrypt and ask for alias
    const cookiesEnc = encrypt(cookies);
    pendingAddAccount.set(chatId, {
      step: "awaiting_alias",
      cookiesEnc,
    });

    bot.sendMessage(
      chatId,
      '✅ Cookies validated!\n\nGive this account a name (e.g. "My Main") or skip:',
      {
        reply_markup: {
          inline_keyboard: [[{ text: "⏭ Skip", callback_data: "skip_alias" }]],
        },
      },
    );
  }

  function finishAddAccount(chatId, cookiesEnc, alias) {
    // Pasting cookies again at the name prompt creates confusing duplicates.
    // Keep the current setup flow open and ask for a real label instead.
    if (/(?:^|;\s*)[A-Za-z0-9_-]+=[^;]+/.test(alias)) {
      pendingAddAccount.set(chatId, {
        step: "awaiting_alias",
        cookiesEnc,
      });
      bot.sendMessage(
        chatId,
        "That looks like cookie data, not an account name. Send a short name or tap Skip.",
      );
      return;
    }

    pendingAddAccount.delete(chatId);

    db.addAccount(String(chatId), cookiesEnc, alias);

    bot.sendMessage(
      chatId,
      [
        "✅ *Account added!*",
        "",
        `📛 Name: ${alias || "unnamed"}`,
        "🍪 Cookies: encrypted & stored",
        "",
        "Tap below to collect coins now 👇",
      ].join("\n"),
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🪙 Collect Now", callback_data: "cmd_collect_all" }],
            [{ text: "📋 My Accounts", callback_data: "cmd_accounts" }],
          ],
        },
      },
    );
  }

  // ─── Error handling ──────────────────────────────────
  bot.on("polling_error", (err) => {
    console.error("Polling error:", err.message);
  });

  return bot;
}

module.exports = { createBot };
