// services/settlementService.js
//const fetch = require('node-fetch'); // Omit if using Node 18+

const ODDS_API_KEY = process.env.ODDS_API_KEY;

async function settleCompletedMatchups(db) {
  if (!ODDS_API_KEY) return;

  try {
    // 1. Fetch pending matchups that have started
    const pendingRes = await db.query(
      `SELECT * FROM matchups 
       WHERE status = 'scheduled' AND start_time <= NOW()`
    );

    if (pendingRes.rows.length === 0) return;

    // 2. Query finished scores from Odds API (or scores endpoint)
    const response = await fetch(
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/scores/?apiKey=${ODDS_API_KEY}&daysFrom=1`
    );
    const scoresData = await response.json();

    for (const matchup of pendingRes.rows) {
      // Locate matching completed game
      const completedGame = scoresData.find(
        (g) => g.completed && `${g.away_team} vs. ${g.home_team}: Who will win?` === matchup.prop_text
      );

      if (!completedGame) continue;

      // Determine winning option
      const homeScore = parseInt(completedGame.scores.find(s => s.name === completedGame.home_team)?.score || 0);
      const awayScore = parseInt(completedGame.scores.find(s => s.name === completedGame.away_team)?.score || 0);
      
      const winningOption = awayScore > homeScore ? matchup.option_a : matchup.option_b;

      // 3. Begin DB Transaction to settle picks and streaks
      const client = await db.connect();
      try {
        await client.query('BEGIN');

        // Update matchup status
        await client.query(
          `UPDATE matchups SET status = 'completed', winning_option = $1 WHERE matchup_id = $2`,
          [winningOption, matchup.matchup_id]
        );

        // Fetch picks for this matchup
        const picksRes = await client.query(
          `SELECT * FROM picks WHERE matchup_id = $1`,
          [matchup.matchup_id]
        );

        for (const pick of picksRes.rows) {
          const isWin = pick.selected_option === winningOption;

          if (isWin) {
            // Increment current streak & update longest streak if current exceeds it
            await client.query(
              `UPDATE users 
               SET current_streak = current_streak + 1,
                   longest_streak = GREATEST(longest_streak, current_streak + 1)
               WHERE user_id = $1`,
              [pick.user_id]
            );
          } else {
            // Reset current streak to 0 on a loss
            await client.query(
              `UPDATE users SET current_streak = 0 WHERE user_id = $1`,
              [pick.user_id]
            );
          }
        }

        await client.query('COMMIT');
        console.log(`Successfully settled matchup ${matchup.matchup_id}. Winner: ${winningOption}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Transaction failed for matchup ${matchup.matchup_id}:`, err);
      } finally {
        client.release();
      }
    }
  } catch (error) {
    console.error('Error during settlement run:', error);
  }
}

module.exports = { settleCompletedMatchups };