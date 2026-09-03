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
const RETRY_DELAY_MS = 30 * 1000;
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

// Task claim buttons (English + Arabic)
const CLAIM_BUTTON_SELECTORS = [
  'button:has-text("Collect")',
  'button:has-text("Claim")',
  'button:has-text("Get")',
  'button:has-text("Receive")',
  'button:has-text("اجمع")',
  'button:has-text("استلام")',
  'button:has-text("احصل")',
];

/**
 * Best-effort claiming of ready task rewards on the earn-more board.
 * Each claim is verified against the balance (delta = coins gained).
 * Capped to avoid excessive automation; failures are reported, not fatal.
 */
async function claimReadyTasks(page, opts = {}) {
  const claimed = [];
  const MAX_CLAIMS = opts.maxClaims || 5;

  // Open the earn-more board first (the #signButton becomes "Earn more coins"
  // after check-in; when not checked in it's the check-in button itself).
  try {
    const signBtn = page.locator("#signButton").first();
    if (await signBtn.isVisible().catch(() => false)) {
      const txt = (await signBtn.innerText().catch(() => "")).trim();
      if (/earn more/i.test(txt)) {
        console.log("[collector] Opening earn-more board...");
        await signBtn.click({ force: true, timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(3000);
      }
    }
  } catch {}

  let balBefore = await readBalanceStable(page);

  for (let i = 0; i < MAX_CLAIMS; i++) {
    // Scroll through the page so lazy-loaded tasks become visible
    await page.evaluate(() => {
      window.scrollBy(0, 400);
    }).catch(() => {});
    await page.waitForTimeout(800);

    let clicked = false;
    let clickedText = "";
    for (const s of CLAIM_BUTTON_SELECTORS) {
      const btn = page.locator(s).first();
      if (!(await btn.isVisible().catch(() => false))) continue;
      const txt = (await btn.innerText().catch(() => "")).trim();
      if (/^#?\s*[\d.,]+$/.test(txt)) continue; // safety: never click bare numbers
      try {
        await btn.click({ force: true, timeout: 10000 });
        clicked = true;
        clickedText = txt;
        break;
      } catch {}
    }

    if (!clicked) break; // no more claim buttons

    await page.waitForTimeout(2500);
    const balAfter = await readBalanceStable(page);
    const gained = balAfter - balBefore;
    if (gained > 0) {
      claimed.push({ source: clickedText || "Task", coins: gained, balanceAfter: balAfter });
      balBefore = balAfter;
    } else {
      // Nothing gained — button probably required a precondition; stop here
      break;
    }
  }

  await page.evaluate(() => {
    window.scrollTo(0, 0);
  }).catch(() => {});
  return claimed;
}

/**
 * Best-effort coin balance extraction.
 * The balance is rendered as "digit roll" containers: each roll holds digits
 * 0-9 and is shifted with `translateY(-12.48px * digit)`. Read the offsets.
 */
async function extractBalance(page) {
  try {
    return await page.evaluate(() => {
      const rolls = [
        ...document.querySelectorAll('[class*="aecoin-digitRollContainer"]'),
      ];
      if (!rolls.length) return 0;
      let digits = "";
      for (const r of rolls) {
        const content = r.querySelector('[class*="aecoin-digitRollContent"]');
        if (!content) return 0;
        const style = content.getAttribute("style") || "";
        const m = style.match(/translateY\((-?[\d.]+)px\)/);
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

/** Read balance twice (1.5s apart) and return the last stable value. */
async function readBalanceStable(page) {
  const first = await extractBalance(page);
  await sleep(1500);
  const second = await extractBalance(page);
  return second > 0 ? second : first;
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
  try {
    const lc = await launchContext();
    browser = lc.browser;

    await lc.ctx.addCookies(mergeLocaleCookies(parseCookies(cookies)));
    const page = await lc.ctx.newPage();

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

    const collectBtnVisible = async () => {
      for (const s of COLLECT_SELECTORS) {
        if (await visible(page, s)) return s;
      }
      return null;
    };

    const clickCollect = async () => {
      for (const s of COLLECT_SELECTORS) {
        if (!(await visible(page, s))) continue;
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
      // Click the collect button
      const clicked = await clickCollect();
      await page.waitForTimeout(3000);

      const balAfter = await readBalanceStable(page);
      const btnAfter = await collectBtnVisible();
      const doneAfter = (await alreadyDone(page)) || checkInFromData || todayChecked;
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
        // Balance went up — real collection, exact delta
        reportGained(balAfter);
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
        // Clicked but nothing visibly changed → try once more before giving up
        await clickCollect();
        await page.waitForTimeout(3000);
        const balAfter2 = await readBalanceStable(page);
        if (balAfter2 > balBefore) {
          reportGained(balAfter2);
          balance = balAfter2;
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
    // Claim ready one-click rewards; each verified by balance delta.
    const taskClaims = await claimReadyTasks(page, opts);
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
    const finalBal = balance || (await extractBalance(page));
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
 * @returns {Promise<{url: string, login: boolean, balance: number, aecoinClasses: string[], texts: string[], shotPath: string|null}>}
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

    const url = page.url();
    const login = await isLoginPage(page);
    const balance = await extractBalance(page);

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
          if (t && !/^[\d][\d ]{5,}[\d]?$/.test(t)) out.push(t);
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

    return { url, login, balance, aecoinClasses, texts, shotPath, dataPath, htmlPath };
  } catch (err) {
    return { url: "", login: false, balance: 0, aecoinClasses: [], texts: [], shotPath: null, dataPath: null, error: err.message };
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
