-- Remove existing tables for a clean slate during setup
DROP TABLE IF EXISTS user_picks CASCADE;
DROP TABLE IF EXISTS matchups CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- 1. Users Table
CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    current_streak INT DEFAULT 0,
    longest_streak INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Matchups Table
CREATE TABLE matchups (
    matchup_id SERIAL PRIMARY KEY,
    sport_key VARCHAR(50) NOT NULL,
    event_id VARCHAR(100) UNIQUE NOT NULL,
    category VARCHAR(100) NOT NULL,
    prop_text VARCHAR(255) NOT NULL,
    option_a VARCHAR(100) NOT NULL,
    option_b VARCHAR(100) NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'POSTPONED')),
    winning_option VARCHAR(100) DEFAULT NULL, -- Populated as Option A, Option B, or PUSH
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. User Picks Table
CREATE TABLE user_picks (
    pick_id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(user_id) ON DELETE CASCADE,
    matchup_id INT REFERENCES matchups(matchup_id) ON DELETE CASCADE,
    selected_option VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'LOCKED' CHECK (status IN ('LOCKED', 'WIN', 'LOSS', 'PUSH')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_matchups_start_time ON matchups(start_time);
CREATE INDEX idx_user_picks_user_id ON user_picks(user_id);
CREATE INDEX idx_user_picks_status ON user_picks(status);

-- Constraint: Ensures a user can only have ONE active locked pick at any given time
CREATE UNIQUE INDEX idx_one_active_pick_per_user 
ON user_picks(user_id) 
WHERE status = 'LOCKED';