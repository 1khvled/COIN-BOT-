# CHAT_CONTEXT.md — AliExpress Coin Collector Bot: full A→Z timeline

> **Living document.** Every agent (human or AI) that touches this project MUST append a
> timestamped entry to `## Timeline` below. See `AGENTS.md` — the update rule is mandatory,
> not optional. Newest entries go at the BOTTOM of the timeline.

## 1. Project overview
- Telegram bot (Node.js) that auto-collects AliExpress coins using the user's real
  session cookies + headless Chromium (Playwright).
- Private single-user bot. Admin chat `1759675108`, `MULTI_USER=false`, `TZ=Africa/Algiers`.
- Not a git repo. `.env` holds real secrets — never print, commit, or paste token/secret values.
- Bot token username: `CoinsaliexpresBOT` (verified via `getMe`).

## 2. Paths & runtime identity (must-know for any future session)
| Item | Value |
|---|---|
| Project | `C:\Users\Abdelli\Desktop\Projects\TELEGRAM\aliexpress-coin-bot` |
| Entry | `src\index.js` (banner → `db.init` → `createBot` → `initScheduler` → catch-up) |
| DB | `data/bot.db` (sql.js; tables: `accounts`, `collection_logs`, `settings`) |
| Logs | `logs\bot.log` (UTF-8, bot holds it open; PowerShell `>>` once polluted it with UTF-16 — decode tails as UTF-8 bytes) |
| Launcher | `start-bg.vbs` (wscript, hidden window, restarts bot 5s after crash; `logs\.stop` disables restart) |
| Process name | **`rtnode.exe`** (copy of node.exe at `C:\ProgramData\Runtime\rtnode.exe`, hidden+system). NOT `node.exe`. |
| Scheduled task | `RuntimeHelper` (AtLogOn, StartWhenAvailable, RestartCount 3, no time limit). Old `AliExpressCoinBot` task unregistered. |
| Kill filter | `CommandLine -like '*src\index.js*'` on `rtnode.exe`/`node.exe` (CommandLine has NO full project path, so never filter by folder name) |
| Heap cap | `--max-old-space-size=128` (set in `start-bg.vbs`) |
| Chromium | Playwright v1223 (`chromium-1223` + `chromium_headless_shell-1223` under `%LOCALAPPDATA%\ms-playwright`) |
| Project folder | hidden+system attributes set (invisible in Explorer by default) |

## 3. Verified AliExpress page facts
- Coin page is an AE DIDA SPA: `https://m.aliexpress.com/p/coin-index/index.html`.
- Algeria IPs get Arabic → **English forced via locale cookies AFTER user cookies**:
  `aeep_hng=en_US`, `aep_usuc_f=site=glo&region=US&b_locale=en_US`,
  `intl_locale=en_US`, `xman_us_f=x_l=0&x_locale=en_US` (`mergeLocaleCookies`, `src/collector.js`).
- Balance = digit-roll DOM: `.aecoin-digitRollContainer` → `.aecoin-digitRollContent`,
  `translateY(-12.48px * digit)` mod 10. Verified offsets `-12.48/-62.4/-99.84/0` = digits 1,5,8,0 = **1580** (matched user's real balance).
- Claim button = stable id **`#signButton`**. After claiming it reads **"Earn more coins"**
  (not "Check in" — old detection broke on this).
- Already-done = `isTodayChecked()`: `#sign-other-card` has `aecoin-today-checked-*` class,
  OR subtitle says "tomorrow", OR `#signButton` text is "Earn more coins".
- Calendar: Today 10 (✓), Tomorrow 15, Day3 20, Day4 30, Day5 40, Day6 50, Day7 50.
  Streak day number in `aecoin-dayNumber-*`. `getCheckInInfo()` reports streak + calendar.
- `claimReadyTasks()` clicks `#signButton` ("Earn more coins") to open the earn-more board first,
  then delta-verified claims; skips bare-number buttons (`src/collector.js`).
- `window._dida_config_.data` is `{}` — real data arrives via XHR `/fn/coin-index/index`
  (interception optional, never implemented; DOM extraction works without it).
- Session expiry signal = login page (`isLoginPage`), saved as `expired-*` debug + status `expired`.

## 4. Schedule & behavior
- Collections run **every 12h at 08:00 & 20:00 Africa/Algiers** (`startSchedule`, setTimeout chain —
  node-cron was REMOVED to kill its 1s tick; near-zero idle CPU).
- Boot catch-up: `shouldCatchUp()` runs one collection at startup if past 08:00 with no log today
  (`src/index.js:34-40`, `src/scheduler.js`).
- `/collect`/`/debug` guarded by `isCollecting()` lock; concurrent runs return `skipped:true`
  with a clean "already running" message (`src/bot.js`, `src/collector.js`).
- Polling: 3s interval + 25s long-poll timeout (`src/bot.js:36-40`).
- Expired accounts are SKIPPED by the scheduler (no Chromium, no repeat failure spam) until
  fresh cookies are added (`src/scheduler.js`).
- `/addaccount` alias prompt rejects cookie-looking text (prevents duplicate bad imports)
  (`src/bot.js` `finishAddAccount`).
- Bot sends expired-session + per-account result notifications to admin chat.

## 5. Debug artifacts policy
- `data/debug/` holds ONLY disposable screenshots/HTML/JSON. **Never delete `data/bot.db`, `.env`.**
- `saveDebug()` saves NOTHING unless `DEBUG_ARTIFACTS=true` (just clears the dir).
- `/debug` still sends its screenshot to Telegram, then deletes temp files by default.
- `pruneDebugFiles(maxKeep)` retained; `clearDebugFiles()` = prune to 0 (exported).
- Browser contexts are ephemeral, closed after every run (`launchContext`, `blockHeavy` aborts
  image/font/media/texttrack during collection; full render only for `/debug`).

## 6. Hosting verdict (researched 2026-08-31, keep local)
- **Vercel Functions**: no (Hobby max 300s, Pro/Enterprise max 800s, no persistent process/Chromium).
- **Cloudflare Workers + Browser Rendering**: rewrite-only; free = 10 min browser/day; paid = 10h/mo then $0.09/browser-hour. Datacenter IP would kill AE sessions anyway.
- **Render Free**: spins down after 15 min idle — 08:00/20:00 jobs would be missed.
- **Oracle Cloud Always Free VM**: the ONLY free host that fits (2 OCPUs/12GB or 2× Micro, 200GB),
  but needs manual setup + card, capacity is flaky ("out of host capacity"), and datacenter IP
  shortens session life. User decision: **stay on local PC**; revisit only on request
  (then generate Dockerfile + systemd + deploy script).
- Core reason local wins: AE binds sessions to home IP/device; user's IP keeps cookies alive
  (sessions still expire every ~2–15 days and need fresh cookie paste via `/addaccount`).

## 7. Manage-cheat-sheet (Windows PowerShell 5.1, run from project dir)
```powershell
# status: task + processes
Get-ScheduledTask -TaskName "RuntimeHelper" | Select-Object TaskName, State
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'rtnode.exe' -or ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*start-bg.vbs*') } | Select-Object Name, ProcessId, CreationDate
# restart bot (vbs respawns with new code)
Stop-ScheduledTask -TaskName "RuntimeHelper"
Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'rtnode.exe' -and $_.CommandLine -like '*src\index.js*') -or ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*start-bg.vbs*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName "RuntimeHelper"
# stop permanently: New-Item logs\.stop (loop exits); then stop task + kill processes
# syntax check before every restart:
node --check src\bot.js; if ($?) { node --check src\scheduler.js }; if ($?) { node --check src\collector.js }
# read log tail (UTF-8, file locked while running):
$bytes = Get-Content "logs\bot.log" -Encoding Byte -Raw; ([System.Text.Encoding]::UTF8.GetString($bytes) -split "`r?`n") | Select-Object -Last 20
# Telegram reachability: GET https://api.telegram.org/bot<TOKEN>/getMe (expect ok:true, empty webhook url)
```

## 8. Timeline (APPEND ONLY — newest at bottom, format: `### YYYY-MM-DD — title`)

### 2026-08-16 — Balance fix + claim/done detection (morning)
- `extractBalance()` rewritten to parse digit-roll `translateY` offsets (12.48px/digit, `%10`);
  verified against real `data/debug/uncertain-*.html` → 1580 = user's real balance.
- Claim button `#signButton` added first in selectors; `isTodayChecked()` added
  (Today-card checked class / "tomorrow" subtitle / "Earn more coins" button text).
- `getCheckInInfo()` (streak + calendar), `claimReadyTasks()` earn-more board flow,
  `debugInspect` digit-noise filter. Bot restarted (PID 18724).

### 2026-08-16 — Perf pass + /debug full-render fix
- `db.js`: debounced `saveToDisk()` (1s) + `flush()` on close; `collector.js`: `launchContext({blockHeavy})`
  (abort image/font/media), extra Chromium flags, `isCollecting()` lock, marker-based
  `waitForCoinPage()`, `pruneDebugFiles(20)`; `bot.js`: polling 2s/25s, `skipped` handling.
- `/debug` uses `blockHeavy:false` (full render) + saves `inspect-*.html`; syntax checks pass.

### 2026-08-19 — Auto-start hardening + stealth (user: hidden, self-healing, light)
- Root-caused "not running": `scheduler.runAllCollections` was defined but NOT exported →
  every boot catch-up threw `TypeError` → `process.exit(1)`. Export added; bot survived boot.
- `start-bg.vbs` hardened: full-path node resolution, `logs\` auto-create, `logs\bot.log`,
  5s restart loop with `logs\.stop` sentinel.
- `schtasks` admin-denied → `Register-ScheduledTask` AtLogOn `RuntimeHelper` (no admin) +
  old `AliExpressCoinBot` task/shortcut removed. Verified boot via `Start-ScheduledTask`.

### 2026-08-19 — 12h schedule + idle tuning (user: check coins every 12h, low idle)
- node-cron removed; setTimeout chain runs 08:00 & 20:00 Africa/Algiers (verified in log).
- Polling 2s→3s; heap cap 256→128MB; idle ≈114MB working set, ~0.6s CPU.
- Confirmed today's collection: 2026-08-19 12:14:07, 30 coins (account 6).

### 2026-08-31 — "Bot is broken": 3 root causes fixed, sessions found expired
- Log showed `getaddrinfo ENOTFOUND api.telegram.org` / `ECONNRESET` bursts + 20:00 run failing:
  `chromium_headless_shell-1223` executable MISSING (whole `%LOCALAPPDATA%\ms-playwright` gone).
  Restored via `npx playwright install chromium`; `chromium.launch` test OK.
- Second bug: `start-bg.vbs` `WScript.Echo` opens hidden modal dialog under wscript.exe and
  BLOCKED startup (no child process after restart). Removed both `WScript.Echo` calls; task
  now spawns `rtnode.exe` correctly (verified PID + Telegram 149.154.166.110:443 + clean boot).
- Recovery collection reached AliExpress but ALL accounts (IDs 6/7/8) hit login page:
  `_m_h5_tk` expiries 2026-08-16 / 2026-08-19 → genuinely expired, needs fresh `/addaccount` paste.
- Safeguards added: scheduler skips `expired` accounts; alias prompt rejects cookie-like text.

### 2026-08-31 — Debug cache cleanup (user: clear Playwright cache, keep accounts)
- Deleted all 20 `data/debug` png/html files; kept `data/bot.db`, `.env`, Chromium runtime.
- `saveDebug()` no-ops unless `DEBUG_ARTIFACTS=true`; `/debug` sends photo then cleans temp files.
- Restart verified: `data/debug/` empty, bot.db present, Telegram connected, ~114MB idle.

### 2026-08-31 — Hosting re-check (user: free 24/7 host?) → stay local
- Verified vs official docs: Vercel ≤300s Hobby (no persistence), Render Free sleeps @15min idle,
  Cloudflare free = 10 min browser/day + full rewrite needed, Oracle Always Free = only fit
   but manual + capacity flaky + datacenter IP shortens sessions. User: "nvm so much work" → local stays.

### 2026-09-03 — Context docs + agent rule (user: full A→Z timeline in project)
- Created `CHAT_CONTEXT.md` (this file: overview, runtime identity, page facts, schedule,
  hosting verdict, cheat-sheet, timeline) and `AGENTS.md` (Rule 0: every agent MUST append
  a timeline entry for any inspect/change/restart/debug session before finishing).
- Verified both files exist in project root. Note: `filesystem` MCP is jailed to
  `C:\Users\Abdelli\Documents`, so project files were written via the direct write tool.
