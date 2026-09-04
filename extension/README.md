# AE Cookie Extractor (bundled Chrome extension)

One-click cookie export for the coin bot. No manual DevTools copying.

## Install (4 clicks, once)

1. Chrome → `chrome://extensions` → turn ON **Developer mode** (top-right).
2. Click **Load unpacked** → select this `extension` folder.
3. Pin **AE Cookie Extractor** via the puzzle-piece menu.

## Use

1. Log in at [aliexpress.com](https://aliexpress.com).
2. Click the extension icon → **Copy All Cookies**.
3. `✅ Copied N cookies` = done. Paste into the bot's `/addaccount`.

If it says "No cookies found", you're logged out — log in and retry.

## How it works

`popup.js` reads all `.aliexpress.com` cookies via `chrome.cookies`, joins them as
`name=value; …`, and writes the string to the clipboard. Nothing leaves your PC —
paste it only into YOUR bot. (Manifest V3, permissions: `cookies`,
`clipboardWrite`, `notifications`; host: `*.aliexpress.com`.)
