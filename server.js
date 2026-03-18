const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const path = require('path');
const os = require('os');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || uuidv4();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth middleware ---
function requireUser(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// === AUTH ROUTES ===

app.post('/api/signup', (req, res) => {
  try {
    const { username, pin } = req.body;
    if (!username || !pin) return res.status(400).json({ error: 'Username and PIN are required' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Username must be 2-20 characters' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });

    const existing = db.getUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const id = uuidv4();
    const pinHash = bcrypt.hashSync(pin, 10);
    const user = db.createUser(id, username, pinHash);

    req.session.userId = id;
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, pin } = req.body;
    if (!username || !pin) return res.status(400).json({ error: 'Username and PIN are required' });

    const user = db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid username or PIN' });
    if (!bcrypt.compareSync(pin, user.pin_hash)) return res.status(401).json({ error: 'Invalid username or PIN' });

    req.session.userId = user.id;
    res.json({ user: { id: user.id, username: user.username, points: user.points } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => {
  const user = db.getUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ user });
});

// === USER ROUTES ===

app.get('/api/matches', (req, res) => {
  const matches = db.getActiveMatches();
  const result = matches.map(m => {
    const summary = db.getMatchBetSummary(m.id);
    const topBets = db.getMatchBets(m.id).slice(0, 3);
    return { ...m, bets: summary, topBets };
  });
  res.json({ matches: result });
});

app.get('/api/matches/:id', (req, res) => {
  const match = db.getMatch(req.params.id);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  const summary = db.getMatchBetSummary(match.id);
  const topBets = db.getMatchBets(match.id).slice(0, 10);
  let userBet = null;
  if (req.session.userId) {
    userBet = db.getUserBet(req.session.userId, match.id);
  }
  res.json({ match, bets: summary, topBets, userBet });
});

app.post('/api/matches/:id/bet', requireUser, (req, res) => {
  try {
    const { choice, amount } = req.body;
    const amt = parseInt(amount);
    if (!choice || isNaN(amt) || amt < 1) return res.status(400).json({ error: 'Invalid bet' });
    db.placeBet(req.session.userId, req.params.id, choice, amt);
    const user = db.getUser(req.session.userId);
    res.json({ ok: true, points: user.points });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/leaderboard', (req, res) => {
  res.json({ leaderboard: db.getLeaderboard() });
});

app.get('/api/history', requireUser, (req, res) => {
  res.json({ transactions: db.getUserTransactions(req.session.userId) });
});

// === ADMIN ROUTES ===

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid admin password' });
  }
});

app.get('/api/admin/matches', requireAdmin, (req, res) => {
  const matches = db.getAllMatches();
  const result = matches.map(m => {
    const summary = db.getMatchBetSummary(m.id);
    return { ...m, bets: summary };
  });
  res.json({ matches: result });
});

app.post('/api/admin/matches', requireAdmin, (req, res) => {
  try {
    const { title, optionA, optionB } = req.body;
    if (!title || !optionA || !optionB) return res.status(400).json({ error: 'All fields required' });
    const id = uuidv4();
    const match = db.createMatch(id, title, optionA, optionB);
    res.json({ match });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/matches/:id/open', requireAdmin, (req, res) => {
  try {
    const { duration } = req.body; // duration in seconds
    const endsAt = duration ? new Date(Date.now() + duration * 1000).toISOString().replace('Z', '').split('.')[0] : null;
    db.openBetting(req.params.id, endsAt);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/matches/:id/lock', requireAdmin, (req, res) => {
  try {
    db.lockBetting(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/matches/:id/resolve', requireAdmin, (req, res) => {
  try {
    const { winner } = req.body;
    if (winner !== 'a' && winner !== 'b') return res.status(400).json({ error: 'Winner must be a or b' });
    const result = db.resolveMatch(req.params.id, winner);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/matches/:id/cancel', requireAdmin, (req, res) => {
  try {
    db.cancelMatch(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/award', requireAdmin, (req, res) => {
  try {
    const { amount, description } = req.body;
    const amt = parseInt(amount);
    if (isNaN(amt) || amt < 1) return res.status(400).json({ error: 'Invalid amount' });
    const count = db.awardPointsToAll(amt, description);
    res.json({ ok: true, usersAwarded: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({
    starting_points: db.getConfig('starting_points'),
    round_bonus: db.getConfig('round_bonus')
  });
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { starting_points, round_bonus } = req.body;
  if (starting_points) db.setConfig('starting_points', starting_points);
  if (round_bonus) db.setConfig('round_bonus', round_bonus);
  res.json({ ok: true });
});

app.get('/api/admin/leaderboard', requireAdmin, (req, res) => {
  res.json({ leaderboard: db.getLeaderboard(100) });
});

// === QR CODE ===

app.get('/api/qr', async (req, res) => {
  try {
    const localIp = getLocalIp();
    const url = `http://${localIp}:${PORT}`;
    const qr = await QRCode.toDataURL(url, { width: 400, margin: 2 });
    res.json({ qr, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === PAGE ROUTES ===

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

// SPA fallback
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === HELPERS ===

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// === START ===

app.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log(`
╔══════════════════════════════════════════╗
║          PentaPick is running!           ║
╠══════════════════════════════════════════╣
║                                         ║
║  Local:   http://localhost:${PORT}        ║
║  Network: http://${localIp}:${PORT}   ║
║                                         ║
║  Admin:   http://localhost:${PORT}/admin  ║
║  Display: http://localhost:${PORT}/display║
║                                         ║
║  Admin password: ${ADMIN_PASSWORD}              ║
║                                         ║
╚══════════════════════════════════════════╝
  `);
});
