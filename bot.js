const fs = require("fs");

const API_KEY = process.env.ODDS_API_KEY;

if (!API_KEY) {
  throw new Error("ODDS_API_KEY is missing");
}

const TIPS_FILE = "tips.json";
const WINDOW_DAYS = 5; // only track games starting within this many days
const COMBO_SIZES = [2, 3, 6]; // generate one combo tip per size, per run

const SPORTS = [
  { key: "soccer_epl", label: "EPL" },
  { key: "soccer_usa_mls", label: "MLS" },
  { key: "basketball_nba", label: "NBA" },
  { key: "baseball_mlb", label: "MLB" },
  { key: "americanfootball_nfl", label: "NFL" }
];

// Extra soccer-only markets (totals/BTTS) used to build safer combo legs.
// Kept on a much slower schedule than the main h2h fetch (see
// EXTRA_MARKETS_INTERVAL_HOURS) because each region+market combo is billed
// separately by The Odds API, and these markets mostly live with EU
// bookmakers rather than the "us" region already used for h2h.
const EXTRA_MARKETS_SPORTS = SPORTS.filter(s => s.key.startsWith("soccer_"));
const EXTRA_MARKETS_REGIONS = "eu";
const EXTRA_MARKETS_KEYS = "alternate_totals,btts";
const EXTRA_MARKETS_INTERVAL_HOURS = 8;

function emptyStats() {
  return { won: 0, lost: 0, push: 0, pending: 0, winRate: 0, totalTips: 0 };
}

function loadTips() {
  try {
    const raw = fs.readFileSync(TIPS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.tips)) data.tips = [];
    return data;
  } catch (error) {
    return { updatedAt: null, extraMarketsLastRun: null, stats: emptyStats(), tips: [] };
  }
}

function writeTips(data) {
  fs.writeFileSync(TIPS_FILE, JSON.stringify(data, null, 2) + "\n");
}

function isoNoMillis(date) {
  return date.toISOString().split(".")[0] + "Z";
}

async function getOdds(sportKey, fromIso, toIso) {
  const url =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds` +
    `?regions=us&markets=h2h&oddsFormat=american` +
    `&commenceTimeFrom=${fromIso}&commenceTimeTo=${toIso}` +
    `&apiKey=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${sportKey}: odds API error ${response.status}`);
  }

  return response.json();
}

// Fetches soccer-only "safer bet" markets (flexible goal totals + both
// teams to score) from EU bookmakers. Gated separately from getOdds() so
// it only runs a few times a day instead of every run.
async function getExtraSoccerOdds(sportKey, fromIso, toIso) {
  const url =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds` +
    `?regions=${EXTRA_MARKETS_REGIONS}&markets=${EXTRA_MARKETS_KEYS}&oddsFormat=american` +
    `&commenceTimeFrom=${fromIso}&commenceTimeTo=${toIso}` +
    `&apiKey=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${sportKey}: extra-markets odds API error ${response.status}`);
  }

  return response.json();
}

async function getScores(sportKey) {
  const url =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/scores` +
    `?daysFrom=3&apiKey=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${sportKey}: scores API error ${response.status}`);
  }

  return response.json();
}

function makeTipId(sportKey, eventId, market) {
  return `${sportKey}:${eventId}:${market}`;
}

// Real, math-derived implied probability from American odds - used to rank
// how "safe" a pick is. Never a fabricated/AI confidence score.
function impliedProbability(odds) {
  const o = Number(odds);
  if (!isFinite(o) || o === 0) return 0;
  return o > 0 ? 100 / (o + 100) : (-o) / ((-o) + 100);
}

// Pulls the h2h outcome most likely to win (the favorite - lowest price,
// i.e. highest implied probability) out of a game's odds, shared by
// single-game tips and by combo legs. Historically this picked the
// highest-price (biggest underdog / lowest chance) outcome; product
// decision is now to prioritize the team's real chance of winning over
// the size of the payout.
function extractLegCandidate(sportKey, label, game) {
  const bookmaker = game.bookmakers?.[0];
  if (!bookmaker) return null;

  const market = (bookmaker.markets || []).find(m => m.key === "h2h");
  if (!market) return null;

  const outcomes = market.outcomes || [];
  if (outcomes.length < 2) return null;

  const favorite = outcomes.reduce((a, b) =>
    Number(a.price) < Number(b.price) ? a : b
  );

  return {
    sportKey,
    sport: label,
    eventId: game.id,
    game: `${game.away_team} @ ${game.home_team}`,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    commenceTime: game.commence_time,
    market: "h2h",
    pick: favorite.name,
    odds: Number(favorite.price),
    bookmaker: bookmaker.title
  };
}

function buildNewTips(sportKey, label, games, existingIds) {
  const tips = [];

  for (const game of games) {
    const leg = extractLegCandidate(sportKey, label, game);
    if (!leg) continue;

    const id = makeTipId(leg.sportKey, leg.eventId, leg.market);
    if (existingIds.has(id)) continue;

    tips.push({
      id,
      type: "single",
      sport: leg.sport,
      sportKey: leg.sportKey,
      eventId: leg.eventId,
      game: leg.game,
      homeTeam: leg.homeTeam,
      awayTeam: leg.awayTeam,
      commenceTime: leg.commenceTime,
      market: leg.market,
      pick: leg.pick,
      odds: leg.odds,
      bookmaker: leg.bookmaker,
      status: "PENDING",
      tier: "free",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    });
  }

  return tips;
}

// Scans every bookmaker on a game (not just the first) for one that offers
// a given market key - needed because a single /odds call for multiple
// markets can return bookmakers that only cover some of them.
function findMarketAcrossBookmakers(game, marketKey) {
  for (const bookmaker of game.bookmakers || []) {
    const market = (bookmaker.markets || []).find(m => m.key === marketKey);
    if (market) return { bookmaker, market };
  }
  return null;
}

// Picks the "Over" outcome closest to the requested target line(s), in
// preference order, falling back to whichever line is lowest (i.e. easiest
// to clear / safest) if none of the targets are offered.
function pickOverOutcome(market, targetPoints) {
  const overs = (market.outcomes || []).filter(o => o.name === "Over");
  if (overs.length === 0) return null;

  for (const target of targetPoints) {
    const exact = overs.find(o => Number(o.point) === target);
    if (exact) return exact;
  }

  return overs.reduce((a, b) => (Number(a.point) < Number(b.point) ? a : b));
}

// Builds extra "safer bet" leg candidates (goal totals + BTTS) for a single
// soccer game. These feed both their own single tips and the combo pool.
function extractExtraMarketCandidates(sportKey, label, game) {
  const candidates = [];
  const base = {
    sportKey,
    sport: label,
    eventId: game.id,
    game: `${game.away_team} @ ${game.home_team}`,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    commenceTime: game.commence_time
  };

  const totalsHit = findMarketAcrossBookmakers(game, "alternate_totals");
  if (totalsHit) {
    const outcome = pickOverOutcome(totalsHit.market, [0.5, 1.5]);
    if (outcome) {
      candidates.push(Object.assign({}, base, {
        market: "totals",
        pick: `Over ${outcome.point} Gòl`,
        line: Number(outcome.point),
        odds: Number(outcome.price),
        bookmaker: totalsHit.bookmaker.title
      }));
    }
  }

  const bttsHit = findMarketAcrossBookmakers(game, "btts");
  if (bttsHit) {
    const yesOutcome = (bttsHit.market.outcomes || []).find(o => o.name === "Yes");
    if (yesOutcome) {
      candidates.push(Object.assign({}, base, {
        market: "btts",
        pick: "De Ekip Make (BTTS: Wi)",
        odds: Number(yesOutcome.price),
        bookmaker: bttsHit.bookmaker.title
      }));
    }
  }

  return candidates;
}

function buildExtraMarketTips(candidates, existingIds) {
  const tips = [];
  for (const c of candidates) {
    const id = makeTipId(c.sportKey, c.eventId, c.market);
    if (existingIds.has(id)) continue;

    tips.push({
      id,
      type: "single",
      sport: c.sport,
      sportKey: c.sportKey,
      eventId: c.eventId,
      game: c.game,
      homeTeam: c.homeTeam,
      awayTeam: c.awayTeam,
      commenceTime: c.commenceTime,
      market: c.market,
      pick: c.pick,
      line: c.line,
      odds: c.odds,
      bookmaker: c.bookmaker,
      status: "PENDING",
      tier: "free",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    });
  }
  return tips;
}

function shouldRunExtraMarkets(data, now) {
  if (!data.extraMarketsLastRun) return true;
  const hoursSince = (now - new Date(data.extraMarketsLastRun)) / (1000 * 60 * 60);
  return hoursSince >= EXTRA_MARKETS_INTERVAL_HOURS;
}

function americanToDecimal(odds) {
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

function decimalToAmerican(decimal) {
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

function comboId(legs) {
  const ids = legs.map(l => makeTipId(l.sportKey, l.eventId, l.market)).sort();
  return "combo:" + ids.join("|");
}

// Builds multi-game combo ("parlay") tips out of the safest available legs
// across every sport and market - safest meaning highest real implied
// probability from the odds, not the highest payout. Each combo only uses
// one leg per game, so legs stay statistically independent (no same-game
// correlated bets stacked into one ticket).
function buildComboTips(legCandidates, existingIds) {
  const combos = [];
  const bySafestFirst = legCandidates
    .slice()
    .sort((a, b) => impliedProbability(b.odds) - impliedProbability(a.odds));

  for (const size of COMBO_SIZES) {
    const legs = [];
    const usedEvents = new Set();

    for (const candidate of bySafestFirst) {
      if (legs.length >= size) break;
      if (usedEvents.has(candidate.eventId)) continue;
      legs.push(candidate);
      usedEvents.add(candidate.eventId);
    }

    if (legs.length < size) continue; // not enough distinct games yet

    const id = comboId(legs);
    if (existingIds.has(id)) continue;

    const decimal = legs.reduce((acc, l) => acc * americanToDecimal(l.odds), 1);
    const earliest = legs.reduce(
      (min, l) => (new Date(l.commenceTime) < new Date(min) ? l.commenceTime : min),
      legs[0].commenceTime
    );

    combos.push({
      id,
      type: "combo",
      sport: "COMBO",
      legs: legs.map(l => ({
        sportKey: l.sportKey,
        sport: l.sport,
        eventId: l.eventId,
        game: l.game,
        homeTeam: l.homeTeam,
        awayTeam: l.awayTeam,
        commenceTime: l.commenceTime,
        market: l.market,
        pick: l.pick,
        line: l.line,
        odds: l.odds,
        bookmaker: l.bookmaker
      })),
      commenceTime: earliest,
      market: "combo",
      odds: decimalToAmerican(decimal),
      bookmaker: "Multiple",
      status: "PENDING",
      tier: "free",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    });

    existingIds.add(id);
  }

  return combos;
}

function pruneFarFutureTips(tips, now) {
  const cutoff = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // Keep every resolved tip (history for the stats/record). Only drop
  // still-pending placeholders that are further out than the active window -
  // they get recreated automatically once they fall back inside it.
  return tips.filter(tip => tip.status !== "PENDING" || new Date(tip.commenceTime) <= cutoff);
}

function sportNeedsScoreCheck(sportKey, tips, now) {
  return tips.some(tip => {
    if (tip.status !== "PENDING") return false;
    const legs = tip.type === "combo" ? tip.legs : [tip];
    return legs.some(leg => leg.sportKey === sportKey && new Date(leg.commenceTime) <= now);
  });
}

// Resolves a single game (or a single leg of a combo) against completed
// scores. Returns "WON" / "LOST" / "PUSH" / "PENDING" (still not decided).
function resolveLeg(leg, scoresBySport) {
  const scoreEvents = scoresBySport[leg.sportKey] || [];
  const match = scoreEvents.find(e => e.id === leg.eventId);
  if (!match || !match.completed || !Array.isArray(match.scores)) return "PENDING";

  const homeScore = match.scores.find(s => s.name === leg.homeTeam);
  const awayScore = match.scores.find(s => s.name === leg.awayTeam);
  if (!homeScore || !awayScore) return "PENDING";

  const home = Number(homeScore.score);
  const away = Number(awayScore.score);
  if (Number.isNaN(home) || Number.isNaN(away)) return "PENDING";

  if (leg.market === "totals") {
    const line = Number(leg.line);
    const total = home + away;
    if (Number.isNaN(line)) return "PENDING";
    if (total > line) return "WON";
    if (total < line) return "LOST";
    return "PUSH";
  }

  if (leg.market === "btts") {
    return home > 0 && away > 0 ? "WON" : "LOST";
  }

  // h2h
  let winner = null;
  if (home > away) winner = leg.homeTeam;
  else if (away > home) winner = leg.awayTeam;

  if (winner === null) return "PUSH";
  return winner === leg.pick ? "WON" : "LOST";
}

function resolveTips(tips, scoresBySport) {
  for (const tip of tips) {
    if (tip.status !== "PENDING") continue;

    if (tip.type === "combo") {
      const results = tip.legs.map(leg => resolveLeg(leg, scoresBySport));
      if (results.includes("LOST")) {
        tip.status = "LOST";
        tip.resolvedAt = new Date().toISOString();
      } else if (results.every(r => r !== "PENDING")) {
        // All legs decided and none lost: a push leg doesn't cost you, so
        // the combo wins unless every leg pushed (then it's a full push).
        tip.status = results.every(r => r === "PUSH") ? "PUSH" : "WON";
        tip.resolvedAt = new Date().toISOString();
      }
      continue;
    }

    const result = resolveLeg(tip, scoresBySport);
    if (result === "PENDING") continue;
    tip.status = result;
    tip.resolvedAt = new Date().toISOString();
  }
}

function computeStats(tips) {
  const stats = emptyStats();
  for (const tip of tips) {
    stats.totalTips++;
    if (tip.status === "WON") stats.won++;
    else if (tip.status === "LOST") stats.lost++;
    else if (tip.status === "PUSH") stats.push++;
    else stats.pending++;
  }
  const decided = stats.won + stats.lost;
  stats.winRate = decided > 0 ? Math.round((stats.won / decided) * 1000) / 10 : 0;
  return stats;
}

async function main() {
  console.log("SPORTS TIP BOT STARTING...");

  const now = new Date();
  const nowIso = isoNoMillis(now);
  const windowEndIso = isoNoMillis(new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000));

  const data = loadTips();

  // Drop still-pending placeholders for games further out than the active
  // window, so the dashboard (and tips.json) stay focused on upcoming games.
  // History (WON/LOST/PUSH) is never touched by this.
  const beforePrune = data.tips.length;
  data.tips = pruneFarFutureTips(data.tips, now);
  if (beforePrune !== data.tips.length) {
    console.log(`Pruned ${beforePrune - data.tips.length} far-future pending tip(s)`);
  }

  const existingIds = new Set(data.tips.map(t => t.id));

  // 1. Resolve pending tips using completed scores - but only spend a scores
  //    request on a sport if it actually has a pending tip (single or combo
  //    leg) whose game has already started.
  const scoresBySport = {};
  for (const sport of SPORTS) {
    if (!sportNeedsScoreCheck(sport.key, data.tips, now)) {
      console.log(`Skipping scores for ${sport.label} (nothing pending has started)`);
      continue;
    }
    try {
      scoresBySport[sport.key] = await getScores(sport.key);
      console.log(`Fetched scores for ${sport.label}`);
    } catch (error) {
      console.log(`WARNING: ${error.message}`);
      scoresBySport[sport.key] = [];
    }
  }
  resolveTips(data.tips, scoresBySport);

  // 2. Fetch live odds - limited to the next WINDOW_DAYS days - and add tips
  //    only for games we haven't posted yet. The h2h pick is now the
  //    favorite (highest real chance to win), not the biggest payout.
  let newTips = [];
  let allLegCandidates = [];
  for (const sport of SPORTS) {
    try {
      const games = await getOdds(sport.key, nowIso, windowEndIso);
      const generated = buildNewTips(sport.key, sport.label, games, existingIds);
      generated.forEach(t => existingIds.add(t.id));
      newTips = newTips.concat(generated);
      console.log(`${sport.label}: ${games.length} games in window, ${generated.length} new tip(s)`);

      for (const game of games) {
        const leg = extractLegCandidate(sport.key, sport.label, game);
        if (leg) allLegCandidates.push(leg);
      }
    } catch (error) {
      console.log(`WARNING: ${error.message}`);
    }
  }

  // 3. Every few hours, also pull soccer-only "safer bet" markets (goal
  //    totals, BTTS) to widen the pool of safe combo legs beyond h2h
  //    favorites - kept rare because each extra region+market combo costs
  //    separate API quota.
  if (shouldRunExtraMarkets(data, now)) {
    console.log(`Fetching extra soccer markets (totals/BTTS) - last run: ${data.extraMarketsLastRun || "never"}`);
    for (const sport of EXTRA_MARKETS_SPORTS) {
      try {
        const games = await getExtraSoccerOdds(sport.key, nowIso, windowEndIso);
        let found = [];
        for (const game of games) {
          found = found.concat(extractExtraMarketCandidates(sport.key, sport.label, game));
        }
        const generated = buildExtraMarketTips(found, existingIds);
        generated.forEach(t => existingIds.add(t.id));
        newTips = newTips.concat(generated);
        allLegCandidates = allLegCandidates.concat(found);
        console.log(`${sport.label}: ${found.length} extra-market candidate(s), ${generated.length} new tip(s)`);
      } catch (error) {
        console.log(`WARNING: ${error.message}`);
      }
    }
    data.extraMarketsLastRun = nowIso;
  } else {
    console.log(`Skipping extra soccer markets (runs every ${EXTRA_MARKETS_INTERVAL_HOURS}h, last run ${data.extraMarketsLastRun})`);
  }

  // 4. Build combo ("parlay") tips (2, 3, and 6 legs) from the safest legs
  //    across every sport and market pooled above.
  const newCombos = buildComboTips(allLegCandidates, existingIds);
  if (newCombos.length > 0) {
    console.log(`Added ${newCombos.length} combo tip(s)`);
  }
  newTips = newTips.concat(newCombos);

  data.tips = data.tips.concat(newTips);
  data.stats = computeStats(data.tips);
  data.updatedAt = new Date().toISOString();

  writeTips(data);

  console.log(`\n${newTips.length} new tip(s) added. ${data.tips.length} total.`);
  console.log(`Stats: ${data.stats.won}W - ${data.stats.lost}L - ${data.stats.pending} pending (${data.stats.winRate}% win rate)`);
}

main().catch(error => {
  console.error("BOT ERROR:", error.message);
  process.exit(1);
});
