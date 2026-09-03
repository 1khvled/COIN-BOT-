# AGENTS.md — rules for any agent working in this project

## Rule 0 (MANDATORY): keep `CHAT_CONTEXT.md` current
- `CHAT_CONTEXT.md` is the project's living memory. **Every session that inspects,
  changes, restarts, or debugs anything MUST append one entry** to its `## Timeline`
  section before finishing.
- Format: `### YYYY-MM-DD — <short title>` + 2–6 bullets (what changed, why, how verified).
- Newest entries go at the BOTTOM. Never rewrite or delete old entries; fix mistakes by
  appending a correction entry.
- If you changed runtime identity (process name, task name, paths, schedule, ports),
  also update the table in `## 2` and the cheat-sheet in `## 7` of `CHAT_CONTEXT.md`.

## Runtime safety
- Bot runs as `rtnode.exe` via scheduled task `RuntimeHelper` + `start-bg.vbs` loop.
  Killing the process respawns it in ~5s — this is by design, not a bug.
- Kill filter: `CommandLine -like '*src\index.js*'`. Never filter by folder name
  (CommandLine contains no full project path).
- To stop deliberately: create `logs\.stop`, then stop the task and kill processes.
- `node --check` every edited file BEFORE restarting. Restart via task stop/kill/start
  (see `CHAT_CONTEXT.md` §7), then verify: process alive + Telegram HTTPS established +
  clean boot lines in `logs\bot.log` (read as UTF-8 bytes, file is locked while running).

## Data safety
- NEVER delete `data/bot.db` or `.env`. Debug artifacts live only in `data/debug/`.
- NEVER print or paste `BOT_TOKEN` / `ENCRYPT_SECRET` values into chat, logs, or files.
- `saveDebug()` is off unless `DEBUG_ARTIFACTS=true`; keep it that way.

## Evidence before claims
- Read the file yourself before describing it. Verify restarts via process list + log,
  not assumptions. If a finding contradicts an earlier note, say so and append a correction.
