# Sports Tip Bot V2

Mobile-first, app-style dashboard connected to live odds via [The Odds API](https://the-odds-api.com/).

## How it works

- `bot.js` runs on a schedule (GitHub Actions, every 2 hours). For EPL, MLS, NBA, MLB, and NFL games starting in the next 5 days, it picks the **favorite** side of each game's moneyline (the real chance-to-win outcome — highest implied probability from the actual odds, not the biggest underdog payout) and generates a single-game tip for it. Every 4 hours (~every other run — see "Safer bet markets" below) it also pulls goal-total and double-chance lines for EPL/MLS, each posted as its own single tip too.
- **"Mega-parlay" strategy — very safe favorites only.** All of the above (h2h favorites plus the extra soccer markets) feed one shared pool of candidate legs. Once per run, the bot tries to build **one combo tip** using only legs whose American odds are `-800` or beyond (i.e. very heavy favorites — `ODDS_THRESHOLD_AMERICAN` in `bot.js`), picking the safest ones first, one leg per game so the legs stay statistically independent. It needs at least 10 such legs (capped at 15) to build a combo that run; if fewer than 10 clear `-800`, no mega-parlay is created that run and it just waits for the next one. This replaces the old fixed-size (2/3/6-leg) combo builder.
- It checks completed games against real scores to mark past tips (and each leg of a combo) as `WON` / `LOST` / `PUSH` — a combo loses if any leg loses, and wins once every leg is decided with no loss — and writes everything to `tips.json`. A game is only checked against the scores endpoint once it has actually started, and far-future placeholder tips are dropped (they're recreated automatically once they fall back inside the 5-day window) — both to keep API usage low.
- The workflow commits the updated `tips.json` back to the repo, which GitHub Pages then serves automatically.
- `index.html` is a static, no-dependency single-page app that fetches `tips.json` at load time and renders it — no hardcoded/demo data, and no separate backend.

## Safer bet markets (EPL/MLS only)

In addition to h2h favorites, the bot pulls two extra markets from EU bookmakers, via The Odds API's per-event endpoint (these are "additional" markets that only exist there, not on the bulk odds endpoint):

- **Goal totals** — prefers `Over 1.5` goals over `Over 0.5` when both are available (it only drops to the easier `0.5` line when `1.5` isn't offered).
- **Double chance** — picks whichever of the three outcomes (home-or-draw, away-or-draw, home-or-away) is priced safest for that game.

These are real bookmaker lines, not invented stats, and — like h2h favorites — only count toward the mega-parlay combo pool once they clear the `-800` threshold above; they're still posted as their own single tips regardless of odds. They're fetched every 4 hours instead of every run — combining regions and markets in one API call multiplies the quota cost (`markets × regions` per The Odds API's billing), so this keeps the added cost small while still refreshing a few times a day. **BTTS (both teams to score) is intentionally not used** — only the goal-totals and double-chance markets above feed the safe-legs pool.

**Total corners are fetched for visibility only and never become a tip or a combo leg.** The Odds API can quote corners odds, but its `/scores` endpoint only returns final goals, not corner counts, so a corners pick could never be automatically verified as WON or LOST. Since every result and win-rate number in this app comes from real, automatically-verified outcomes, adding a market that can't be verified the same way would break that guarantee. The bot still logs how many corners lines it saw and how many would have cleared `-800`, purely for visibility in the Action logs — corners stay out of `tips.json` entirely unless The Odds API starts returning corner counts, or a separate manually-resolved flow is built for markets like this.

**Important:** picking favorites (or combining several of them) makes each individual leg more likely to hit, but combining legs still multiplies their probabilities down — even a mega-parlay built entirely from `-800`-or-better favorites is not a sure thing once you multiply 10-15 of them together. The app always shows the real, math-derived implied probability for every pick and every combo so that number is never hidden behind a big payout.

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
