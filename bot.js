const fs = require("fs");

const API_KEY = process.env.ODDS_API_KEY;

if (!API_KEY) {
  throw new Error("ODDS_API_KEY is missing");
}

const TIPS_FILE = "tips.json";
const WINDOW_DAYS = 5; // only track games starting within this many days
const COMBO_SIZES = [2, 3]; // generate one combo tip per size, per run

const SPORTS = [
  { key: "soccer_epl", label: "EPL" },
  { key: "soccer_usa_mls", label: "MLS" },
  { key: "basketball_nba", label: "NBA" },
  { key: "baseball_mlb", label: "MLB" },
  { key: "americanfootball_nfl", label: "NFL" }
];

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
    return { updatedAt: null, stats: emptyStats(), tips: [] };
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

// Pulls the single best (highest-price) h2h outcome out of a game's odds -
// shared by single-game tips and by combo legs, so both pick the same way.
function extractLegCandidate(sportKey, label, game) {
  const bookmaker = game.bookmakers?.[0];
  if (!bookmaker) return null;

  const market = (bookmaker.markets || []).find(m => m.key === "h2h");
  if (!market) return null;

  const outcomes = market.outcomes || [];
  if (outcomes.length < 2) return null;

  const best = outcomes.reduce((a, b) =>
    Number(a.price) > Number(b.price) ? a : b
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
    pick: best.name,
    odds: Number(best.price),
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

// Builds a couple of multi-game combo ("parlay") tips out of the soonest
// upcoming games across all sports, in addition to the single-game tips.
function buildComboTips(legCandidates, existingIds) {
  const combos = [];
  const bySoonest = legCandidates
    .slice()
    .sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));

  for (const size of COMBO_SIZES) {
    if (bySoonest.length < size) continue;

    const legs = bySoonest.slice(0, size);
    const id = comboId(legs);
    if (existingIds.has(id)) continue;

    const decimal = legs.reduce((acc, l) => acc * americanToDecimal(l.odds), 1);

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
        odds: l.odds,
        bookmaker: l.bookmaker
      })),
      commenceTime: legs[0].commenceTime, // earliest leg (bySoonest is sorted)
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
  //    only for games we haven't posted yet.
  let newTips = [];
  const allLegCandidates = [];
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

  // 3. Build a couple of multi-game combo tips (2-leg and 3-leg) from the
  //    soonest upcoming games across every sport, in addition to the
  //    single-game tips above.
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
