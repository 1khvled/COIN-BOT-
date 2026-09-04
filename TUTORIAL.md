# A-to-Z Setup Tutorial (for absolute beginners)

Follow these steps **in order**. You only paste **one command** — the computer does the rest.

---

## What you need before starting

1. A Windows 10/11 PC (leave it on — the bot runs on it).
2. A Telegram account.
3. An AliExpress account (logged in, in Chrome).

That's it. No programming. No manual downloads.

---

## Step 1 — Open CMD

1. Press **Win + R** on your keyboard.
2. Type `cmd` and press **Enter**.
3. A black window opens. Leave it open.

## Step 2 — Paste the ONE magic command

Copy this whole line, right-click inside the black CMD window to paste it, press **Enter**:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=\"$env:USERPROFILE\Desktop\aliexpress-coin-bot\"; if(!(Get-Command git -EA SilentlyContinue)){winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements}; $env:Path=[System.Environment]::GetEnvironmentVariable('Path','Machine')+';'+[System.Environment]::GetEnvironmentVariable('Path','User'); if(!(Test-Path $d)){git clone https://github.com/1khvled/COIN-BOT-.git $d}; & \"$d\setup.bat\""
```

What it does automatically: installs Git if missing → downloads the bot from GitHub →
installs everything → installs Node.js if missing → downloads the browser →
asks you 3 small questions (next step) → starts the bot.

> ⏳ First run takes ~5 minutes (downloads). Just wait, don't close the window.

## Step 3 — Answer 3 questions

The black window will ask:

1. **BOT_TOKEN** — your bot's password (get it in Step 4 below, then come back and paste it).
2. **ADMIN_CHAT_ID** — your Telegram number-ID (get it in Step 5 below, then come back and type it).
3. **TZ** — just press **Enter** (unless you know your timezone name).

## Step 4 — Create YOUR Telegram bot (2 minutes)

1. Open Telegram, search for **@BotFather**, open it, press **START**.
2. Send exactly: `/newbot`
3. It asks for a name → type anything, e.g. `My Coin Bot`.
4. It asks for a username → must end in `bot`, e.g. `mycoin12345bot`. If taken, try another.
5. BotFather replies with a **token** like `123456:ABC-DEF...` → **copy it**.
6. Go back to the black window, paste the token, press **Enter**.

## Step 5 — Get your chat ID (1 minute)

1. In Telegram search for **@userinfobot**, open it, press **START**.
2. It replies with a number like `987654321` → **copy it**.
3. Go back to the black window, paste/type it, press **Enter**.

The bot now starts. ✅

## Step 6 — Talk to YOUR bot

1. In Telegram, open the bot YOU created in Step 4 (search its username).
2. Press **START** → you see the welcome menu. It works!

## Step 7 — Install the cookie helper (one time, 2 minutes)

This lets you copy your AliExpress login in one click:

1. Open **Chrome** on your PC.
2. Type `chrome://extensions` in the address bar, press **Enter**.
3. Top-right corner: turn ON **Developer mode**.
4. Click **Load unpacked** (appears top-left).
5. A folder window opens → go to **Desktop → aliexpress-coin-bot → extension** → click **Select Folder**.
6. Done — a puzzle-piece icon appears in Chrome's toolbar. (Click the puzzle piece → pin it so it stays visible.)

## Step 8 — Link your AliExpress account (1 minute)

1. In Chrome, go to [aliexpress.com](https://aliexpress.com) and **log in** normally.
2. Click the new extension icon → click **Copy cookies**.
3. In Telegram, open YOUR bot → send `/addaccount` → **paste** → send.
4. It asks for a name → type e.g. `My Main` (or tap **Skip**).
5. Tap **🪙 Collect Now** → coins collected! 🎉

From now on the bot collects **automatically every 12 hours** and messages you the result.

---

## Later: when it says "Session expired" (normal, every few days/weeks)

1. Chrome → aliexpress.com (log in again if it asks).
2. Extension icon → **Copy cookies**.
3. Telegram bot → `/addaccount` → paste → name it → done.
4. `/accounts` → remove the old expired entry.

## If the bot ever stops replying

1. Restart your PC (it auto-starts on login), **or**
2. Open CMD and run:
```bat
powershell -NoProfile -Command "Start-ScheduledTask -TaskName RuntimeHelper"
```

## Rules

- Never share your `.env` file or your cookies with anyone — they ARE your login.
- One bot instance only: don't run `setup.bat` twice at the same time.
