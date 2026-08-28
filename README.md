# Sports Tip Bot V2

Mobile-first dashboard connected to live odds via [The Odds API](https://the-odds-api.com/).

## How it works

- `bot.js` runs on a schedule (GitHub Actions, every 30 minutes). It fetches live odds for EPL, MLS, NBA, MLB, and NFL, generates a tip for each new game, checks completed games against real scores to mark past tips as `WON` / `LOST` / `PUSH`, and writes everything to `tips.json`.
- The workflow commits the updated `tips.json` back to the repo, which GitHub Pages then serves automatically.
- `index.html` is a static dashboard that fetches `tips.json` at load time and renders it — no hardcoded/demo data.

## Setup

The bot needs an `ODDS_API_KEY` from The Odds API, stored as a GitHub Actions repository secret (Settings → Secrets and variables → Actions → Repository secrets). It is never placed in the frontend or in `tips.json`.

## Status

- ✅ Live odds + live results tracking
- ✅ Auto-refreshing dashboard, filters (`Tout`, `+300+`, `+500+`, `+1000+`)
- ⏳ No login or payments yet — the `tier` field on each tip is reserved for a future premium/paid tier, but access is not restricted today.
