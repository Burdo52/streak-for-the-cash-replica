// services/settlementService.js

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

    // 2. Query finished scores from Odds API
    const response = await fetch(
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/scores/?apiKey=${ODDS_API_KEY}&daysFrom=1`
    );
    const scoresData = await response.json();

    // Guard Check: Ensure API returned a valid array before calling .find()
    if (!Array.isArray(scoresData)) {
      console.warn('⚠️ Settlement skipped: Odds API response is not an array:', scoresData?.message || scoresData);
      return;
    }

    for (const matchup of pendingRes.rows) {
      // Locate matching completed game safely
      const completedGame = scoresData.find((g) => {
        if (!g.completed || !g.scores) return false;

        // Extract option strings for matching
        const optionA = (matchup.option_a || '').toLowerCase().trim();
        const optionB = (matchup.option_b || '').toLowerCase().trim();
        const homeTeam = (g.home_team || '').toLowerCase().trim();
        const awayTeam = (g.away_team || '').toLowerCase().trim();

        // Match if both options equal the home/away teams returned by the API
        return (optionA === homeTeam && optionB === awayTeam) || 
               (optionA === awayTeam && optionB === homeTeam) ||
               matchup.prop_text.includes(g.home_team) && matchup.prop_text.includes(g.away_team);
      });

      if (!completedGame) continue;

      // Determine winning option
      const homeScore = parseInt(completedGame.scores.find(s => s.name === completedGame.home_team)?.score || 0);
      const awayScore = parseInt(completedGame.scores.find(s => s.name === completedGame.away_team)?.score || 0);

      if (homeScore === awayScore) {
        // Handle Push or Tie if applicable
        continue;
      }
      
      const winningTeamName = awayScore > homeScore ? completedGame.away_team : completedGame.home_team;
      
      // Match winning team name back to option_a or option_b
      const winningOption = matchup.option_a.toLowerCase().includes(winningTeamName.toLowerCase())
        ? matchup.option_a
        : matchup.option_b;

      // 3. Begin DB Transaction to settle picks, user_picks status, and streaks
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
          `SELECT * FROM user_picks WHERE matchup_id = $1`,
          [matchup.matchup_id]
        );

        for (const pick of picksRes.rows) {
          const isWin = pick.selected_option === winningOption;
          const pickStatus = isWin ? 'WIN' : 'LOSS';

          // Update user_picks table status
          await client.query(
            `UPDATE user_picks SET status = $1 WHERE user_pick_id = $2`,
            [pickStatus, pick.user_pick_id || pick.id]
          );

          if (isWin) {
            // Increment current streak & update longest streak
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