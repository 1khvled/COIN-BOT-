# Security Policy

## What's sensitive here

- `.env` (`BOT_TOKEN`, `ENCRYPT_SECRET`) and `data/bot.db` (AES-256 encrypted
  AliExpress cookies) must **never** be committed, pasted into issues, or shared.
  Both are gitignored — do not weaken that.
- AliExpress session cookies **are** a login. Anyone holding them controls the account.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
**private vulnerability reporting** (Security tab → Report a vulnerability) or
contact the repo owner directly. Include steps to reproduce and impact; we'll
respond as soon as we can.

## Supported

Latest `main` only. Old revisions may contain outdated selectors or weaker handling —
upgrade with `git pull` and re-run `setup.bat` / `./setup.sh`.
