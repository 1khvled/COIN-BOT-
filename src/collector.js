/**
 * collector.js — AliExpress coin collection via browser automation
 *
 * Uses Playwright (headless Chromium) to automate the AliExpress coin page.
 * The page JS handles all MTOP signing automatically; we just click buttons.
 *
 * AliExpress serves localized pages (Arabic/French/etc) based on IP geo,
 * which breaks English-only selectors — so we force English via cookies.
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { sleep } = require("./utils");

const RETRY_COUNT = 2;
const RETRY_DELAY_MS = 15 * 1000;
const NAV_TIMEOUT = 45000;
const ACTION_TIMEOUT = 20000;
const RENDER_TIMEOUT = 15000;

const COIN_URL = "https://m.aliexpress.com/p/coin-index/index.html";

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

// Forced-English cookies — applied AFTER the user's cookies so they override
const LOCALE_COOKIES = [
  ["aeep_hng", "en_US"],
  ["aep_usuc_f", "site=glo&region=US&b_locale=en_US"],
  ["intl_locale", "en_US"],
  ["xman_us_f", "x_l=0&x_locale=en_US"],
];

// Login page detection (English + Arabic fallbacks)
const LOGIN_SELECTORS = [
  '[class*="aecoin-loginButton"]',
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
  'button:has-text("تسجيل الدخول")',
];

// Candidate collect buttons, most specific first (#signButton is the stable id)
const COLLECT_SELECTORS = [
  "#signButton",
  '[class*="aecoin-signButton"]',
  '[class*="aecoin-"]:has-text("Collect")',
  '[class*="aecoin-"]:has-text("Check")',
  '[class*="aecoin-"]:has-text("Claim")',
  'button:has-text("Collect")',
  'button:has-text("Check in")',
  'button:has-text("Claim")',
  '[class*="aecoin-"]:has-text("اجمع")',
  '[class*="aecoin-"]:has-text("استلام")',
];

// Patterns that indicate today's check-in was already done
const DONE_PATTERNS = [
  /already/i,
  /claimed/i,
  /checked in/i,
  /done today/i,
  /signed in/i,
  /تم تسجيل|تم الاستلام/i,
];

function parseCookies(str) {
  return str
    .split(";")
    .map((c) => {
      const idx = c.indexOf("=");
      if (idx < 1) return null;
      return {
        name: c.substring(0, idx).trim(),
        value: c.substring(idx + 1).trim(),
        domain: ".aliexpress.com",
        path: "/",
      };
    })
    .filter(Boolean);
}

/** Merge forced locale cookies over the user's cookie list (user wins on duplicates). */
function mergeLocaleCookies(cookieList) {
  const byName = new Map(cookieList.map((c) => [c.name, c]));
  for (const [name, value] of LOCALE_COOKIES) {
    byName.set(name, { name, value, domain: ".aliexpress.com", path: "/" });
  }
  return [...byName.values()];
}

/** True if a collection run is in progress (prevents parallel Chromium instances). */
let collecting = false;
function isCollecting() {
  return collecting;
}

/** Wait until the coin page UI actually rendered (saves blind fixed waits). */
async function waitForCoinPage(page) {
  const markers = [
    '[class*="aecoin-digitRollContainer"]',
    "#signButton",
    '[class*="aecoin-pageRoot"]',
    '[class*="aecoin-loginButton"]',
  ];
  const found = await waitForAny(page, markers, 12000);
  if (!found) await sleep(2500); // fallback
}

/** Keep only the most recent debug artifacts (screenshots/html/json). */
function pruneDebugFiles(maxKeep = 20) {
  try {
    const dir = path.join(__dirname, "..", "data", "debug");
    if (!fs.existsSync(dir)) return;
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(png|html|json)$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(maxKeep)) {
      fs.unlinkSync(path.join(dir, f.f));
    }
  } catch {}
}

/** Remove disposable screenshots and page snapshots without touching bot.db. */
function clearDebugFiles() {
  pruneDebugFiles(0);
}

/** Save a screenshot + HTML snapshot to data/debug/ for troubleshooting. */
async function saveDebug(prefix, page) {
  // Keep account data only. Error screenshots are opt-in because they can
  // accumulate quickly when a session has expired.
  if (process.env.DEBUG_ARTIFACTS !== "true") {
    clearDebugFiles();
    return;
  }

  try {
    const dir = path.join(__dirname, "..", "data", "debug");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(dir, `${prefix}-${ts}`);
    await page.screenshot({ path: base + ".png" }).catch(() => {});
    const html = await page.content().catch(() => "");
    fs.writeFileSync(base + ".html", html);
    pruneDebugFiles();
    console.log(`[collector] debug saved: ${base}.png`);
  } catch (err) {
    console.error("[collector] debug save failed:", err.message);
  }
}

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

/** Wait until any of the selectors becomes visible, returns the selector or null. */
async function waitForAny(page, selectors, timeoutMs = RENDER_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const s of selectors) {
      if (await visible(page, s)) return s;
    }
    await sleep(1000);
  }
  return null;
}

/** True if the current page is a login / session-expired page. */
async function isLoginPage(page) {
  const url = page.url();
  if (/login\.aliexpress\.com|passport\.|login\.taobao/i.test(url)) return true;
  for (const s of LOGIN_SELECTORS) {
    if (await visible(page, s)) return true;
  }
  return false;
}

/** True if the page text suggests today's sign-in was already completed. */
async function alreadyDone(page) {
  try {
    const text = await page.evaluate(
      () => (document.body ? document.body.innerText : "")
    );
    return DONE_PATTERNS.some((re) => re.test(text));
  } catch {
    return false;
  }
}

/**
 * Read the SPA's embedded page data (window._dida_config_ / _page_config_).
 * The logged-in coin page ships its state here: balance, check-in info,
 * task list with rewards and statuses — no fragile CSS selectors needed.
 */
async function getPageData(page) {
  return page
    .evaluate(() => {
      const out = {};
      try {
        out.dida = window._dida_config_;
      } catch {}
      try {
        out.pageConfig = window._page_config_;
      } catch {}
      try {
        out.bodyText = document.body ? document.body.innerText : "";
      } catch {}
      return out;
    })
    .catch(() => null);
}

const TASK_KEY_RE = /task|mission|earn|reward|claim/i;
const TITLE_KEY_RE = /title|name|taskname|desc/i;
const COIN_KEY_RE = /coin|reward|amount|price|bonus|point/i;
const STATUS_KEY_RE = /status|state|completed|claimed|finished|done/i;

/**
 * Walk the page JSON and extract structured source info:
 * balance, check-in status, and the task list with rewards/status.
 */
function analyzePageData(data) {
  const sources = [];
  let balance = 0;
  let checkIn = null;

  const walk = (node, keyHint = "") => {
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      const val = node[key];
      const fullKey = keyHint ? `${keyHint}.${key}` : key;

      if (typeof val === "number" || typeof val === "string") {
        if (
          !balance &&
          /(balance|total.*coin|coin.*total|mycoin|coinbalance)/i.test(fullKey)
        ) {
          const n = parseInt(String(val).replace(/[^\d]/g, ""), 10);
          if (!isNaN(n)) balance = n;
          continue;
        }
        if (
          !checkIn &&
          /(checkin|check_in|signin|sign_in|daily.*status|sign.*status)/i.test(fullKey)
        ) {
          checkIn = String(val).slice(0, 40);
        }
        continue;
      }

      if (Array.isArray(val)) {
        // Task list array?
        if (TASK_KEY_RE.test(fullKey) && val.length) {
          for (const item of val) {
            if (item && typeof item === "object") {
              let title = "";
              let coins = 0;
              let status = "";
              for (const ik of Object.keys(item)) {
                const iv = item[ik];
                if (TITLE_KEY_RE.test(ik) && typeof iv === "string") title = iv;
                if (COIN_KEY_RE.test(ik) && !STATUS_KEY_RE.test(ik)) {
                  const n = parseInt(String(iv).replace(/[^\d]/g, ""), 10);
                  if (!isNaN(n) && n > coins) coins = n;
                }
                if (STATUS_KEY_RE.test(ik) && typeof iv !== "object") {
                  status = String(iv).slice(0, 30);
                }
              }
              if (title || coins) {
                sources.push({ source: title || fullKey, coins, status });
              }
            }
          }
        }
        val.forEach((v) => walk(v, fullKey));
        continue;
      }

      walk(val, fullKey);
    }
  };

  walk(data?.dida?.data);
  walk(data?.dida);
  walk(data?.pageConfig);

  return { balance, checkIn, sources };
}

/** True if the embedded data says today's check-in is already done. */
function checkInDoneFromDataFlag(checkIn) {
  if (!checkIn) return false;
  const s = String(checkIn);
  return /(done|claimed|completed|checked|1|true|finish)/i.test(s);
}

// ─── Task board (earn-more) ────────────────────────────────
// The earn-more board exposes its task list through
// `mtop.aliexpress.interactive.task.delivery.query`. Clicking #signButton
// only *sometimes* opens it headlessly, so the API response — not the click —
// is the trigger. Tasks are time-based ("browse this page for 15s"), which is
// why the old "click the first Collect button" loop earned nothing: there is
// no button, the reward arrives from dwell time on the task's own page.
const TASK_API_RE = /interactive\.task\.delivery\.query/;
const BALANCE_API_RE = /query\.user\.coin\.num/;

// Safety limits: dwell-based automation must stay bounded.
const TASK_MAX_PER_RUN = Number(process.env.TASK_MAX_PER_RUN || 8);
const TASK_BUDGET_MS = Number(process.env.TASK_BUDGET_MS || 6 * 60 * 1000);
const DWELL_DEFAULT_MS = 15000;
const DWELL_BUFFER_MS = 3000;

/** Parse the task-delivery payload into a flat, actionable task list. */
function parseTaskList(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const result = j && j.data && j.data.result;
  if (!Array.isArray(result)) return null;
  const out = [];
  for (const group of result) {
    for (const m of group.materials || []) {
      const interest = (m.interests && m.interests[0]) || {};
      let dwellMs = DWELL_DEFAULT_MS;
      try {
        const bc = JSON.parse(m.behaviorConfig || "{}");
        if (Number.isFinite(bc.time)) dwellMs = bc.time * 1000;
      } catch {}
      out.push({
        taskId: m.taskId,
        coins: interest.interestNum ?? m.interestNum ?? 0,
        timesLimit: m.timesLimit ?? 1,
        timesJoined: m.timesJoined ?? 0,
        url: m.materialUrl || null,
        dwellMs,
        title: (m.mainTitle || m.secondTitle || "Task").trim(),
        // Click-count tasks ("tap 3 items") need interaction we don't do.
        needsClicks: Number.isFinite(m.countThreshold),
      });
    }
  }
  return out;
}

/**
 * Attach live probes to a page: authoritative coin balance (from AliExpress's
 * own API, far more reliable than digit-roll DOM parsing) and the latest task
 * list. Returns the shared state object.
 */
function attachProbes(page, state) {
  page.on("response", async (res) => {
    const url = res.url();
    try {
      if (BALANCE_API_RE.test(url)) {
        const j = JSON.parse(await res.text());
        const n = j && j.data && j.data.data && j.data.data.userCoinsNum;
        if (Number.isFinite(n)) state.apiBalance = n;
      } else if (TASK_API_RE.test(url)) {
        const list = parseTaskList(await res.text());
        if (list) {
          state.tasks = list;
          state.tasksAt = Date.now();
        }
      }
    } catch {}
  });
  return state;
}

/** Open the earn-more board and wait for the task list to arrive. */
async function openTaskBoard(page, state) {
  const signBtn = page.locator("#signButton").first();
  if (!(await signBtn.isVisible().catch(() => false))) return [];
  const txt = (await signBtn.innerText().catch(() => "")).trim();
  if (!/earn more/i.test(txt)) return []; // not claimed yet, or already on board

  for (let attempt = 1; attempt <= 2; attempt++) {
    const had = state.tasks && state.tasks.length;
    const seenAt = state.tasksAt || 0;
    await signBtn.click({ force: true, timeout: 10000 }).catch(() => {});
    // Wait for a FRESH task list (click may be a no-op headlessly).
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (state.tasksAt && state.tasksAt > seenAt && (!had || state.tasks.length)) {
        return state.tasks;
      }
      await sleep(500);
    }
    if (state.tasks && state.tasks.length) return state.tasks;
  }
  return [];
}

/**
 * Claim the earn-more task board. Each task is completed by opening its own
 * page and dwelling for the server-specified time; every claim is verified
 * against the balance delta, so we only ever report coins that actually landed.
 * Bounded by TASK_MAX_PER_RUN and TASK_BUDGET_MS.
 */
async function claimEarnedTasks(ctx, page, state, opts = {}) {
  const claimed = [];
  // OFF by default, and that's a measured decision, not a guess: the board's
  // tasks are `componentType: "app"` browse-tracker missions. Completing them
  // headlessly on the web produced ZERO credits across 6 tasks / 153s (all
  // tasks stayed joined=0, balance unmoved) — the app beacons never fire in a
  // plain browser. Enable with CLAIM_TASKS=true if AliExpress ever changes it.
  if (process.env.CLAIM_TASKS !== "true") return claimed;
  if (opts.skipTasks) return claimed;

  const tasks = await openTaskBoard(page, state);
  if (!tasks.length) {
    console.log("[collector] no task list available");
    return claimed;
  }
  const pending = tasks.filter(
    (t) =>
      t.coins > 0 &&
      t.url &&
      !t.needsClicks &&
      t.timesJoined < t.timesLimit,
  );
  console.log(
    `[collector] task board: ${pending.length} claimable of ${tasks.length}`,
  );

  let done = 0;
  let spentMs = 0;
  for (const task of pending) {
    if (done >= TASK_MAX_PER_RUN || spentMs > TASK_BUDGET_MS) break;

    const repeats = Math.max(1, Math.min(task.timesLimit - task.timesJoined, 3));
    for (let r = 0; r < repeats; r++) {
      if (done >= TASK_MAX_PER_RUN || spentMs > TASK_BUDGET_MS) break;

      const before = state.apiBalance ?? (await extractBalance(page));
      const dwell = task.dwellMs + DWELL_BUFFER_MS;
      const t0 = Date.now();
      let ok = false;
      try {
        const tp = await ctx.newPage();
        attachProbes(tp, state);
        await tp
          .goto(task.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT })
          .catch(() => {});
        await tp.waitForTimeout(dwell);
        await tp.close().catch(() => {});
        ok = true;
      } catch (err) {
        console.log(`[collector] task ${task.taskId} failed: ${err.message}`);
      }
      spentMs += Date.now() - t0;
      if (!ok) continue;

      // Balance updates asynchronously after dwell — give it a moment.
      const deadline = Date.now() + 8000;
      let after = state.apiBalance ?? before;
      while (Date.now() < deadline && after <= before) {
        await sleep(700);
        after = state.apiBalance ?? after;
      }
      const gained = after - before;
      if (gained > 0) {
        claimed.push({ source: task.title, coins: gained, balanceAfter: after });
        console.log(`[collector] task claimed: ${task.title} +${gained} (${after})`);
      } else {
        console.log(`[collector] task ${task.taskId} (${task.title}) credited nothing`);
        break; // this task won't pay again
      }
      done++;
    }
  }
  return claimed;
}

/**
 * Best-effort coin balance extraction.
 * The balance is rendered as "digit roll" containers: each roll holds digits
 * 0-9 and is shifted with `translateY(-12.48px * digit)`.
 *
 * NOTE (2026-10-01): the inner element's class name changed upstream, so
 * looking for a hard-coded `aecoin-digitRollContent` silently returned 0 for
 * every account. The offset now lives on whatever descendant carries it, so we
 * scan the roll and its descendants instead of trusting class names.
 */
async function extractBalance(page) {
  try {
    return await page.evaluate(() => {
      const all = [...document.querySelectorAll('[class*="digitRoll"]')];
      // Keep only the OUTERMOST roll elements — the inner content element also
      // matches "digitRoll", and counting both doubles every digit.
      const rolls = all.filter(
        (el) => !el.parentElement || !el.parentElement.closest('[class*="digitRoll"]'),
      );
      if (!rolls.length) return 0;
      let digits = "";
      for (const r of rolls) {
        // The offset may sit on the roll itself or on any descendant.
        let m = null;
        const candidates = [r, ...r.querySelectorAll("*")];
        for (const el of candidates) {
          const style = (el.getAttribute && el.getAttribute("style")) || "";
          const mm = style.match(/translateY\(\s*(-?[\d.]+)px\s*\)/);
          if (mm) {
            m = mm;
            break;
          }
        }
        if (!m) return 0;
        const digit = Math.round(Math.abs(parseFloat(m[1])) / 12.48) % 10;
        digits += String(digit);
      }
      return parseInt(digits, 10) || 0;
    });
  } catch {
    return 0;
  }
}

/** Read balance twice (1.2s apart) and return the last stable value. */
async function readBalanceStable(page) {
  const first = await extractBalance(page);
  await sleep(1200);
  const second = await extractBalance(page);
  return second > 0 ? second : first;
}

/**
 * Fast balance read after a click: polls every 500ms and returns as soon as the
 * balance moves past the baseline (credit is usually visible in 1-2s), instead
 * of sleeping a blind 3-5s first. Falls back to the last seen value on timeout.
 */
async function readBalanceAfterChange(page, baseline, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = await extractBalance(page);
  while (Date.now() < deadline) {
    if (last > baseline) break;
    await sleep(500);
    const v = await extractBalance(page);
    if (v > 0) last = v;
  }
  await sleep(700); // let the digit-roll animation settle
  const fin = await extractBalance(page);
  return fin > 0 ? fin : last;
}

/**
 * True when today's check-in is already done (page state, not guesswork):
 *  - the "Today" reward card carries the checked class, or
 *  - the subtitle says "Get X coins tomorrow!", or
 *  - the #signButton reads "Earn more coins" (its state after claiming)
 */
async function isTodayChecked(page) {
  if (await visible(page, '[id="sign-other-card"][class*="aecoin-today-checked"]')) {
    return true;
  }
  try {
    const sub = await page
      .evaluate(() => {
        const el = document.querySelector('[class*="aecoin-signSubtitle"]');
        return el ? el.innerText : "";
      })
      .catch(() => "");
    if (/tomorrow/i.test(sub)) return true;
    const btn = await page
      .evaluate(() => {
        const el = document.querySelector("#signButton");
        return el ? (el.innerText || "").trim() : "";
      })
      .catch(() => "");
    if (/earn more/i.test(btn)) return true;
  } catch {}
  return false;
}

/** Check-in streak + calendar rewards for the report. */
async function getCheckInInfo(page) {
  try {
    return await page.evaluate(() => {
      const out = { streak: 0, days: [] };
      const dayNum = document.querySelector('[class*="aecoin-dayNumber"]');
      if (dayNum) {
        out.streak = parseInt(dayNum.innerText.replace(/\D/g, ""), 10) || 0;
      }
      document
        .querySelectorAll('[class*="aecoin-rewardItem"]')
        .forEach((card) => {
          const day = card.querySelector('[class*="aecoin-rewardDay"]');
          const val = card.querySelector('[class*="aecoin-rewardValue"]');
          const checked = /today-checked/.test(card.className);
          if (day && val) {
            out.days.push({
              day: day.innerText.trim(),
              coins: parseInt(val.innerText.replace(/\D/g, ""), 10) || 0,
              checked,
            });
          }
        });
      return out;
    });
  } catch {
    return { streak: 0, days: [] };
  }
}

async function launchContext({ blockHeavy = true } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-breakpad",
      "--mute-audio",
      "--no-first-run",
    ],
  });
  const ctx = await browser.newContext({
    userAgent: MOBILE_UA,
    viewport: { width: 390, height: 844 },
    locale: "en-US",
  });
  // Abort heavy resources (images/fonts/media) during collection — we only
  // need the DOM text, buttons and the balance digit rolls. This cuts page
  // CPU/RAM massively. Debug inspection renders fully for diagnosis.
  if (blockHeavy) {
    await ctx
      .route("**/*", (route) => {
        const type = route.request().resourceType();
        if (
          type === "image" ||
          type === "font" ||
          type === "media" ||
          type === "texttrack"
        ) {
          return route.abort();
        }
        return route.continue();
      })
      .catch(() => {});
  }
  return { browser, ctx };
}

/**
 * Collect coins for one session.
 *
 * Verifies the actual outcome instead of assuming success:
 *  - balance is read before AND after clicking the collect button
 *  - a balance increase = real collection (exact delta reported)
 *  - button disappearing / "done" text / prior claim today = already done
 *  - button clicked but no change = reported as uncertain + debug screenshot
 *
 * @param {string} cookies
 * @param {{ alreadyClaimedToday?: boolean }} [opts]
 * @returns {{ totalCoins, results, expired, balance }}
 */
async function collectAll(cookies, opts = {}) {
  const results = [];
  let totalCoins = 0;
  let expired = false;
  let balance = 0;
  let sources = [];

  let browser = null;
  const t0 = Date.now();
  try {
    const lc = await launchContext();
    browser = lc.browser;

    await lc.ctx.addCookies(mergeLocaleCookies(parseCookies(cookies)));
    const page = await lc.ctx.newPage();

    // Live probes: authoritative balance (API) + task board list.
    const state = { apiBalance: null, tasks: null, tasksAt: 0 };
    attachProbes(page, state);

    // First visit main site to establish session
    await page
      .goto("https://m.aliexpress.com/", {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      })
      .catch(() => {});
    await page.waitForTimeout(2000);

    // Then go to coin page
    await page
      .goto(COIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      })
      .catch(() => {});
    await waitForCoinPage(page);

    // Session expired → redirected to login
    if (await isLoginPage(page)) {
      console.log("[collector] Login page — session expired");
      await saveDebug("expired", page);
      results.push({
        task: "Daily Sign-in",
        success: false,
        coins: 0,
        message: "Session expired",
      });
      return { totalCoins: 0, results, expired: true, balance: 0 };
    }

    // Wait for the coin UI to render
    await waitForAny(page, COLLECT_SELECTORS, RENDER_TIMEOUT);

    // Extract the embedded page data (balance / check-in / task board)
    const pageData = await getPageData(page);
    const dataInfo = analyzePageData(pageData);
    const checkInFromData = checkInDoneFromDataFlag(dataInfo.checkIn);

    const signButtonText = async () => {
      try {
        return (
          (await page.locator("#signButton").first().innerText({ timeout: 3000 }).catch(() => "")) || ""
        ).trim();
      } catch {
        return "";
      }
    };

    const isEarnMoreState = (t) => /earn more/i.test(t || "");

    const collectBtnVisible = async () => {
      for (const s of COLLECT_SELECTORS) {
        if (!(await visible(page, s))) continue;
        // #signButton is dual-purpose: after a successful check-in it reads
        // "Earn more coins" and must NOT be treated as a collect button.
        if (s === "#signButton" && isEarnMoreState(await signButtonText())) continue;
        return s;
      }
      return null;
    };

    const clickCollect = async () => {
      for (const s of COLLECT_SELECTORS) {
        if (!(await visible(page, s))) continue;
        if (s === "#signButton" && isEarnMoreState(await signButtonText())) continue;
        try {
          await page.locator(s).first().click({ force: true, timeout: ACTION_TIMEOUT });
          console.log(`[collector] Clicked: ${s}`);
          return s;
        } catch (err) {
          console.log(`[collector] Click failed on ${s}: ${err.message}`);
        }
      }
      return null;
    };

    // Second-step claim inside the check-in calendar modal/dialog.
    // The first click on #signButton often just OPENS this modal — the 40-coin
    // reward needs an explicit click on the Today card / modal Collect button.
    // These selectors are intentionally scoped to dialog/modal/calendar so a
    // stray +1 task button is never mistaken for the daily sign-in.
    const MODAL_CLAIM_SELECTORS = [
      '[class*="dialog"] button:has-text("Collect")',
      '[class*="modal"] button:has-text("Collect")',
      '[class*="popup"] button:has-text("Collect")',
      '[class*="calendar"] button:has-text("Collect")',
      '[class*="dialog"] button:has-text("Claim")',
      '[class*="modal"] button:has-text("Claim")',
      '[class*="popup"] button:has-text("Claim")',
      '[class*="calendar"] button:has-text("Claim")',
      '[class*="rewardItem"]:has-text("Today")',
      '[class*="reward-item"]:has-text("Today")',
      '[class*="checkin"] button:has-text("Collect")',
      '[class*="signin"] button:has-text("Collect")',
    ];

    const clickModalClaim = async () => {
      for (const s of MODAL_CLAIM_SELECTORS) {
        const btn = page.locator(s).first();
        if (!(await btn.isVisible().catch(() => false))) continue;
        const txt = (await btn.innerText().catch(() => "")).trim();
        if (/earn more/i.test(txt)) continue;
        try {
          await btn.click({ force: true, timeout: ACTION_TIMEOUT });
          console.log(`[collector] Clicked modal: ${s} ("${txt.slice(0, 40)}")`);
          return s;
        } catch (err) {
          console.log(`[collector] Modal click failed on ${s}: ${err.message}`);
        }
      }
      return null;
    };

    const push = (entry) => results.push(entry);

    // ── Daily sign-in ──────────────────────────────────────
    const todayChecked = await isTodayChecked(page);
    const btnBefore = await collectBtnVisible();
    const balBefore = await readBalanceStable(page);
    if (dataInfo.balance > 0) balance = dataInfo.balance;

    if (!btnBefore || todayChecked) {
      // No button, or page confirms today is already claimed
      if (todayChecked || (await alreadyDone(page)) || opts.alreadyClaimedToday) {
        push({
          task: "Daily Sign-in",
          success: true,
          coins: 0,
          message: "Already done today",
        });
      } else {
        await saveDebug("no-button", page);
        push({
          task: "Daily Sign-in",
          success: false,
          coins: 0,
          message: "No collect button found",
        });
      }
    } else {
      // Click the collect button (one click opens the calendar modal on some
      // accounts — the reward needs a second, modal-scoped click).
      const clicked = await clickCollect();
      console.log(`[collector] signButton before: "${(await signButtonText()).slice(0, 60)}" balBefore=${balBefore}`);
      let balAfter = await readBalanceAfterChange(page, balBefore, 6000);
      let btnAfter = await collectBtnVisible();
      // NOTE: re-evaluate page state fresh — never reuse pre-click flags here.
      let doneAfter = (await alreadyDone(page)) || (await isTodayChecked(page));
      if (balAfter > 0) balance = balAfter;

      const reportGained = (after) => {
        const gained = after - balBefore;
        totalCoins += gained;
        push({
          task: "Daily Sign-in",
          success: true,
          coins: gained,
          message: `Collected ${gained} coins (balance ${after})`,
        });
      };

      if (balAfter > balBefore) {
        // Balance went up — real collection, exact delta.
        // Guard: if the modal is still open with an unclaimed 40, don't stop
        // at a +1 popup — try the modal claim first.
        const modalOpen = await clickModalClaim();
        if (modalOpen) {
          const balAfterModal = await readBalanceAfterChange(page, balAfter, 5000);
          if (balAfterModal > balAfter) {
            reportGained(balAfterModal);
            balance = balAfterModal;
          } else {
            reportGained(balAfter);
          }
        } else {
          reportGained(balAfter);
        }
      } else if (!btnAfter || doneAfter) {
        // Button gone or done-state → claimed (now or earlier today)
        if (balBefore === 0 && balAfter === 0) {
          push({
            task: "Daily Sign-in",
            success: true,
            coins: 0,
            message: "Checked in — balance unreadable",
          });
        } else {
          push({
            task: "Daily Sign-in",
            success: true,
            coins: 0,
            message: "Already done today",
          });
        }
      } else if (clicked) {
        // Clicked but no credit yet — the calendar modal is probably open with
        // the 40-coin reward unclaimed. NEVER re-click generic COLLECT_SELECTORS
        // here (that hit a +1 task button and misreported it as Daily Sign-in).
        // Only click modal-scoped claim buttons.
        const modalClicked = await clickModalClaim();
        const balAfter2 = await readBalanceAfterChange(page, balBefore, 6000);
        const doneAfter2 = (await alreadyDone(page)) || (await isTodayChecked(page));
        if (balAfter2 > 0) balance = Math.max(balance, balAfter2);
        console.log(`[collector] retry: modalClicked=${modalClicked} balBefore=${balBefore} balAfter2=${balAfter2} done=${doneAfter2}`);
        if (balAfter2 > balBefore) {
          reportGained(balAfter2);
          balance = balAfter2;
        } else if (doneAfter2 || !(await collectBtnVisible())) {
          push({
            task: "Daily Sign-in",
            success: true,
            coins: 0,
            message: "Already done today",
          });
        } else {
          await saveDebug("uncertain", page);
          push({
            task: "Daily Sign-in",
            success: false,
            coins: 0,
            message: "Button clicked but no coins credited — run /debug",
          });
        }
      } else {
        await saveDebug("uncertain", page);
        push({
          task: "Daily Sign-in",
          success: false,
          coins: 0,
          message: "Could not click collect button — run /debug",
        });
      }
    }

    // ── Task rewards (earn-more board) ─────────────────────
    // API-driven: open the board, then complete each task by dwelling on its
    // own page for the server-specified time. Every claim verified by balance.
    const taskClaims = await claimEarnedTasks(lc.ctx, page, state, opts);
    for (const c of taskClaims) {
      totalCoins += c.coins;
      balance = Math.max(balance, c.balanceAfter || 0);
      push({
        task: c.source || "Task reward",
        success: true,
        coins: c.coins,
        message: `Task claimed (+${c.coins})`,
      });
    }

    // ── Source breakdown for the report ────────────────────
    // Final balance: API probe is authoritative, digit rolls are the fallback
    // (they render a beat after the SPA paints, so retry once before giving up).
    let finalBal = balance || state.apiBalance || 0;
    if (!finalBal) {
      await waitForAny(page, ['[class*="aecoin-digitRollContainer"]'], 5000);
      finalBal = await extractBalance(page);
    }
    if (state.apiBalance > finalBal) finalBal = state.apiBalance;
    if (finalBal > 0) balance = finalBal; // report the balance even on already-done runs
    const srcList = [];
    if (finalBal > 0) srcList.push({ source: "Balance", coins: finalBal });

    const checkIn = await getCheckInInfo(page);
    if (checkIn.streak > 0) {
      srcList.push({
        source: `Check-in streak (day ${checkIn.streak})`,
        coins: 0,
        status: checkIn.days.length ? `next: ${checkIn.days[0].coins} coins` : "",
      });
    }
    for (const d of checkIn.days) {
      srcList.push({
        source: `Check-in ${d.day}`,
        coins: d.coins,
        status: d.checked ? "(claimed)" : "",
      });
    }

    const seen = new Set();
    for (const s of dataInfo.sources) {
      const key = String(s.source).slice(0, 40);
      if (!s.coins || seen.has(key)) continue;
      seen.add(key);
      srcList.push({
        source: s.source,
        coins: s.coins,
        status: s.status ? `(${s.status})` : "",
      });
    }
    sources = srcList;
  } catch (err) {
    console.error("[collector] Error:", err.message);
    if (!results.length) {
      results.push({
        task: "Daily Sign-in",
        success: false,
        coins: 0,
        message: `Error: ${err.message}`,
      });
    }
  } finally {
    await browser?.close().catch(() => {});
  }

  console.log(
    `[collector] finished in ${Math.round((Date.now() - t0) / 1000)}s ` +
      `(total=${totalCoins} expired=${expired})`
  );
  return { totalCoins, results, expired, balance, sources };
}

/**
 * collectAll with retry logic.
 * Only a real session expiry short-circuits; transient errors get retried.
 * A global lock prevents two Chromium instances running at once (RAM/CPU).
 */
async function collectWithRetry(cookies, opts = {}) {
  if (collecting) {
    return {
      totalCoins: 0,
      results: [
        {
          task: "Collection",
          success: false,
          coins: 0,
          message: "Another collection is already running — try again in a minute",
        },
      ],
      expired: false,
      skipped: true,
    };
  }

  collecting = true;
  try {
    for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
      try {
        const result = await collectAll(cookies, opts);
        if (result.expired) return result;
        if (result.results.length > 0) return result;
      } catch (err) {
        console.error(`Attempt ${attempt}/${RETRY_COUNT} failed:`, err.message);
      }
      if (attempt < RETRY_COUNT) {
        console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
    return {
      totalCoins: 0,
      results: [
        {
          task: "Collection",
          success: false,
          coins: 0,
          message: `Failed after ${RETRY_COUNT} retries`,
        },
      ],
      expired: false,
    };
  } finally {
    collecting = false;
  }
}

/**
 * Deep page inspection — used by the /debug command to diagnose issues.
 * Covers the exact signals the collector decides on (sign-in button text,
 * today-claimed state, streak/calendar, stray modals) so a +1-instead-of-40
 * style failure can be diagnosed per account without guessing.
 * @returns {Promise<{url: string, login: boolean, balance: number, signButton: string, todayChecked: boolean, streak: number, days: Array, hasModal: boolean, aecoinClasses: string[], texts: string[], shotPath: string|null}>}
 */
async function debugInspect(cookies) {
  let browser = null;
  try {
    const lc = await launchContext({ blockHeavy: false });
    browser = lc.browser;
    await lc.ctx.addCookies(mergeLocaleCookies(parseCookies(cookies)));
    const page = await lc.ctx.newPage();

    await page
      .goto("https://m.aliexpress.com/", {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      })
      .catch(() => {});
    await page.waitForTimeout(2000);

    await page
      .goto(COIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      })
      .catch(() => {});
    await waitForCoinPage(page);
    // The SPA renders shell first, calendar/check-in data seconds later (live
    // test: reading immediately gave empty signButton/streak on a valid session).
    // Wait for the actionable UI like collectAll() does, then let it settle.
    await waitForAny(page, [...COLLECT_SELECTORS, ...LOGIN_SELECTORS], RENDER_TIMEOUT);
    await page.waitForTimeout(2000);

    const url = page.url();
    const login = await isLoginPage(page);
    const balance = await extractBalance(page);

    // The exact signals collectAll() decides on — surfaced for diagnosis.
    const signButton = await page
      .evaluate(() => {
        const el = document.querySelector("#signButton");
        return el ? (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60) : "(no #signButton)";
      })
      .catch(() => "(unreadable)");
    const todayChecked = await isTodayChecked(page);
    const checkIn = await getCheckInInfo(page);
    // Claim-popup detection: a visible dialog/modal/popup/calendar that actually
    // contains a Collect/Claim/Get button (plain containers and cookie banners
    // don't count — they made this flag noise on login pages).
    const hasModal = await page
      .evaluate(() => {
        const boxes = [...document.querySelectorAll("[class*='dialog'],[class*='modal'],[class*='popup'],[class*='calendar']")];
        return boxes.some((box) => {
          const r = box.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const btns = [...box.querySelectorAll("button")];
          return btns.some((b) => {
            const t = (b.innerText || "").trim();
            if (!t || b.getBoundingClientRect().width <= 0) return false;
            return /collect|claim|\u0627\u062c\u0645\u0639|\u0627\u0633\u062a\u0644\u0627\u0645|\u0627\u062d\u0635\u0644/i.test(t);
          });
        });
      })
      .catch(() => false);

    const aecoinClasses = await page
      .evaluate(() => {
        const set = new Set();
        document.querySelectorAll("[class]").forEach((el) => {
          String(el.className)
            .split(/\s+/)
            .forEach((c) => {
              if (c.startsWith("aecoin")) set.add(c);
            });
        });
        return [...set];
      })
      .catch(() => []);

    const texts = await page
      .evaluate(() => {
        const out = [];
        document.querySelectorAll("button, [class*='aecoin']").forEach((el) => {
          const cls = String(el.className || "");
          if (cls.includes("digit")) return; // balance digit rolls = noise
          const t = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
          if (!t) return;
          if (/^[\d][\d ]{5,}[\d]?$/.test(t)) return; // digit strips = noise
          // Balance/US-price fragments ("0 1 2 3 ... ≈ US $7.49") carry no
          // diagnostic value: skip digit-strip-headed containers and anything
          // without a real word (4+ letters).
          const headDigits = (t.slice(0, 20).match(/[0-9]/g) || []).length;
          if (headDigits >= 10) return;
          if (!/[a-zA-Z\u0600-\u06FF]{4,}/.test(t)) return;
          out.push(t);
        });
        return out.slice(0, 30);
      })
      .catch(() => []);

    let shotPath = null;
    let dataPath = null;
    let htmlPath = null;
    try {
      const dir = path.join(__dirname, "..", "data", "debug");
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      shotPath = path.join(dir, `inspect-${ts}.png`);
      await page.screenshot({ path: shotPath });
      htmlPath = path.join(dir, `inspect-${ts}.html`);
      fs.writeFileSync(htmlPath, await page.content().catch(() => ""));
      const pageData = await getPageData(page);
      dataPath = path.join(dir, `inspect-${ts}.json`);
      fs.writeFileSync(dataPath, JSON.stringify(pageData, null, 2));
      pruneDebugFiles();
    } catch {}

    return { url, login, balance, signButton, todayChecked, streak: checkIn.streak || 0, days: checkIn.days || [], hasModal, aecoinClasses, texts, shotPath, dataPath, htmlPath };
  } catch (err) {
    return { url: "", login: false, balance: 0, signButton: "", todayChecked: false, streak: 0, days: [], hasModal: false, aecoinClasses: [], texts: [], shotPath: null, dataPath: null, error: err.message };
  } finally {
    await browser?.close().catch(() => {});
  }
}

module.exports = {
  collectAll,
  collectWithRetry,
  debugInspect,
  isCollecting,
  clearDebugFiles,
};
