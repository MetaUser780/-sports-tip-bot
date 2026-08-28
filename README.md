# Sports Tip Bot V2

Mobile-first, app-style dashboard connected to live odds via [The Odds API](https://the-odds-api.com/).

## How it works

- `bot.js` runs on a schedule (GitHub Actions, every 2 hours). It fetches live odds for EPL, MLS, NBA, MLB, and NFL games starting in the next 5 days, generates a single-game tip for each new game, and also builds a couple of multi-game "combo" tips (2-leg and 3-leg, mixing sports) from the soonest upcoming games. It checks completed games against real scores to mark past tips (and each leg of a combo) as `WON` / `LOST` / `PUSH` — a combo loses if any leg loses, and wins once every leg is decided with no loss — and writes everything to `tips.json`. A game is only checked against the scores endpoint once it has actually started, and far-future placeholder tips are dropped (they're recreated automatically once they fall back inside the 5-day window) — both to keep API usage low.
- The workflow commits the updated `tips.json` back to the repo, which GitHub Pages then serves automatically.
- `index.html` is a static, no-dependency single-page app that fetches `tips.json` at load time and renders it — no hardcoded/demo data, and no separate backend.

## The app

`index.html` is now a multi-screen, app-style dashboard (bottom navigation, no page reloads), all built from the same `tips.json`:

- **Home** — quick stats + the soonest upcoming picks, with a sport quick-filter row.
- **Pikaj (Picks)** — every tip, with day-of-week tabs and an odds filter, plus a dedicated **Filtè (Filters)** screen (odds range, sport, single vs. combo, status).
- **Pick detail** — full breakdown of a tip (every leg for a combo), each leg's real implied probability, and Risk/To Win in flat 1-unit staking.
- **Rezilta (Results)** — Won/Lost/Win-rate/Total-tips stat tiles, a units-based track record, and full match history.
- **Alèt (Alerts)** — a "recent activity" feed of newly-added picks (computed client-side from each tip's timestamp — there is no real-time push/backend on GitHub Pages).
- **Profil (Profile)** — app info and a manual refresh button. No login or Premium yet (see Status below).

Two numbers you'll see throughout the app are computed honestly from the real odds already in `tips.json`, not invented:

- **Implied probability** — the standard odds→probability conversion (e.g. `+150` → 40%). This replaces any fabricated "AI confidence %".
- **Units (Risk / To Win)** — flat 1-unit staking math derived from the odds, used for the per-pick Risk/To Win display and the Results screen's units track record.

## Setup

The bot needs an `ODDS_API_KEY` from The Odds API, stored as a GitHub Actions repository secret (Settings → Secrets and variables → Actions → Repository secrets). It is never placed in the frontend or in `tips.json`.

## Status

- ✅ Live odds + live results tracking, focused on the next 5 days
- ✅ Multi-screen app UI (Home / Picks / Results / Alerts / Profile) with real implied-probability and units math
- ⏳ No login or payments yet — the `tier` field on each tip is reserved for a future premium/paid tier, but access is not restricted today.
