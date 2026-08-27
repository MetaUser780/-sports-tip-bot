const API_KEY = process.env.ODDS_API_KEY;

async function getOdds() {
  if (!API_KEY) {
    throw new Error("ODDS_API_KEY is not configured.");
  }

  const url =
    `https://api.the-odds-api.com/v4/sports/soccer_epl/odds` +
    `?apiKey=${API_KEY}&regions=us&markets=h2h,totals&oddsFormat=decimal`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Odds API error: ${response.status}`);
  }

  return await response.json();
}

function analyzeGames(games) {
  return games.map((game) => ({
    sport: game.sport_title,
    home: game.home_team,
    away: game.away_team,
    bookmakers: game.bookmakers?.length || 0,
    commenceTime: game.commence_time
  }));
}

async function main() {
  console.log("🏆 Sports Tip Bot starting...");

  const games = await getOdds();

  if (!games.length) {
    console.log("No games found.");
    return;
  }

  const tips = analyzeGames(games);

  console.log(`Found ${tips.length} games.`);

  for (const tip of tips) {
    console.log(
      `${tip.home} vs ${tip.away} | Bookmakers: ${tip.bookmakers}`
    );
  }

  console.log("✅ Sports Tip Bot finished.");
}

main().catch((error) => {
  console.error("❌ Bot error:", error.message);
  process.exit(1);
});
