
const API_KEY = process.env.ODDS_API_KEY;

if (!API_KEY) {
  throw new Error("ODDS_API_KEY is missing");
}

const sports = [
  "soccer_epl",
  "soccer_usa_mls",
  "basketball_nba",
  "baseball_mlb"
];

async function getOdds(sport) {
  const url =
    `https://api.the-odds-api.com/v4/sports/${sport}/odds` +
    `?regions=us&markets=h2h,spreads,totals&oddsFormat=american` +
    `&apiKey=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${sport}: API error ${response.status}`);
  }

  return response.json();
}

function makeTips(games) {
  const tips = [];

  for (const game of games) {
    const bookmaker = game.bookmakers?.[0];
    if (!bookmaker) continue;

    const markets = bookmaker.markets || [];

    for (const market of markets) {
      if (market.key !== "h2h") continue;

      const outcomes = market.outcomes || [];
      if (outcomes.length < 2) continue;

      const best = outcomes.reduce((a, b) =>
        Number(a.price) > Number(b.price) ? a : b
      );

      tips.push({
        sport: game.sport_title || game.sport_key,
        game: `${game.away_team} vs ${game.home_team}`,
        pick: best.name,
        odds: best.price,
        bookmaker: bookmaker.title
      });
    }
  }

  return tips;
}

async function main() {
  console.log("🏆 SPORTS TIP BOT STARTING...");
  console.log("📡 Getting live/upcoming odds...");

  let allGames = [];

  for (const sport of sports) {
    try {
      const games = await getOdds(sport);
      allGames.push(...games);
      console.log(`✅ ${sport}: ${games.length} games`);
    } catch (error) {
      console.log(`⚠️ ${error.message}`);
    }
  }

  const tips = makeTips(allGames);

  console.log("\n🔥 SPORTS TIPS 🔥\n");

  if (tips.length === 0) {
    console.log("No games/odds available right now.");
    return;
  }

  tips.slice(0, 10).forEach((tip, i) => {
    console.log(
      `${i + 1}. ${tip.game}\n` +
      `   PICK: ${tip.pick} (${tip.odds > 0 ? "+" : ""}${tip.odds})\n` +
      `   BOOK: ${tip.bookmaker}\n`
    );
  });

  console.log(`✅ ${tips.length} tips generated.`);
}

main().catch(error => {
  console.error("❌ BOT ERROR:", error.message);
  process.exit(1);
});
