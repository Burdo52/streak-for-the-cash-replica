//const fetch = require('node-fetch'); // Ensure node-fetch or native fetch is available

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4/sports';
const axios = require('axios');

const TOP_NCAAF_TEAMS = [
  'Georgia', 'Ohio State', 'Texas', 'Alabama', 'Oregon', 
  'Ole Miss', 'Penn State', 'Notre Dame', 'Missouri', 'Michigan', 
  'Tennessee', 'Florida State', 'LSU', 'Clemson', 'Utah', 
  'Kansas State', 'Oklahoma', 'Oklahoma State', 'Miami', 'Texas A&M'
];

/**
 * Fetches active upcoming sports events and generates Streak props
 */
async function fetchAndIngestMatchups(db) {
  const apiKey = ODDS_API_KEY;
  if (!apiKey) {
    console.error('Missing ODDS_API_KEY in environment variables');
    return;
  }

  // Sports to ingest
  const sports = [
    'baseball_mlb',
    'soccer_epl',
    'americanfootball_nfl',
    'americanfootball_ncaaf'
  ];

  for (const sportKey of sports) {
    try {
      console.log(`Fetching odds for ${sportKey}...`);
      const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds`, {
        params: {
          apiKey: apiKey,
          regions: 'us',
          markets: 'h2h', // Head-to-head / Moneyline
          dateFormat: 'iso'
        }
      });

      const games = response.data;

      for (const game of games) {
        // Filter NCAAF games to only include Top 20 matchups
        if (sportKey === 'americanfootball_ncaaf') {
          const isTop20 = TOP_NCAAF_TEAMS.some(team => 
            game.home_team.includes(team) || game.away_team.includes(team)
          );
          if (!isTop20) continue; // Skip non-ranked/unfeatured games
        }

        // Format sport label for UI display
        let sportLabel = 'Sports';
        if (sportKey.includes('mlb')) sportLabel = 'MLB';
        if (sportKey.includes('epl')) sportLabel = 'EPL';
        if (sportKey.includes('nfl')) sportLabel = 'NFL';
        if (sportKey.includes('ncaaf')) sportLabel = 'NCAAF';

        const propText = `${game.away_team} @ ${game.home_team}`;
        const optionA = game.away_team;
        const optionB = game.home_team;
        const startTime = game.commence_time;

        // Upsert matchup into database (prevents duplicate entries)
        await db.query(`
          INSERT INTO matchups (sport, prop_text, option_a, option_b, start_time, status)
          VALUES ($1, $2, $3, $4, $5, 'scheduled')
          ON CONFLICT (prop_text, start_time) DO NOTHING
        `, [sportLabel, propText, optionA, optionB, startTime]);
      }
    } catch (err) {
      console.error(`Error ingesting ${sportKey}:`, err.message);
    }
  }
}

module.exports = { fetchAndIngestMatchups };