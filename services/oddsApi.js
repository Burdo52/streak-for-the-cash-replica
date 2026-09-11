//const fetch = require('node-fetch'); // Ensure node-fetch or native fetch is available

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4/sports';
const axios = require('axios');


/**
 * Fetches active upcoming sports events and generates Streak props
 */
async function fetchAndIngestMatchups(db) {
  const apiKey = ODDS_API_KEY;
  if (!apiKey) {
    console.error('Missing ODDS_API_KEY in environment variables');
    return;
  }

  // Pull dynamic AP Top 25 list
  const rankMap = await getTop25RankMap();

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
        let awayLabel = game.away_team;
        let homeLabel = game.home_team;

        if (sportKey === 'americanfootball_ncaaf') {
          const isAwayRanked = Object.keys(rankMap).some(s => game.away_team.toLowerCase().includes(s));
          const isHomeRanked = Object.keys(rankMap).some(s => game.home_team.toLowerCase().includes(s));

          // Skip non-ranked matchups
          if (!isAwayRanked && !isHomeRanked) continue;

          // Add ranking prefix to team strings
          awayLabel = formatTeamWithRank(game.away_team, rankMap);
          homeLabel = formatTeamWithRank(game.home_team, rankMap);
        }

        // Format sport label for UI display
        let sportLabel = 'Sports';
        if (sportKey.includes('mlb')) sportLabel = 'MLB';
        if (sportKey.includes('epl')) sportLabel = 'EPL';
        if (sportKey.includes('nfl')) sportLabel = 'NFL';
        if (sportKey.includes('ncaaf')) sportLabel = 'NCAAF';

        const propText = `${awayLabel} @ ${homeLabel}`;
        const optionA = awayLabel;
        const optionB = homeLabel;
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

// Fetch AP Top 25 team ranks as a map: { "school_name": rank_number }
async function getTop25RankMap() {
  try {
    const currentYear = new Date().getFullYear();
    const response = await axios.get('https://api.collegefootballdata.com/rankings', {
      headers: { 'Authorization': `Bearer ${process.env.CFBD_API_KEY}` },
      params: { year: currentYear, seasonType: 'regular' }
    });

    const latestWeek = response.data[response.data.length - 1];
    if (!latestWeek) return {};

    const apPoll = latestWeek.polls.find(p => p.poll === 'AP Top 25');
    if (!apPoll) return {};

    const rankMap = {};
    apPoll.ranks.forEach(r => {
      rankMap[r.school.toLowerCase()] = r.rank;
    });

    return rankMap;
  } catch (err) {
    console.error('Failed to fetch CFBD rankings:', err.message);
    return {};
  }
}

// Helper to append "#X " prefix if team is ranked
function formatTeamWithRank(teamName, rankMap) {
  const cleanName = teamName.toLowerCase();
  
  // Find matching school in rankMap
  const matchedSchool = Object.keys(rankMap).find(school => cleanName.includes(school));
  
  if (matchedSchool) {
    const rank = rankMap[matchedSchool];
    return `#${rank} ${teamName}`;
  }
  
  return teamName;
}

module.exports = { fetchAndIngestMatchups };