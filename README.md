# Sports Tip Bot V2

Mobile-first, app-style dashboard connected to live odds via [The Odds API](https://the-odds-api.com/).

## How it works

- `bot.js` runs on a schedule (GitHub Actions, every 2 hours). For EPL, MLS, NBA, MLB, and NFL games starting in the next 5 days, it picks the **favorite** side of each game's moneyline (the real chance-to-win outcome — highest implied probability from the actual odds, not the biggest underdog payout) and generates a single-game tip for it. Every few hours (see "Safer bet markets" below) it also pulls flexible goal-total and both-teams-to-score lines for EPL/MLS. All of these feed a pool of "safe legs" used to build multi-game combo tips (2, 3, and 6 legs, mixing sports and market types) — each combo only uses one leg per game, so the legs stay statistically independent. It checks completed games against real scores to mark past tips (and each leg of a combo) as `WON` / `LOST` / `PUSH` — a combo loses if any leg loses, and wins once every leg is decided with no loss — and writes everything to `tips.json`. A game is only checked against the scores endpoint once it has actually started, and far-future placeholder tips are dropped (they're recreated automatically once they fall back inside the 5-day window) — both to keep API usage low.
- The workflow commits the updated `tips.json` back to the repo, which GitHub Pages then serves automatically.
- `index.html` is a static, no-dependency single-page app that fetches `tips.json` at load time and renders it — no hardcoded/demo data, and no separate backend.

## Safer bet markets (EPL/MLS only)

In addition to h2h favorites, the bot pulls two extra markets from EU bookmakers: goal totals (picks the lowest available line at or above `Over 0.5`/`Over 1.5`, i.e. the easiest total to clear) and BTTS (both teams to score — "Yes"). These are real bookmaker lines, not invented stats. They're fetched roughly every 8 hours instead of every run — combining regions and markets in one API call multiplies the quota cost (`markets × regions` per The Odds API's billing), so this keeps the added cost small while still refreshing a few times a day. **Corners are intentionally not offered as a market.** The Odds API can quote corners odds, but its `/scores` endpoint only returns final goals, not corner counts, so a corners pick could never be automatically verified as WON or LOST. Since every result and win-rate number in this app comes from real, automatically-verified outcomes, adding a market that can't be verified the same way would break that guarantee — so corners stay out unless The Odds API starts returning corner counts, or a separate manually-resolved flow is built for markets like this.

**Important:** picking favorites (or combining several of them) makes each individual leg more likely to hit, but combining legs still multiplies their probabilities down — a 6-leg combo of ~70%-likely favorites is genuinely around an 11-12% chance to sweep all 6, even though every leg looked "safe" on its own. No combination of bets is ever a sure thing. The app always shows the real, math-derived implied probability for every pick and every combo so that number is never hidden behind a big payout.

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
