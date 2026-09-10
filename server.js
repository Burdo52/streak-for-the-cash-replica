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

app.post('/api/auth/register', authLimiter, async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: "All fields are required." });

    try {
        const userCheck = await db.query('SELECT user_id FROM users WHERE username = $1 OR email = $2', [username, email]);
        if (userCheck.rows.length > 0) return res.status(409).json({ error: "Username or email taken." });

        const hashedPassword = await bcrypt.hash(password, 12);
        const newUser = await db.query(
            `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id, username, current_streak`,
            [username, email, hashedPassword]
        );

        const user = newUser.rows[0];
        const token = jwt.sign({ userId: user.user_id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({ token, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required." });

    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1 OR email = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: "Invalid credentials." });

        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: "Invalid credentials." });

        const token = jwt.sign({ userId: user.user_id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user.user_id, username: user.username, currentStreak: user.current_streak } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -------------------------------------------------------------
// GAME LOGIC ENDPOINTS
// -------------------------------------------------------------

// Fetch Active Matchups
app.get('/api/matchups', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT 
                matchup_id, 
                sport, 
                category, 
                prop_text, 
                option_a, 
                option_b, 
                start_time, 
                status 
            FROM matchups 
            WHERE status IN ('scheduled', 'pending')
            ORDER BY start_time ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching matchups:', err);
        res.status(500).json({ error: 'Failed to retrieve matchups' });
    }
});

// Make a Pick (Locks previous selection enforcement)
app.post('/api/picks', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { matchupId, selectedOption } = req.body;

    try {
        // Validate game lock time
        const matchupRes = await db.query('SELECT start_time, status FROM matchups WHERE matchup_id = $1', [matchupId]);
        if (matchupRes.rows.length === 0) return res.status(404).json({ error: "Matchup not found." });

        const matchup = matchupRes.rows[0];
        if (new Date() >= new Date(matchup.start_time) || matchup.status !== 'SCHEDULED') {
            return res.status(400).json({ error: "Pick locked! Game has already started." });
        }

        // Insert new pick (Database unique index enforces only ONE locked pick)
        const newPick = await db.query(
            `INSERT INTO user_picks (user_id, matchup_id, selected_option, status)
             VALUES ($1, $2, $3, 'LOCKED') RETURNING *`,
            [userId, matchupId, selectedOption]
        );

        res.status(201).json({ message: "Pick locked in!", pick: newPick.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: "You already have an active pick locked in! Wait for it to settle." });
        }
        res.status(500).json({ error: err.message });
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

// Run once when the server boots up in production
if (process.env.NODE_ENV === 'production') {
  fetchAndIngestMatchups(db);
}

// Server Initialization
app.listen(PORT, () => {
    console.log(`Streak Server running on port ${PORT}`);
});