const fs = require("fs");

const API_KEY = process.env.ODDS_API_KEY;

if (!API_KEY) {
  throw new Error("ODDS_API_KEY is missing");
}

const TIPS_FILE = "tips.json";
const WINDOW_DAYS = 5; // only track games starting within this many days

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

function buildNewTips(sportKey, label, games, existingIds) {
  const tips = [];

  for (const game of games) {
    const bookmaker = game.bookmakers?.[0];
    if (!bookmaker) continue;

    const market = (bookmaker.markets || []).find(m => m.key === "h2h");
    if (!market) continue;

    const outcomes = market.outcomes || [];
    if (outcomes.length < 2) continue;

    const best = outcomes.reduce((a, b) =>
      Number(a.price) > Number(b.price) ? a : b
    );

    const id = makeTipId(sportKey, game.id, market.key);
    if (existingIds.has(id)) continue;

    tips.push({
      id,
      sport: label,
      sportKey,
      eventId: game.id,
      game: `${game.away_team} @ ${game.home_team}`,
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      commenceTime: game.commence_time,
      market: "h2h",
      pick: best.name,
      odds: Number(best.price),
      bookmaker: bookmaker.title,
      status: "PENDING",
      tier: "free",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    });
  }

  return tips;
}

function pruneFarFutureTips(tips, now) {
  const cutoff = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // Keep every resolved tip (history for the stats/record). Only drop
  // still-pending placeholders that are further out than the active window -
  // they get recreated automatically once they fall back inside it.
  return tips.filter(tip => tip.status !== "PENDING" || new Date(tip.commenceTime) <= cutoff);
}

function sportNeedsScoreCheck(sportKey, tips, now) {
  return tips.some(
    t => t.sportKey === sportKey && t.status === "PENDING" && new Date(t.commenceTime) <= now
  );
}

function resolveTips(pendingTips, scoresBySport) {
  for (const tip of pendingTips) {
    if (tip.status !== "PENDING") continue;

    const scoreEvents = scoresBySport[tip.sportKey] || [];
    const match = scoreEvents.find(e => e.id === tip.eventId);
    if (!match || !match.completed || !Array.isArray(match.scores)) continue;

    const homeScore = match.scores.find(s => s.name === tip.homeTeam);
    const awayScore = match.scores.find(s => s.name === tip.awayTeam);
    if (!homeScore || !awayScore) continue;

    const home = Number(homeScore.score);
    const away = Number(awayScore.score);
    if (Number.isNaN(home) || Number.isNaN(away)) continue;

    let winner = null;
    if (home > away) winner = tip.homeTeam;
    else if (away > home) winner = tip.awayTeam;

    tip.resolvedAt = new Date().toISOString();
    if (winner === null) {
      tip.status = "PUSH";
    } else if (winner === tip.pick) {
      tip.status = "WON";
    } else {
      tip.status = "LOST";
    }
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
  //    request on a sport if it actually has a pending tip whose game has
  //    already started. Most sports most of the time won't, so this avoids
  //    a lot of unnecessary API calls.
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
  for (const sport of SPORTS) {
    try {
      const games = await getOdds(sport.key, nowIso, windowEndIso);
      const generated = buildNewTips(sport.key, sport.label, games, existingIds);
      generated.forEach(t => existingIds.add(t.id));
      newTips = newTips.concat(generated);
      console.log(`${sport.label}: ${games.length} games in window, ${generated.length} new tip(s)`);
    } catch (error) {
      console.log(`WARNING: ${error.message}`);
    }
  }

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
