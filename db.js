const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'pentapick.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      pin_hash TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 1000,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      winner TEXT,
      betting_ends_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id),
      match_id TEXT NOT NULL REFERENCES matches(id),
      choice TEXT NOT NULL,
      amount INTEGER NOT NULL,
      payout INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, match_id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Set default config
  const upsert = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  upsert.run('starting_points', '1000');
  upsert.run('round_bonus', '200');
}

// --- User functions ---

function createUser(id, username, pinHash) {
  const d = getDb();
  const startingPoints = parseInt(d.prepare('SELECT value FROM config WHERE key = ?').get('starting_points').value);
  d.prepare('INSERT INTO users (id, username, pin_hash, points) VALUES (?, ?, ?, ?)').run(id, username, pinHash, startingPoints);
  d.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(id, 'bonus', startingPoints, 'Starting points');
  return getUser(id);
}

function getUser(id) {
  return getDb().prepare('SELECT id, username, points, created_at FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserPoints(id) {
  const row = getDb().prepare('SELECT points FROM users WHERE id = ?').get(id);
  return row ? row.points : null;
}

// --- Match functions ---

function createMatch(id, title, optionA, optionB) {
  getDb().prepare('INSERT INTO matches (id, title, option_a, option_b, status) VALUES (?, ?, ?, ?, ?)').run(id, title, optionA, optionB, 'pending');
  return getMatch(id);
}

function getMatch(id) {
  return getDb().prepare('SELECT * FROM matches WHERE id = ?').get(id);
}

function getActiveMatches() {
  return getDb().prepare("SELECT * FROM matches WHERE status IN ('open', 'locked') ORDER BY created_at DESC").all();
}

function getAllMatches() {
  return getDb().prepare('SELECT * FROM matches ORDER BY created_at DESC').all();
}

function openBetting(matchId, endsAt) {
  getDb().prepare("UPDATE matches SET status = 'open', betting_ends_at = ? WHERE id = ?").run(endsAt, matchId);
}

function lockBetting(matchId) {
  getDb().prepare("UPDATE matches SET status = 'locked' WHERE id = ?").run(matchId);
}

function resolveMatch(matchId, winner) {
  const d = getDb();
  const match = d.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) throw new Error('Match not found');

  const resolve = d.transaction(() => {
    d.prepare("UPDATE matches SET status = 'resolved', winner = ? WHERE id = ?").run(winner, matchId);

    const allBets = d.prepare('SELECT * FROM bets WHERE match_id = ?').all(matchId);
    const totalPool = allBets.reduce((s, b) => s + b.amount, 0);
    const winnerBets = allBets.filter(b => b.choice === winner);
    const winnerPool = winnerBets.reduce((s, b) => s + b.amount, 0);

    for (const bet of winnerBets) {
      // Payout = their share of the total pool proportional to their bet
      const payout = winnerPool > 0 ? Math.round((bet.amount / winnerPool) * totalPool) : 0;
      d.prepare('UPDATE bets SET payout = ? WHERE id = ?').run(payout, bet.id);
      d.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(payout, bet.user_id);
      d.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(
        bet.user_id, 'payout', payout, `Won bet on "${match.title}" (${winner})`
      );
    }

    // Mark losers
    const loserBets = allBets.filter(b => b.choice !== winner);
    for (const bet of loserBets) {
      d.prepare('UPDATE bets SET payout = 0 WHERE id = ?').run(bet.id);
    }

    return { totalPool, winnersCount: winnerBets.length, losersCount: loserBets.length };
  });

  return resolve();
}

function cancelMatch(matchId) {
  const d = getDb();
  const cancel = d.transaction(() => {
    const allBets = d.prepare('SELECT * FROM bets WHERE match_id = ?').all(matchId);
    for (const bet of allBets) {
      d.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(bet.amount, bet.user_id);
      d.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(
        bet.user_id, 'refund', bet.amount, 'Match cancelled - refund'
      );
    }
    d.prepare("UPDATE matches SET status = 'cancelled' WHERE id = ?").run(matchId);
  });
  cancel();
}

// --- Bet functions ---

function placeBet(userId, matchId, choice, amount) {
  const d = getDb();
  const place = d.transaction(() => {
    const match = d.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!match) throw new Error('Match not found');
    if (match.status !== 'open') throw new Error('Betting is not open for this match');
    if (match.betting_ends_at && new Date(match.betting_ends_at + 'Z') < new Date()) {
      d.prepare("UPDATE matches SET status = 'locked' WHERE id = ?").run(matchId);
      throw new Error('Betting time has expired');
    }
    if (choice !== 'a' && choice !== 'b') throw new Error('Invalid choice');

    const existing = d.prepare('SELECT * FROM bets WHERE user_id = ? AND match_id = ?').get(userId, matchId);
    if (existing) throw new Error('You already placed a bet on this match');

    const user = d.prepare('SELECT points FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('User not found');
    if (amount < 1) throw new Error('Minimum bet is 1 point');
    if (amount > user.points) throw new Error('Not enough points');

    d.prepare('INSERT INTO bets (user_id, match_id, choice, amount) VALUES (?, ?, ?, ?)').run(userId, matchId, choice, amount);
    d.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(amount, userId);
    d.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(
      userId, 'bet', -amount, `Bet on "${match.title}" (${choice === 'a' ? match.option_a : match.option_b})`
    );
  });
  place();
}

function getMatchBets(matchId) {
  return getDb().prepare('SELECT b.*, u.username FROM bets b JOIN users u ON b.user_id = u.id WHERE b.match_id = ? ORDER BY b.amount DESC').all(matchId);
}

function getMatchBetSummary(matchId) {
  const d = getDb();
  const totalA = d.prepare("SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM bets WHERE match_id = ? AND choice = 'a'").get(matchId);
  const totalB = d.prepare("SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM bets WHERE match_id = ? AND choice = 'b'").get(matchId);
  return { a: totalA, b: totalB };
}

function getUserBet(userId, matchId) {
  return getDb().prepare('SELECT * FROM bets WHERE user_id = ? AND match_id = ?').get(userId, matchId);
}

// --- Leaderboard ---

function getLeaderboard(limit = 50) {
  return getDb().prepare('SELECT id, username, points FROM users ORDER BY points DESC LIMIT ?').all(limit);
}

// --- Transactions ---

function getUserTransactions(userId, limit = 50) {
  return getDb().prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
}

// --- Admin: award points ---

function awardPointsToAll(amount, description) {
  const d = getDb();
  const award = d.transaction(() => {
    const users = d.prepare('SELECT id FROM users').all();
    for (const user of users) {
      d.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(amount, user.id);
      d.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(
        user.id, 'bonus', amount, description || 'Round bonus'
      );
    }
    return users.length;
  });
  return award();
}

// --- Config ---

function getConfig(key) {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = {
  getDb, createUser, getUser, getUserByUsername, getUserPoints,
  createMatch, getMatch, getActiveMatches, getAllMatches,
  openBetting, lockBetting, resolveMatch, cancelMatch,
  placeBet, getMatchBets, getMatchBetSummary, getUserBet,
  getLeaderboard, getUserTransactions, awardPointsToAll,
  getConfig, setConfig
};
