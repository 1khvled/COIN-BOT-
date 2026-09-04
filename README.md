# 🤖 AliExpress Coin Collector — Telegram Bot

Automatically collects your AliExpress coins twice a day through a Telegram bot.
Drives a headless Chromium through the real mobile coin page (the page's own JS does the
collecting), verifies the balance actually increased, and notifies you per account.

## Features

- 🪙 **Auto-collection every 12h** (default 08:00 & 20:00 in your timezone) + missed-run catch-up at startup
- ✅ **Verified outcomes** — reads the balance before/after, reports collected vs. already-done vs. failed
- 🔐 **AES-256 encrypted** cookie storage (SQLite, no native deps)
- 📱 **Mobile-friendly Telegram UI** with inline keyboards
- 🧠 **Knows the page** — digit-roll balance parsing, check-in streak/calendar breakdown, earn-more task board
- ⚠️ **Expiry alerts** — tells you when a session dies so you can refresh cookies
- 👥 **Optional multi-user mode** — anyone can `/start` and manage their own accounts
- 🪶 **Light idle footprint** (~110MB RAM, ~zero idle CPU; Chromium only spins up during runs)
- 🐳 **Docker-ready** — Playwright base image with Chromium preinstalled

---

## 1. Prerequisites

- **Node.js 20+** and npm
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram numeric chat ID from [@userinfobot](https://t.me/userinfobot)

## 2. One-command setup

**Brand new here? Read [TUTORIAL.md](TUTORIAL.md)** — step-by-step for absolute
beginners (creating the Telegram bot, getting your chat ID, installing the cookie
helper, linking AliExpress).

**Windows (CMD) — paste one line, it does everything** (installs Git/Node if
missing, clones from GitHub, runs setup):

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=\"$env:USERPROFILE\Desktop\aliexpress-coin-bot\"; if(!(Get-Command git -EA SilentlyContinue)){winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements}; $env:Path=[System.Environment]::GetEnvironmentVariable('Path','Machine')+';'+[System.Environment]::GetEnvironmentVariable('Path','User'); if(!(Test-Path $d)){git clone https://github.com/1khvled/COIN-BOT-.git $d}; & \"$d\setup.bat\""
```

**Already cloned? Just run the setup script:**

Windows (CMD): `setup.bat` — Linux / macOS: `chmod +x setup.sh && ./setup.sh`

That's it — it installs dependencies, downloads headless Chromium, asks for your
`BOT_TOKEN` + chat ID on first run (generating the encryption secret for you), and
starts the bot. Then send `/start` to your bot in Telegram. ✅

## 2b. Manual install (if you prefer each step)

```bash
git clone <your-repo-url> aliexpress-coin-bot
cd aliexpress-coin-bot
npm install
npx playwright install chromium   # downloads headless Chromium (~170MB)
cp .env.example .env
```

Edit `.env`:

```env
BOT_TOKEN=123456:ABC-DEF...       # from @BotFather
ADMIN_CHAT_ID=987654321           # your numeric chat ID
ENCRYPT_SECRET=any-random-32-char-string!!!   # used to encrypt stored cookies
MULTI_USER=false                  # true = anyone may use the bot; false = admin only
TZ=Africa/Algiers                 # your IANA timezone
```

```bash
npm start
```

Send `/start` to your bot in Telegram. ✅

## 3. Add your AliExpress session

**Easiest — the bundled extension** (`extension/`):
1. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → select `extension/`
2. Log in at [aliexpress.com](https://aliexpress.com), click the extension icon → **Copy cookies**
3. In Telegram: `/addaccount` → paste → give it a name (or Skip)

**Manual:** F12 → Application → Cookies → `aliexpress.com`, copy all cookies as one
`name=value; name=value; …` string (must include `_m_h5_tk` and `_m_h5_tk_enc`),
then `/addaccount` and paste.

> ⚠️ Sessions expire (typically days to weeks — AliExpress binds them to IP/device).
> The bot tells you when a refresh is needed. Collecting from your own home IP keeps
> sessions alive longest.

## Bot commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome + setup buttons |
| `/help` | Full help + cookie guide |
| `/addaccount` | Guided account import (paste cookies, set name) |
| `/removeaccount [id]` | Remove an account |
| `/accounts` | List accounts + status |
| `/collect [id]` | Collect now (all accounts or one) |
| `/status` | Today's collection summary |
| `/schedule HH:MM [TZ]` | Set base time (second run = base + 12h) |
| `/debug` | Inspect the coin page + screenshot (temp files auto-deleted) |

---

## Running 24/7

**Linux VPS (recommended for always-on):**
```bash
sudo cp aliexpress-coin-bot.service /etc/systemd/system/
sudo systemctl enable --now aliexpress-coin-bot
```
Free-tier option: Oracle Cloud *Always Free* VM (2 OCPUs/12GB). Note: datacenter IPs
shorten AliExpress session life vs. a home IP.

**Docker:**
```bash
docker build -t coin-bot .
docker run -d --restart unless-stopped --env-file .env -v coin-data:/app/data --name coin-bot coin-bot
```

**Windows:** `start.bat` for a console run, or `start-bg.vbs` (hidden, auto-restart loop)
launched from Task Scheduler at logon.

**Won't work:** Vercel/Netlify (no persistent Chromium), Cloudflare Workers free tier
(10 min browser/day + needs a full rewrite), Render Free (sleeps after 15 min idle —
scheduled runs get missed).

## Optional: keep debug artifacts

Error screenshots/HTML are **off by default**. To keep them for troubleshooting:

```env
DEBUG_ARTIFACTS=true
```

They accumulate in `data/debug/` (auto-pruned to the 20 newest).

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Session expired` | Refresh cookies → `/addaccount` again (accounts marked expired are skipped automatically) |
| `browserType.launch: Executable doesn't exist` | Run `npx playwright install chromium` |
| Bot not responding | Check `BOT_TOKEN` / `ADMIN_CHAT_ID`; confirm no second instance is polling (two instances = 409 conflicts) |
| Page layout changed | `/debug` shows live buttons/classes — update selectors in `src/collector.js` |

## Project layout

```
src/
├── index.js      — entry point, boot + catch-up
├── bot.js        — Telegram commands + inline keyboards
├── collector.js  — Playwright automation (selectors, claims, verification)
├── scheduler.js  — 12h schedule (setTimeout chain, no cron tick)
├── db.js         — sql.js storage (accounts, collection_logs, settings)
├── crypto.js     — AES-256 cookie encryption
└── utils.js      — formatting helpers
extension/        — Chrome cookie-export helper (load unpacked)
```

`CHAT_CONTEXT.md` is the living A→Z timeline; `AGENTS.md` holds the contributor rules
(every change must append a timeline entry).

## License

MIT — see [LICENSE](LICENSE).
