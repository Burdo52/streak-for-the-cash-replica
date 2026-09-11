const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron'); // <--- ADD THIS
const { fetchAndIngestMatchups } = require('./services/oddsApi');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());

// Serving static files (index.html, manifest.json, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Environment Configurations
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-streak-key';
const ODDS_API_KEY = process.env.ODDS_API_KEY || 'YOUR_ODDS_API_KEY';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://streak_user:streak_password@localhost:5432/streak_db';

// PostgreSQL Pool Connection
const db = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware to inject DB pool into requests
app.use((req, res, next) => {
    req.db = db;
    next();
});

// Rate Limiter for Authentication
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: { error: "Too many attempts. Try again in 15 minutes." }
});

// JWT Verification Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: "Access denied. Authentication token missing." });
    }

    jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
        if (err) return res.status(403).json({ error: "Invalid or expired token." });
        req.user = decodedUser;
        next();
    });
}

// -------------------------------------------------------------
// AUTHENTICATION ENDPOINTS
// -------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING user_id, username`,
      [username, hashedPassword]
    );
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.user_id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ token, user: { id: user.user_id, username: user.username } });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.query(`SELECT * FROM users WHERE username = $1`, [username]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Invalid username or password' });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ error: 'Invalid username or password' });

    const token = jwt.sign({ userId: user.user_id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.user_id, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// -------------------------------------------------------------
// GAME LOGIC ENDPOINTS
// -------------------------------------------------------------

// Fetch Active Matchups
// GET /api/matchups?date=2026-09-10
// GET /api/matchups?date=2026-09-10
// GET /api/matchups?date=2026-09-10
// GET /api/matchups?date=2026-09-11
// GET /api/matchups?date=2026-09-11
// GET /api/matchups?date=2026-09-11
app.get('/api/matchups', async (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toLocaleDateString('sv-SE');
    let userId = null;

    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      if (token && token !== 'null' && token !== 'undefined' && process.env.JWT_SECRET) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          userId = decoded.user_id || decoded.id;
        } catch (jwtErr) {
          console.warn('JWT verification skipped:', jwtErr.message);
        }
      }
    }

    const queryUserId = userId ? userId : -1;

    // Use explicit timestamptz conversion for accurate Eastern local date filtering
    const result = await db.query(`
      SELECT 
        m.matchup_id,
        m.sport,
        m.prop_text,
        m.option_a,
        m.option_b,
        m.start_time,
        m.status,
        up.selected_option AS user_pick
      FROM matchups m
      LEFT JOIN user_picks up ON m.matchup_id = up.matchup_id AND up.user_id = $1
      WHERE DATE(m.start_time::timestamptz AT TIME ZONE 'America/New_York') = $2::date
      ORDER BY m.start_time ASC
    `, [queryUserId, targetDate]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching filtered matchups:', err);
    res.status(500).json({ error: 'Failed to retrieve matchups.' });
  }
});

// Make a Pick (Locks previous selection enforcement)
app.post('/api/picks', authenticateToken, async (req, res) => {
  const { matchup_id, selected_option } = req.body;
  const userId = req.user.user_id;

  try {
    // 1. Fetch the matchup to verify start time and status
    const matchupRes = await db.query(
      'SELECT start_time, status FROM matchups WHERE matchup_id = $1',
      [matchup_id]
    );

    if (matchupRes.rows.length === 0) {
      return res.status(404).json({ error: 'Matchup not found.' });
    }

    const matchup = matchupRes.rows[0];
    const now = new Date();
    const startTime = new Date(matchup.start_time);

    // 2. Reject pick if the game has already started or is completed
    if (now >= startTime || matchup.status !== 'scheduled') {
      return res.status(400).json({ 
        error: 'Picks are locked for this matchup because the game has already started.' 
      });
    }

    // 3. Upsert (Insert or Update) user pick
    await db.query(`
      INSERT INTO user_picks (user_id, matchup_id, selected_option)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, matchup_id) 
      DO UPDATE SET selected_option = EXCLUDED.selected_option, updated_at = NOW()
    `, [userId, matchup_id, selected_option]);

    res.json({ message: 'Pick successfully submitted!' });
  } catch (err) {
    console.error('Error submitting pick:', err);
    res.status(500).json({ error: 'Failed to submit pick.' });
  }
});

// Leaderboards
app.get('/api/leaderboards/active', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT user_id, username, current_streak FROM users ORDER BY current_streak DESC LIMIT 50`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/leaderboard - Top users by streak length
app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        user_id, 
        username, 
        current_streak, 
        longest_streak,
        created_at
      FROM users
      ORDER BY current_streak DESC, longest_streak DESC
      LIMIT 50
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    res.status(500).json({ error: 'Failed to retrieve leaderboard' });
  }
});

// GET /api/users/picks - Fetch pick history for the logged-in user
app.get('/api/users/picks', authenticateToken, async (req, res) => {
  const userId = req.user.user_id;

  try {
    const result = await db.query(`
      SELECT 
        p.pick_id,
        p.selected_option,
        p.created_at AS pick_time,
        m.prop_text,
        m.sport,
        m.status AS matchup_status,
        m.winning_option
      FROM user_picks p
      JOIN matchups m ON p.matchup_id = m.matchup_id
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC
    `, [userId]);

    // Format win/loss outcome for each pick
    const history = result.rows.map(row => {
      let resultStatus = 'Pending';
      if (row.matchup_status === 'completed') {
        resultStatus = row.selected_option === row.winning_option ? 'Win' : 'Loss';
      }

      return {
        pickId: row.pick_id,
        sport: row.sport,
        propText: row.prop_text,
        selectedOption: row.selected_option,
        winningOption: row.winning_option,
        status: resultStatus,
        date: row.pick_time
      };
    });

    res.json(history);
  } catch (err) {
    console.error('Error fetching user pick history:', err);
    res.status(500).json({ error: 'Failed to retrieve pick history.' });
  }
});

// POST /api/admin/ingest - Manual trigger for Odds API
app.post('/api/admin/ingest', async (req, res) => {
  try {
    console.log('⚡ Manual ingestion triggered via API');
    await fetchAndIngestMatchups(db);
    res.json({ message: 'Ingestion complete! Check database for new matchups.' });
  } catch (err) {
    console.error('Manual ingestion error:', err);
    res.status(500).json({ error: 'Failed to run ingestion: ' + err.message });
  }
});

// -------------------------------------------------------------
// AUTOMATED CRON WORKERS (Settlement & Data Ingestion)
// -------------------------------------------------------------

// Settlement Cron: Runs every 15 minutes
cron.schedule('*/15 * * * *', async () => {
    console.log('[CRON] Running game settlement check...');
    const client = await db.connect();

    try {
        // Find completed matchups pending settlement
        const completedMatchups = await client.query(
            `SELECT * FROM matchups WHERE status = 'COMPLETED' AND winning_option IS NOT NULL`
        );

        for (const game of completedMatchups.rows) {
            await client.query('BEGIN');

            const pendingPicks = await client.query(
                `SELECT * FROM user_picks WHERE matchup_id = $1 AND status = 'LOCKED'`,
                [game.matchup_id]
            );

            for (const pick of pendingPicks.rows) {
                if (game.winning_option === 'PUSH') {
                    // PUSH: Unlock pick without modifying streak
                    await client.query(`UPDATE user_picks SET status = 'PUSH' WHERE pick_id = $1`, [pick.pick_id]);
                } else if (pick.selected_option === game.winning_option) {
                    // WIN: Increment current streak, update longest streak if needed
                    await client.query(`UPDATE user_picks SET status = 'WIN' WHERE pick_id = $1`, [pick.pick_id]);
                    await client.query(
                        `UPDATE users 
                         SET current_streak = current_streak + 1,
                             longest_streak = GREATEST(longest_streak, current_streak + 1)
                         WHERE user_id = $1`,
                        [pick.user_id]
                    );
                } else {
                    // LOSS: Reset streak to 0
                    await client.query(`UPDATE user_picks SET status = 'LOSS' WHERE pick_id = $1`, [pick.pick_id]);
                    await client.query(`UPDATE users SET current_streak = 0 WHERE user_id = $1`, [pick.user_id]);
                }
            }

            await client.query('COMMIT');
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[CRON] Settlement error:', err.message);
    } finally {
        client.release();
    }
});

cron.schedule('0 * * * *', () => {
  console.log('Running automated Odds API sync...');
  fetchAndIngestMatchups(db);
});

const { settleCompletedMatchups } = require('./services/settlementService');

// Run settlement routine every 15 minutes
cron.schedule('*/15 * * * *', () => {
  console.log('Running automated game settlement sync...');
  settleCompletedMatchups(db);
});

// Schedule daily ingestion at 4:00 AM EDT (08:00 UTC)
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ [CRON] Starting daily Odds API ingestion...');
  try {
    await fetchAndIngestMatchups(db);
    console.log('✅ [CRON] Daily Odds API ingestion complete.');
  } catch (err) {
    console.error('❌ [CRON] Failed to execute Odds API ingestion:', err);
  }
});

// Run once when the server boots up in production
if (process.env.NODE_ENV === 'production') {
  fetchAndIngestMatchups(db);
}

// Server Initialization
app.listen(PORT, () => {
    console.log(`Streak Server running on port ${PORT}`);
});