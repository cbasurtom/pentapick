// --- State ---
let currentUser = null;
let selectedChoices = {}; // matchId -> 'a' or 'b'
let pendingAmounts = {}; // matchId -> typed amount (preserved across re-renders)
let pollInterval = null;

// --- API helpers ---
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// --- Auth ---
async function checkSession() {
  try {
    const data = await api('/api/me');
    currentUser = data.user;
    showApp();
  } catch {
    showAuth();
  }
}

function showAuth() {
  document.getElementById('auth-screen').style.display = '';
  document.getElementById('app-screen').style.display = 'none';
  stopPolling();
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = '';
  updatePoints();
  loadMatches();
  startPolling();
}

function showError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

function showSignup() {
  document.getElementById('signup-form').style.display = '';
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('auth-error').classList.remove('show');
}

function showLogin() {
  document.getElementById('signup-form').style.display = 'none';
  document.getElementById('login-form').style.display = '';
  document.getElementById('auth-error').classList.remove('show');
}

async function doSignup() {
  try {
    const username = document.getElementById('signup-username').value.trim();
    const pin = document.getElementById('signup-pin').value.trim();
    const data = await api('/api/signup', { method: 'POST', body: { username, pin } });
    currentUser = data.user;
    showApp();
  } catch (e) {
    showError(e.message);
  }
}

async function doLogin() {
  try {
    const username = document.getElementById('login-username').value.trim();
    const pin = document.getElementById('login-pin').value.trim();
    const data = await api('/api/login', { method: 'POST', body: { username, pin } });
    currentUser = data.user;
    showApp();
  } catch (e) {
    showError(e.message);
  }
}

async function doLogout() {
  await api('/api/logout', { method: 'POST' });
  currentUser = null;
  showAuth();
}

// --- Tabs ---
function switchTab(tab, btn) {
  document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-matches').style.display = tab === 'matches' ? '' : 'none';
  document.getElementById('tab-leaderboard').style.display = tab === 'leaderboard' ? '' : 'none';
  document.getElementById('tab-history').style.display = tab === 'history' ? '' : 'none';

  if (tab === 'matches') loadMatches();
  if (tab === 'leaderboard') loadLeaderboard();
  if (tab === 'history') loadHistory();
}

// --- Points ---
function updatePoints() {
  if (currentUser) {
    document.getElementById('my-points').textContent = currentUser.points.toLocaleString() + ' pts';
  }
}

async function refreshUser() {
  try {
    const data = await api('/api/me');
    currentUser = data.user;
    updatePoints();
  } catch {}
}

// --- Matches ---
function isUserTyping() {
  const active = document.activeElement;
  return active && active.tagName === 'INPUT' && active.id && active.id.startsWith('amount-');
}

function saveInputState() {
  document.querySelectorAll('[id^="amount-"]').forEach(el => {
    const matchId = el.id.replace('amount-', '');
    if (el.value) pendingAmounts[matchId] = el.value;
  });
}

function restoreInputState() {
  for (const [matchId, val] of Object.entries(pendingAmounts)) {
    const el = document.getElementById(`amount-${matchId}`);
    if (el) el.value = val;
  }
}

async function loadMatches(force) {
  // Don't re-render while user is typing a bet amount (unless forced)
  if (!force && isUserTyping()) return;

  try {
    const data = await api('/api/matches');
    const container = document.getElementById('tab-matches');

    if (data.matches.length === 0) {
      container.innerHTML = '<div class="empty">No active matches right now.<br>Check back soon!</div>';
      return;
    }

    // Save input values before re-render
    saveInputState();

    container.innerHTML = data.matches.map(m => renderMatch({ match: m, bets: m.bets, topBetsPerSide: m.topBetsPerSide, userBet: m.userBet })).join('');

    // Restore input values after re-render
    restoreInputState();
  } catch (e) {
    console.error('Load matches error:', e);
  }
}

function renderSideBettors(bettors, side, match) {
  const medals = ['#ffd700', '#c0c0c0', '#cd7f32'];
  const isResolved = match.status === 'resolved';
  if (bettors.length === 0) return '<div class="top-bettor-empty">No bets yet</div>';
  return bettors.map((b, i) => {
    let resultHtml = '';
    if (isResolved) {
      const won = b.choice === match.winner;
      if (won) {
        const net = b.payout - b.amount;
        resultHtml = `<div class="top-bettor-result won">+${net.toLocaleString()}</div>`;
      } else {
        resultHtml = `<div class="top-bettor-result lost">-${b.amount.toLocaleString()}</div>`;
      }
    }
    return `<div class="top-bettor-row">
      <span class="top-bettor-medal" style="color:${medals[i]};">#${i + 1}</span>
      <span class="top-bettor-name">${esc(b.username)}</span>
      <span class="top-bettor-amount">${b.amount.toLocaleString()}</span>
      ${resultHtml}
    </div>`;
  }).join('');
}

function renderMatch({ match, bets, topBetsPerSide, userBet }) {
  const totalPool = bets.a.total + bets.b.total;
  const pctA = totalPool > 0 ? Math.round((bets.a.total / totalPool) * 100) : 50;
  const pctB = 100 - pctA;
  const isOpen = match.status === 'open';
  const isLocked = match.status === 'locked';
  const isResolved = match.status === 'resolved';
  const hasBet = !!userBet;

  let timerHtml = '';
  if (isOpen && match.betting_ends_at) {
    const remaining = Math.max(0, Math.floor((new Date(match.betting_ends_at + 'Z') - Date.now()) / 1000));
    timerHtml = `<div class="timer ${remaining < 10 ? 'urgent' : ''}" id="timer-${match.id}">${formatTime(remaining)}</div>`;
  }

  let actionHtml = '';
  if (isOpen && !hasBet) {
    actionHtml = `
      <div class="bet-input-row">
        <input type="number" id="amount-${match.id}" placeholder="Bet amount" min="1" max="${currentUser.points}" inputmode="numeric">
        <button class="btn btn-primary" onclick="placeBet('${match.id}')">Bet</button>
      </div>
      <div class="quick-bets">
        <button onclick="setAmount('${match.id}', ${Math.floor(currentUser.points * 0.1)})">10%</button>
        <button onclick="setAmount('${match.id}', ${Math.floor(currentUser.points * 0.25)})">25%</button>
        <button onclick="setAmount('${match.id}', ${Math.floor(currentUser.points * 0.5)})">50%</button>
        <button onclick="setAmount('${match.id}', ${currentUser.points})">ALL IN</button>
      </div>`;
  } else if (hasBet && !isResolved) {
    const choiceName = userBet.choice === 'a' ? match.option_a : match.option_b;
    actionHtml = `<div class="bet-placed">You bet <strong>${userBet.amount.toLocaleString()}</strong> on <strong>${esc(choiceName)}</strong></div>`;
  } else if (isResolved && hasBet) {
    const won = userBet.choice === match.winner;
    actionHtml = `<div class="match-result ${won ? 'won' : 'lost'}">
      ${won ? `You won ${userBet.payout.toLocaleString()} pts!` : `You lost ${userBet.amount.toLocaleString()} pts`}
    </div>`;
  } else if (isResolved) {
    const winnerName = match.winner === 'a' ? match.option_a : match.option_b;
    actionHtml = `<div class="match-result won">Winner: ${esc(winnerName)}</div>`;
  }

  const statusClass = match.status;

  // Top bettors per side (Twitch-style)
  let topBettorsHtml = '';
  if (topBetsPerSide && (topBetsPerSide.a.length > 0 || topBetsPerSide.b.length > 0)) {
    topBettorsHtml = `
      <div class="top-bettors-vs">
        <div class="top-bettors-side side-a">
          <div class="top-bettors-side-header">${esc(match.option_a)}</div>
          ${renderSideBettors(topBetsPerSide.a, 'a', match)}
        </div>
        <div class="top-bettors-divider">VS</div>
        <div class="top-bettors-side side-b">
          <div class="top-bettors-side-header">${esc(match.option_b)}</div>
          ${renderSideBettors(topBetsPerSide.b, 'b', match)}
        </div>
      </div>`;
  }

  return `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <div class="card-title">${esc(match.title)}</div>
        <span class="status status-${statusClass}">${isOpen ? 'Betting Open' : isLocked ? 'Locked' : isResolved ? 'Finished' : 'Pending'}</span>
      </div>
      ${timerHtml}
      <div class="bet-options">
        <div class="bet-option option-a ${(selectedChoices[match.id] === 'a' || (hasBet && userBet.choice === 'a')) ? 'selected' : ''} ${isResolved && match.winner === 'a' ? 'winner' : ''}"
             ${isOpen && !hasBet ? `onclick="selectChoice('${match.id}', 'a')"` : ''}>
          <div class="name">${esc(match.option_a)}</div>
          <div class="stats">${bets.a.total.toLocaleString()} pts &middot; ${bets.a.count} bets</div>
        </div>
        <div class="bet-option option-b ${(selectedChoices[match.id] === 'b' || (hasBet && userBet.choice === 'b')) ? 'selected' : ''} ${isResolved && match.winner === 'b' ? 'winner' : ''}"
             ${isOpen && !hasBet ? `onclick="selectChoice('${match.id}', 'b')"` : ''}>
          <div class="name">${esc(match.option_b)}</div>
          <div class="stats">${bets.b.total.toLocaleString()} pts &middot; ${bets.b.count} bets</div>
        </div>
      </div>
      <div class="bet-bar-row">
        <span class="bar-pct pct-a">${pctA}%</span>
        <div class="bet-bar">
          <div class="fill-a" style="width:${pctA}%"></div>
          <div class="fill-b" style="width:${pctB}%"></div>
        </div>
        <span class="bar-pct pct-b">${pctB}%</span>
      </div>
      ${topBettorsHtml}
      ${actionHtml}
    </div>`;
}

function selectChoice(matchId, choice) {
  // Save the current input value before any re-render
  const input = document.getElementById(`amount-${matchId}`);
  if (input && input.value) pendingAmounts[matchId] = input.value;

  selectedChoices[matchId] = choice;

  // Update selection visually without full re-render
  const card = input ? input.closest('.card') : null;
  if (card) {
    card.querySelectorAll('.bet-option').forEach(el => el.classList.remove('selected'));
    const options = card.querySelectorAll('.bet-option');
    if (choice === 'a' && options[0]) options[0].classList.add('selected');
    if (choice === 'b' && options[1]) options[1].classList.add('selected');
  } else {
    // Fallback: full re-render if we can't find the card
    loadMatches(true);
  }
}

function setAmount(matchId, amount) {
  const input = document.getElementById(`amount-${matchId}`);
  if (input) input.value = Math.max(1, amount);
}

async function placeBet(matchId) {
  const choice = selectedChoices[matchId];
  if (!choice) { alert('Select a side first!'); return; }
  const input = document.getElementById(`amount-${matchId}`);
  const amount = parseInt(input.value);
  if (!amount || amount < 1) { alert('Enter a valid amount'); return; }

  try {
    const data = await api(`/api/matches/${matchId}/bet`, {
      method: 'POST',
      body: { choice, amount }
    });
    currentUser.points = data.points;
    updatePoints();
    delete selectedChoices[matchId];
    delete pendingAmounts[matchId];
    loadMatches(true);
  } catch (e) {
    alert(e.message);
  }
}

// --- Leaderboard ---
async function loadLeaderboard() {
  try {
    const data = await api('/api/leaderboard');
    const container = document.getElementById('tab-leaderboard');

    if (data.leaderboard.length === 0) {
      container.innerHTML = '<div class="empty">No users yet</div>';
      return;
    }

    container.innerHTML = `<div class="card" style="padding:0; overflow:hidden;">
      ${data.leaderboard.map((u, i) => `
        <div class="lb-row ${u.id === currentUser.id ? 'style="background:rgba(124,58,237,0.1)"' : ''}">
          <div class="lb-rank ${i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : ''}">#${i + 1}</div>
          <div class="lb-name">${esc(u.username)}${u.id === currentUser.id ? ' (you)' : ''}</div>
          <div class="lb-points">${u.points.toLocaleString()}</div>
        </div>
      `).join('')}
    </div>`;
  } catch (e) {
    console.error('Leaderboard error:', e);
  }
}

// --- History ---
async function loadHistory() {
  try {
    const data = await api('/api/history');
    const container = document.getElementById('tab-history');

    let html = '';

    // Match results section
    if (data.betHistory && data.betHistory.length > 0) {
      html += `<div class="history-section-title">Match Results</div>`;
      html += data.betHistory.map(b => {
        const won = b.choice === b.winner;
        const choiceName = b.choice === 'a' ? b.option_a : b.option_b;
        const winnerName = b.winner === 'a' ? b.option_a : b.option_b;
        const net = won ? b.payout - b.amount : -b.amount;
        const tps = b.topBetsPerSide;
        const hasTop = tps && (tps.a.length > 0 || tps.b.length > 0);

        return `<div class="card history-match-card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <div class="card-title" style="font-size:0.9rem;">${esc(b.title)}</div>
            <span class="tx-amount ${won ? 'positive' : 'negative'}" style="font-size:0.95rem;">
              ${won ? '+' : ''}${net.toLocaleString()} pts
            </span>
          </div>
          <div style="font-size:0.8rem; color:var(--text2); margin-bottom:8px;">
            You bet <strong>${b.amount.toLocaleString()}</strong> on <strong>${esc(choiceName)}</strong>
            &middot; Winner: <strong>${esc(winnerName)}</strong>
          </div>
          ${hasTop ? `<div class="top-bettors-vs compact">
            <div class="top-bettors-side side-a">
              <div class="top-bettors-side-header">${esc(b.option_a)}</div>
              ${renderSideBettorsCompact(tps.a, 'a', b)}
            </div>
            <div class="top-bettors-divider">VS</div>
            <div class="top-bettors-side side-b">
              <div class="top-bettors-side-header">${esc(b.option_b)}</div>
              ${renderSideBettorsCompact(tps.b, 'b', b)}
            </div>
          </div>` : ''}
        </div>`;
      }).join('');
    }

    // Transaction log
    if (data.transactions.length > 0) {
      html += `<div class="history-section-title">Transaction Log</div>`;
      html += `<div class="card" style="padding:8px 12px;">
        ${data.transactions.map(tx => `
          <div class="tx-row">
            <div>
              <div class="tx-desc">${esc(tx.description)}</div>
              <div class="tx-time">${new Date(tx.created_at + 'Z').toLocaleTimeString()}</div>
            </div>
            <div class="tx-amount ${tx.amount >= 0 ? 'positive' : 'negative'}">
              ${tx.amount >= 0 ? '+' : ''}${tx.amount.toLocaleString()}
            </div>
          </div>
        `).join('')}
      </div>`;
    }

    if (!html) html = '<div class="empty">No history yet</div>';
    container.innerHTML = html;
  } catch (e) {
    console.error('History error:', e);
  }
}

function renderSideBettorsCompact(bettors, side, matchData) {
  const medals = ['#ffd700', '#c0c0c0', '#cd7f32'];
  if (bettors.length === 0) return '<div class="top-bettor-empty">-</div>';
  return bettors.map((b, i) => {
    const won = b.choice === matchData.winner;
    let resultHtml = '';
    if (won) {
      const net = b.payout - b.amount;
      resultHtml = `<div class="top-bettor-result won">+${net.toLocaleString()}</div>`;
    } else {
      resultHtml = `<div class="top-bettor-result lost">-${b.amount.toLocaleString()}</div>`;
    }
    return `<div class="top-bettor-row">
      <span class="top-bettor-medal" style="color:${medals[i]};">#${i + 1}</span>
      <span class="top-bettor-name">${esc(b.username)}</span>
      <span class="top-bettor-amount">${b.amount.toLocaleString()}</span>
      ${resultHtml}
    </div>`;
  }).join('');
}

// --- Timers ---
function updateTimers() {
  document.querySelectorAll('[id^="timer-"]').forEach(el => {
    const matchId = el.id.replace('timer-', '');
    const text = el.textContent;
    const parts = text.split(':');
    let total = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    total = Math.max(0, total - 1);
    el.textContent = formatTime(total);
    if (total < 10) el.classList.add('urgent');
    if (total === 0 && !el.dataset.expired) {
      el.dataset.expired = '1';
      loadMatches(true);
    }
  });
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- Polling ---
function startPolling() {
  stopPolling();
  pollInterval = setInterval(() => {
    const matchesTab = document.getElementById('tab-matches');
    if (matchesTab.style.display !== 'none') {
      loadMatches();
      refreshUser();
    }
  }, 5000);
  setInterval(updateTimers, 1000);
}

function stopPolling() {
  if (pollInterval) clearInterval(pollInterval);
}

// --- Helpers ---
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// --- Init ---
checkSession();
