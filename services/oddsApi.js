//const fetch = require('node-fetch'); // Ensure node-fetch or native fetch is available

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = 'https://api.the-odds-api.com/v4/sports';
const axios = require('axios');


/**
 * Fetches active upcoming sports events and generates Streak props
 */
async function fetchAndIngestMatchups(db) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.error('❌ Ingestion Error: Missing ODDS_API_KEY');
    return;
  }

  console.log('🔄 Fetching Top 25 Rank Map from CFBD...');
  const rankMap = await getTop25RankMap();
  console.log(`📊 Loaded ${Object.keys(rankMap).length} ranked teams from CFBD:`, rankMap);

  const sports = ['baseball_mlb', 'soccer_epl', 'americanfootball_nfl', 'americanfootball_ncaaf', 'basketball_nba',
  'icehockey_nhl'];

  for (const sportKey of sports) {
    try {
      console.log(`\n🔍 Fetching odds for ${sportKey}...`);
      const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds`, {
        params: { 
          apiKey, 
          regions: 'us', 
          markets: 'h2h', 
          dateFormat: 'iso' 
        }
      });

      const games = response.data;
      console.log(`📦 Received ${games.length} raw games for ${sportKey}`);

      let insertedCount = 0;

      for (const game of games) {
        let awayLabel = game.away_team;
        let homeLabel = game.home_team;
        let sportLabel = 'Sports';

        if (sportKey.includes('mlb')) sportLabel = 'MLB';
        if (sportKey.includes('epl')) sportLabel = 'EPL';
        if (sportKey.includes('nfl')) sportLabel = 'NFL';
        if (sportKey.includes('nba')) sportLabel = 'NBA';
        if (sportKey.includes('nhl')) sportLabel = 'NHL';

        if (sportKey === 'americanfootball_ncaaf') {
          sportLabel = 'NCAAF';

          const isAwayRanked = Object.keys(rankMap).some(s => game.away_team.toLowerCase().includes(s));
          const isHomeRanked = Object.keys(rankMap).some(s => game.home_team.toLowerCase().includes(s));

          if (!isAwayRanked && !isHomeRanked) {
            console.log(`   ⏭️ Skipping unranked NCAAF: ${game.away_team} vs ${game.home_team}`);
            continue;
          }

          awayLabel = formatTeamWithRank(game.away_team, rankMap);
          homeLabel = formatTeamWithRank(game.home_team, rankMap);
        }

        const propText = `${awayLabel} @ ${homeLabel}`;
        const categoryValue = sportLabel;

        const dbRes = await db.query(`
          INSERT INTO matchups (sport, category, prop_text, option_a, option_b, start_time, status)
          SELECT $1, $2, $3, $4, $5, $6, 'scheduled'
          WHERE NOT EXISTS (
            SELECT 1 FROM matchups 
            WHERE prop_text = $3 AND start_time = $6
          )
        `, [sportLabel, categoryValue, propText, awayLabel, homeLabel, game.commence_time]);

        if (dbRes.rowCount > 0) {
          insertedCount++;
        }
      }

      console.log(`✅ Ingested ${insertedCount} new matchups for ${sportKey}`);
    } catch (err) {
      console.error(`❌ Error processing ${sportKey}:`, err.response ? err.response.data : err.message);
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