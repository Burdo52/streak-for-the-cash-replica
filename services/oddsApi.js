const fetch = require('node-fetch'); // Ensure node-fetch or native fetch is available

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4/sports';

/**
 * Fetches active upcoming sports events and generates Streak props
 */
async function fetchAndIngestMatchups(db) {
  if (!ODDS_API_KEY) {
    console.warn('ODDS_API_KEY is not set in environment variables.');
    return;
  }

  try {
    // Example: Fetch upcoming MLB game odds
    const response = await fetch(
      `${BASE_URL}/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american`
    );

    if (!response.ok) {
      throw new Error(`Odds API HTTP error! status: ${response.status}`);
    }

    const games = await response.json();

    for (const game of games.slice(0, 5)) { // Limit to 5 games per fetch
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;
      const startTime = game.commence_time;
      const propText = `${awayTeam} vs. ${homeTeam}: Who will win?`;

      // Check if matchup already exists to prevent duplicates
      const checkRes = await db.query(
        'SELECT matchup_id FROM matchups WHERE prop_text = $1 AND start_time = $2',
        [propText, startTime]
      );

      if (checkRes.rows.length === 0) {
        await db.query(
          `INSERT INTO matchups (sport, category, prop_text, option_a, option_b, start_time, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          ['MLB', 'Game Winner', propText, awayTeam, homeTeam, startTime, 'scheduled']
        );
        console.log(`Ingested new matchup: ${propText}`);
      }
    }
  } catch (error) {
    console.error('Error fetching odds:', error);
  }
}

module.exports = { fetchAndIngestMatchups };