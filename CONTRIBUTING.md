# Contributing

Thanks for stopping by! A few ground rules keep this bot reliable for everyone.

## How to contribute

1. Fork the repo, create a branch (`feat/...` or `fix/...`).
2. Make your change. If AliExpress changed its page layout, `/debug` output
   (buttons + `aecoin*` classes) is the evidence to include in your PR.
3. Sanity checks before pushing:
   - `node --check src/<file>.js` for every JS file you touched.
   - `setup.bat --no-start` (Windows) still exits 0.
   - Never commit `.env`, `data/`, `logs/`, or any cookies/tokens (already gitignored — keep it that way).
4. **Append a dated entry** to `CHAT_CONTEXT.md` → `## Timeline` (see `AGENTS.md` Rule 0).
   Newest entries go at the bottom, append-only.
5. Open a PR describing what changed, why, and how you verified it.

## What makes a good PR here

- Selector fixes backed by real `/debug` output (not guesses).
- No new persistent browser state — contexts stay ephemeral, debug artifacts stay
  opt-in (`DEBUG_ARTIFACTS=true`).
- Keep idle footprint low: no polling loops tighter than seconds, no always-on Chromium.

## What we won't merge

- Anything that sends cookies/tokens anywhere except the user's own configured bot.
- Auto-buying, account creation, or anything that violates AliExpress ToS beyond
  clicking the user's own daily coin buttons.
