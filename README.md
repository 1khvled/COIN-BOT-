# 🤖 AliExpress Daily Coin Collector & Deals Ecosystem

[![Channel](https://img.shields.io/badge/Telegram-Channel%20%40DzAliexpress0-blue?logo=telegram)](https://t.me/DzAliexpress0)
[![Coin Deals Bot](https://img.shields.io/badge/Telegram-Bot%20%40Alilo07BOT-green?logo=telegram)](https://t.me/Alilo07BOT)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Playwright](https://img.shields.io/badge/browser-Chromium_Playwright-blue)

Automatically collect 70 to 100+ AliExpress coins daily from your own PC/home connection without getting IP-banned!

> 📢 **Official Deals Partner:** Powered by [@DzAliexpress0](https://t.me/DzAliexpress0) — Curating the highest coin-discount deals (up to 70% OFF) & verified hardware/tech bargains.

---

## ⚡ Super Easy Setup (Install in 2 Minutes)

Anyone can install this on Windows, Mac, or Linux. No coding required!

### 🪟 Windows (1-Click Paste & Run)
1. Press `Windows Key + R`, type `cmd`, and press **Enter**.
2. Copy and paste this single line, then press **Enter**:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=\"$env:USERPROFILE\Desktop\aliexpress-coin-bot\"; if(!(Get-Command git -EA SilentlyContinue)){winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements}; $env:Path=[System.Environment]::GetEnvironmentVariable('Path','Machine')+';'+[System.Environment]::GetEnvironmentVariable('Path','User'); if(!(Test-Path $d)){git clone https://github.com/1khvled/COIN-BOT-.git $d}; & \"$d\setup.bat\""
```

The script automatically installs everything, prompts for your Telegram bot token, and launches!

---

### 🐧 Linux / macOS
```bash
git clone https://github.com/1khvled/COIN-BOT-.git aliexpress-coin-bot
cd aliexpress-coin-bot
chmod +x setup.sh && ./setup.sh
```

---

## 🍪 How to Connect Your AliExpress Account (1 Minute)

1. Open Chrome and go to `chrome://extensions`.
2. Toggle **Developer mode** ON (top-right corner).
3. Click **Load unpacked** and select the `extension` folder inside this bot folder.
4. Go to [aliexpress.com](https://aliexpress.com) (make sure you are logged in).
5. Click the puzzle icon / **AE Cookie Extractor** extension icon and click **Copy All Cookies**.
6. Open your Telegram bot, send `/addaccount`, and paste! That's it!

Your bot will now collect coins automatically every 24 hours in the background.

---

## 📢 Telegram Deals & Community Hub

Unlock the full power of your coins with our partner ecosystem:

| Channel / Bot | Purpose | Link |
|---|---|---|
| **@DzAliexpress0** | Handpicked deals with up to 70% Coin discounts & Canadian/Korean region prices | [Join Channel](https://t.me/DzAliexpress0) |
| **@Alilo07BOT** | Send any AliExpress product URL to instantly convert it to max coin discount link | [Open Bot](https://t.me/Alilo07BOT) |

---

## 🛡️ Built-in Channel Membership Guard

To ensure a thriving community, this bot verifies that users are subscribed to **[@DzAliexpress0](https://t.me/DzAliexpress0)** before enabling daily automated collection sweeps.

---

## 📋 Bot Commands

| Command | Action |
|---|---|
| `/start` | Open menu & verify channel membership |
| `/addaccount` | Link AliExpress account via cookies |
| `/collect` | Collect daily coins right now |
| `/status` | View coins balance & today's collection log |
| `/accounts` | Manage connected AliExpress accounts |
| `/help` | Complete setup & cookie guide |

---

## License
MIT — Open source for all AliExpress deal hunters.
