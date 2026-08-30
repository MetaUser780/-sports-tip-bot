const fs = require("fs");

const API_KEY = process.env.ODDS_API_KEY;

if (!API_KEY) {
  throw new Error("ODDS_API_KEY is missing");
}

const TIPS_FILE = "tips.json";
const WINDOW_DAYS = 5; // only track games starting within this many days

// "Mega-parlay" strategy: only use very heavy favorites (American odds at
// or beyond this threshold, e.g. -800, -900, -1200 ...) and combine at
// least MIN_SELECTIONS of them (up to MAX_SELECTIONS) into a single combo
// tip per run. This replaces the old fixed-size (2/3/6-leg) combo builder.
const ODDS_THRESHOLD_AMERICAN = -800;
const MIN_SELECTIONS = 10;
const MAX_SELECTIONS = 15;

const SPORTS = [
  { key: "soccer_epl", label: "EPL" },
  { key: "soccer_usa_mls", label: "MLS" },
  { key: "basketball_nba", label: "NBA" },
  { key: "baseball_mlb", label: "MLB" },
  { key: "americanfootball_nfl", label: "NFL" }
];

// Extra soccer-only markets (goal totals, double chance, total corners)
// used to build safer combo legs. Kept on a much slower schedule than the
// main h2h fetch (see EXTRA_MARKETS_INTERVAL_HOURS) because each
// region+market combo is billed separately by The Odds API, and these
// markets mostly live with EU bookmakers rather than the "us" region
// already used for h2h.
//
// IMPORTANT: "alternate_totals", "double_chance" and "alternate_totals_corners"
// are "additional" markets on The Odds API - they 422 (INVALID_MARKET) on the
// bulk /sports/{sport}/odds endpoint used for h2h. They only exist on the
// per-event endpoint (/sports/{sport}/events/{eventId}/odds), so this
// feature fetches the event list first (free) and then asks for odds one
// event at a time.
//
// "totals_corners" (total corners) is fetched for visibility/logging ONLY -
// The Odds API's /scores endpoint never returns corner counts, only the
// final goal score, so a corners leg could never auto-resolve WON/LOST. Per
// explicit user decision, corners odds are never turned into a tip and
// never added to the combo-leg pool - see extractExtraMarketCandidates().
const EXTRA_MARKETS_SPORTS = SPORTS.filter(s => s.key.startsWith("soccer_"));
const EXTRA_MARKETS_REGIONS = "eu";
const EXTRA_MARKETS_KEYS = "alternate_totals,double_chance,alternate_totals_corners";
const EXTRA_MARKETS_INTERVAL_HOURS = 4; // ~ every other 2h cron run
// Per-event odds cost separate API quota each, so cap how many events per
// sport get checked on a single extra-markets run.
const EXTRA_MARKETS_MAX_EVENTS_PER_SPORT = 10;

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

// Lightweight list of upcoming events (id + teams + start time) for a
// sport in the window. This "events" endpoint does not return odds and is
// not billed against the odds-market quota, so it's safe/cheap to call
// before spending real quota on per-event odds below.
async function getEvents(sportKey, fromIso, toIso) {
  const url =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/events` +
    `?commenceTimeFrom=${fromIso}&commenceTimeTo=${toIso}` +
    `&apiKey=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${sportKey}: events API error ${response.status}`);
  }

  return response.json();
}

// Decides which soccer events are worth spending a per-event odds call on
// when fetching extra markets (double chance especially). A team that is
// only a WEAK h2h favorite (say -120, -150 ... anything worse than
// ODDS_THRESHOLD_AMERICAN) is exactly the case where double chance helps
// most: covering 2 of the 3 possible results on a moderate favorite often
// prices out around -700/-800+, turning a leg that couldn't join the
// mega-parlay on its own into one that can. A game whose h2h favorite
// already clears ODDS_THRESHOLD_AMERICAN doesn't need that boost (it
// already qualifies), and a game with no known h2h price yet is checked
// last since we can't tell if double chance would even help. This just
// reorders the (free) events list before slicing to
// EXTRA_MARKETS_MAX_EVENTS_PER_SPORT, so the same number of per-event API
// calls get spent on the games most likely to turn into new safe legs.
function prioritizeExtraMarketsEvents(events, sportKey, h2hLegCandidates) {
  const oddsByEvent = new Map();
  for (const leg of h2hLegCandidates) {
    if (leg.sportKey === sportKey && leg.market === "h2h") {
      oddsByEvent.set(leg.eventId, Number(leg.odds));
    }
  }

  function priority(eventId) {
    const odds = oddsByEvent.get(eventId);
    if (!Number.isFinite(odds)) return { tier: 2, odds: 0 };
    if (odds <= ODDS_THRESHOLD_AMERICAN) return { tier: 1, odds };
    return { tier: 0, odds };
  }

  return events
    .slice()
    .sort((a, b) => {
      const pa = priority(a.id);
      const pb = priority(b.id);
      if (pa.tier !== pb.tier) return pa.tier - pb.tier;
      return pa.odds - pb.odds;
    });
}

// Fetches soccer-only "safer bet" markets (flexible goal totals, double
// chance, total corners) for ONE event from EU bookmakers. These are
// additional markets that The Odds API only serves through this per-event
// endpoint (they 422 on the bulk odds endpoint). Gated separately from
// getOdds() so it only runs a few times a day instead of every run.
async function getExtraSoccerOddsForEvent(sportKey, eventId) {
  const url =
    `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds` +
    `?regions=${EXTRA_MARKETS_REGIONS}&markets=${EXTRA_MARKETS_KEYS}&oddsFormat=american` +
    `&apiKey=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${sportKey} event ${eventId}: extra-markets odds API error ${response.status} - ${body.slice(0, 300)}`);
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
// single-game tips and by combo legs.
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

// Classifies a "double_chance" outcome name against the two team names in
// the game, so the actual result can be checked later purely from the
// final score (home/away/draw) instead of re-parsing the API's exact
// outcome-name wording every time.
function classifyDoubleChanceOutcome(outcomeName, homeTeam, awayTeam) {
  const name = String(outcomeName || "");
  const hasHome = name.includes(homeTeam);
  const hasAway = name.includes(awayTeam);
  const hasDraw = /draw/i.test(name);
  if (hasHome && hasAway) return "home_or_away";
  if (hasHome && hasDraw) return "home_or_draw";
  if (hasAway && hasDraw) return "away_or_draw";
  return null;
}

// Builds extra "safer bet" leg candidates (goal totals, double chance) for a
// single soccer game, plus a separate info-only list of total-corners odds
// (see the EXTRA_MARKETS_KEYS comment above for why corners never become a
// tip/combo leg). These candidates feed both their own single tips and the
// combo pool.
function extractExtraMarketCandidates(sportKey, label, game) {
  const candidates = [];
  const cornersInfo = [];
  const base = {
    sportKey,
    sport: label,
    eventId: game.id,
    game: `${game.away_team} @ ${game.home_team}`,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    commenceTime: game.commence_time
  };

  // Goal totals - prefer the "Over 1.5 goals" line (per user request) over
  // "Over 0.5", falling back to whatever line is offered/safest otherwise.
  const totalsHit = findMarketAcrossBookmakers(game, "alternate_totals");
  if (totalsHit) {
    const outcome = pickOverOutcome(totalsHit.market, [1.5, 0.5]);
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

  // Double chance - pick whichever of the 3 combos (home-or-draw,
  // away-or-draw, home-or-away) is priced safest for this game.
  const dcHit = findMarketAcrossBookmakers(game, "double_chance");
  if (dcHit) {
    const classified = (dcHit.market.outcomes || [])
      .map(o => ({ outcome: o, code: classifyDoubleChanceOutcome(o.name, game.home_team, game.away_team) }))
      .filter(x => x.code && Number.isFinite(Number(x.outcome.price)));
    if (classified.length > 0) {
      const safest = classified.reduce((a, b) =>
        Number(a.outcome.price) < Number(b.outcome.price) ? a : b
      );
      candidates.push(Object.assign({}, base, {
        market: "double_chance",
        pick: `Doub Chans: ${safest.outcome.name}`,
        line: safest.code,
        odds: Number(safest.outcome.price),
        bookmaker: dcHit.bookmaker.title
      }));
    }
  }

  // Total corners - info/logging only, NEVER a tip or combo leg. The Odds
  // API's /scores endpoint has no corner-count data, so a corners leg could
  // never auto-resolve WON/LOST (and would leave any combo containing it
  // stuck on PENDING forever). Kept here so the odds are still visible in
  // the run log for manual review.
  const cornersHit = findMarketAcrossBookmakers(game, "alternate_totals_corners");
  if (cornersHit) {
    const outcome = pickOverOutcome(cornersHit.market, []);
    if (outcome) {
      cornersInfo.push(Object.assign({}, base, {
        market: "totals_corners",
        pick: `Over ${outcome.point} Kòn (enfo sèlman - pa gen nan konbo)`,
        line: Number(outcome.point),
        odds: Number(outcome.price),
        bookmaker: cornersHit.bookmaker.title
      }));
    }
  }

  return { candidates, cornersInfo };
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

// Builds ONE "mega-parlay" combo tip per run out of only the safest legs
// available across every sport and market: legs must clear
// ODDS_THRESHOLD_AMERICAN (e.g. -800 or more negative) to even be
// considered, and we need at least MIN_SELECTIONS of them (capped at
// MAX_SELECTIONS) or we skip building a combo this run entirely. Each
// combo only uses one leg per game, so legs stay statistically
// independent (no same-game correlated bets stacked into one ticket).
// Diagnostic only: shows how many favorite legs are currently available at
// each odds cutoff, so ODDS_THRESHOLD_AMERICAN can be tuned to match what
// the market actually offers instead of guessing blind.
function logThresholdDistribution(legCandidates) {
  const thresholds = [-150, -200, -300, -400, -500, -600, -700, -800];
  const parts = thresholds.map(t => {
    const count = legCandidates.filter(
      c => Number.isFinite(Number(c.odds)) && Number(c.odds) <= t
    ).length;
    return `${t}:${count}`;
  });
  console.log(`Distribisyon favori disponib (odds <= X: konbyen) - ${parts.join(", ")} (sou ${legCandidates.length} total)`);
}

function buildComboTips(legCandidates, existingIds) {
  const safeCandidates = legCandidates.filter(
    c => Number.isFinite(Number(c.odds)) && Number(c.odds) <= ODDS_THRESHOLD_AMERICAN
  );

  const bySafestFirst = safeCandidates
    .slice()
    .sort((a, b) => impliedProbability(b.odds) - impliedProbability(a.odds));

  const legs = [];
  const usedEvents = new Set();

  for (const candidate of bySafestFirst) {
    if (legs.length >= MAX_SELECTIONS) break;
    if (usedEvents.has(candidate.eventId)) continue;
    legs.push(candidate);
    usedEvents.add(candidate.eventId);
  }

  if (legs.length < MIN_SELECTIONS) {
    console.log(
      `Pa ase seleksyon ki pi sekirize pase ${ODDS_THRESHOLD_AMERICAN} (${legs.length}/${MIN_SELECTIONS}) - pa gen mega-parlay fwa sa a.`
    );
    return [];
  }

  const id = comboId(legs);
  if (existingIds.has(id)) return [];

  const decimal = legs.reduce((acc, l) => acc * americanToDecimal(l.odds), 1);
  const earliest = legs.reduce(
    (min, l) => (new Date(l.commenceTime) < new Date(min) ? l.commenceTime : min),
    legs[0].commenceTime
  );

  const combo = {
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
  };

  existingIds.add(id);
  console.log(`Bati yon mega-parlay ${legs.length} pati (odds konbine ${decimalToAmerican(decimal)}).`);
  return [combo];
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

  if (leg.market === "double_chance") {
    let winner = "draw";
    if (home > away) winner = "home";
    else if (away > home) winner = "away";

    const covers = {
      home_or_draw: ["home", "draw"],
      away_or_draw: ["away", "draw"],
      home_or_away: ["home", "away"]
    }[leg.line];

    if (!covers) return "PENDING";
    return covers.includes(winner) ? "WON" : "LOST";
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
  //    only for games we haven't posted yet. The h2h pick is the favorite
  //    (highest real chance to win), not the biggest payout.
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
  //    totals, double chance - plus total corners for info only) to widen
  //    the pool of safe combo legs beyond h2h favorites - kept rare because
  //    each extra region+market combo costs separate API quota.
  if (shouldRunExtraMarkets(data, now)) {
    console.log(`Fetching extra soccer markets (totals/double chance/corners) - last run: ${data.extraMarketsLastRun || "never"}`);
    for (const sport of EXTRA_MARKETS_SPORTS) {
      try {
        const events = await getEvents(sport.key, nowIso, windowEndIso);
        const orderedEvents = prioritizeExtraMarketsEvents(events, sport.key, allLegCandidates);
        const eventsToCheck = orderedEvents.slice(0, EXTRA_MARKETS_MAX_EVENTS_PER_SPORT);
        let found = [];
        let cornersFound = [];
        for (const event of eventsToCheck) {
          try {
            const game = await getExtraSoccerOddsForEvent(sport.key, event.id);
            const { candidates, cornersInfo } = extractExtraMarketCandidates(sport.key, sport.label, game);
            found = found.concat(candidates);
            cornersFound = cornersFound.concat(cornersInfo);
          } catch (eventError) {
            console.log(`WARNING: ${eventError.message}`);
          }
        }
        const generated = buildExtraMarketTips(found, existingIds);
        generated.forEach(t => existingIds.add(t.id));
        newTips = newTips.concat(generated);
        allLegCandidates = allLegCandidates.concat(found);
        console.log(`${sport.label}: ${events.length} event(s) in window, checked ${eventsToCheck.length}, ${found.length} extra-market candidate(s), ${generated.length} new tip(s)`);
        if (cornersFound.length > 0) {
          const safeCorners = cornersFound.filter(
            c => Number.isFinite(Number(c.odds)) && Number(c.odds) <= ODDS_THRESHOLD_AMERICAN
          );
          console.log(
            `${sport.label}: ${cornersFound.length} total-corners odds seen (enfo sèlman, pa antre nan tip/konbo) - ${safeCorners.length} ta kalifye pou -${Math.abs(ODDS_THRESHOLD_AMERICAN)} si nou te enkli yo`
          );
        }
      } catch (error) {
        console.log(`WARNING: ${error.message}`);
      }
    }
    data.extraMarketsLastRun = nowIso;
  } else {
    console.log(`Skipping extra soccer markets (runs every ${EXTRA_MARKETS_INTERVAL_HOURS}h, last run ${data.extraMarketsLastRun})`);
  }

  // 4. Build ONE "mega-parlay" combo tip (>= MIN_SELECTIONS legs, all at or
  //    beyond ODDS_THRESHOLD_AMERICAN) from the safest legs pooled above.
  logThresholdDistribution(allLegCandidates);
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
