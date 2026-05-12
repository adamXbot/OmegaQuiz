// Stress / soak test for omegaquiz.
//
// Spawns the server (or connects to a running one), drives admin + host
// actions, and simulates a configurable number of player phones playing the
// game from lobby → Q1 → … → end. Each player has a "personality" that
// determines how often they answer correctly, change their mind, or skip a
// round, so we exercise the full elimination flow, bonus rounds, and the
// change-tracking counters.
//
//   USAGE:
//     node test/stress.js                       # 50 players, spawns its own server
//     N_PLAYERS=20 node test/stress.js          # 20 players
//     SERVER_URL=http://localhost:3000 \        # use an already-running server
//     HOST_TOKEN=ht ADMIN_TOKEN=at \
//     node test/stress.js
//
// Exit code: 0 on success, 1 if the game didn't reach 'end' or any client errored.

const http      = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path      = require('path');
const crypto    = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const N_PLAYERS   = parseInt(process.env.N_PLAYERS || '50', 10);
const SERVER_URL  = process.env.SERVER_URL || null;
const SPAWN_SERVER = !SERVER_URL;
const PORT        = parseInt(process.env.PORT || (SPAWN_SERVER ? '13700' : '3000'), 10);
const BASE_URL    = SERVER_URL || `http://localhost:${PORT}`;
const HOST_TOKEN  = process.env.HOST_TOKEN  || 'stress-host-' + crypto.randomBytes(8).toString('hex');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'stress-admin-' + crypto.randomBytes(8).toString('hex');
const ANSWER_MIN_MS = parseInt(process.env.ANSWER_MIN_MS || '200', 10);
const ANSWER_MAX_MS = parseInt(process.env.ANSWER_MAX_MS || '2200', 10);

// Personality mix — distribution of player types. Tuned so the field narrows
// realistically to a small number of survivors by Q10 (with bonus rounds).
const PERSONALITIES = [
  { label: 'expert',  weight: 30, correctRate: 0.95, changeRate: 0.05, skipRate: 0.00 },
  { label: 'skilled', weight: 35, correctRate: 0.75, changeRate: 0.15, skipRate: 0.00 },
  { label: 'lucky',   weight: 25, correctRate: 0.50, changeRate: 0.25, skipRate: 0.02 },
  { label: 'novice',  weight:  7, correctRate: 0.30, changeRate: 0.30, skipRate: 0.05 },
  { label: 'absent',  weight:  3, correctRate: 0.00, changeRate: 0.00, skipRate: 1.00 },
];
function pickPersonality() {
  const total = PERSONALITIES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of PERSONALITIES) { if ((r -= p.weight) <= 0) return p; }
  return PERSONALITIES[0];
}

// ---------------------------------------------------------------------------
// Pretty output
// ---------------------------------------------------------------------------
const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m', cyan:'\x1b[36m'
};
function log(tag, msg)    { console.log(`${C.dim}[${new Date().toISOString().slice(11, 23)}]${C.reset} ${C.cyan}[${tag}]${C.reset} ${msg}`); }
function ok(msg)          { console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function fail(msg)        { console.log(`  ${C.red}✗${C.reset} ${msg}`); }
function section(name)    { console.log(`\n${C.bold}${name}${C.reset}`); }

const failures = [];
function record(cond, msg, detail) {
  if (cond) { ok(msg); return true; }
  failures.push({ msg, detail });
  fail(msg + (detail ? '  ' + C.dim + detail + C.reset : ''));
  return false;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
let serverProc = null;
function bootServer() {
  return new Promise((resolve, reject) => {
    log('boot', `spawning node server.js on :${PORT}`);
    const env = {
      ...process.env,
      PORT: String(PORT),
      HOST_TOKEN, ADMIN_TOKEN,
      COOKIE_SECRET: crypto.randomBytes(16).toString('hex'),
      DATA_DIR: path.join(__dirname, '..', '.stress-data'),
    };
    serverProc = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onLine = chunk => {
      buf += chunk.toString();
      if (buf.includes('Omega Quiz running')) resolve();
    };
    serverProc.stdout.on('data', onLine);
    serverProc.stderr.on('data', d => process.stderr.write(d));
    setTimeout(() => reject(new Error('server boot timeout')), 5000);
  });
}
function killServer() {
  if (serverProc && !serverProc.killed) { try { serverProc.kill('SIGTERM'); } catch {} }
}

// ---------------------------------------------------------------------------
// HTTP / WS helpers
// ---------------------------------------------------------------------------
function httpRequest(method, urlPath, { headers = {}, body = null } = {}) {
  const u = new URL(BASE_URL + urlPath);
  return new Promise((resolve, reject) => {
    const opts = { hostname: u.hostname, port: u.port, method, path: u.pathname + u.search, headers: { ...headers } };
    if (body != null) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), setCookie: res.headers['set-cookie'] || [] }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function loginAs(role, token) {
  const r = await httpRequest('POST', '/auth/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `role=${role}&token=${encodeURIComponent(token)}`,
  });
  const cookie = (r.setCookie || []).map(s => s.split(';')[0]).find(s => s.startsWith('omegaquiz_sess='));
  if (!cookie) throw new Error(`login as ${role} failed (status ${r.status})`);
  return cookie;
}

function openWs(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE_URL.replace(/^http/, 'ws'), { headers: cookie ? { Cookie: cookie } : {} });
    ws.once('open',  () => resolve(ws));
    ws.once('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Admin / host driver
// ---------------------------------------------------------------------------
async function newAdmin() {
  const cookie = await loginAs('admin', ADMIN_TOKEN);
  const ws = await openWs(cookie);
  const admin = {
    ws,
    latestState: null,
    sentinel: null,
  };
  // Cumulative message handler — keep the most recent admin:state available.
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'admin:state') admin.latestState = m.state;
    if (m.type === 'error')       log('admin', `${C.red}server error: ${m.error}${C.reset}`);
  });
  ws.send(JSON.stringify({ type: 'admin:hello' }));
  // Wait for admin:init to confirm we're authenticated.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('admin:init timeout')), 3000);
    ws.on('message', function onInit(raw) {
      try {
        const m = JSON.parse(raw);
        if (m.type === 'admin:init') { clearTimeout(t); ws.off('message', onInit); resolve(); }
      } catch {}
    });
  });
  admin.act = function(action, payload = {}) {
    ws.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: action, hostPayload: payload } }));
  };
  admin.adminAction = function(action, payload = {}) {
    ws.send(JSON.stringify({ type: 'admin:action', action, payload }));
  };
  admin.waitFor = function(pred, timeout = 10000) {
    const start = Date.now();
    return (async function spin() {
      while (Date.now() - start < timeout) {
        if (admin.latestState && pred(admin.latestState)) return admin.latestState;
        await new Promise(r => setTimeout(r, 40));
      }
      throw new Error('admin.waitFor timed out; last phase=' + (admin.latestState && admin.latestState.phase));
    })();
  };
  return admin;
}

// ---------------------------------------------------------------------------
// StressPlayer — simulates one phone
// ---------------------------------------------------------------------------
class StressPlayer {
  constructor(idx) {
    this.idx = idx;
    this.name = `Stress_${String(idx).padStart(3, '0')}`;
    this.email = `stress${idx}@stress.example`;
    this.personality = pickPersonality();
    this.ws = null;
    this.latestState = null;
    this.errors = [];
    this.joined = false;
    this.lastAnsweredQ = -1;
  }
  async connect(joinCode) {
    this.ws = await openWs();  // no cookie — anonymous player
    this.ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'player:joined') { this.joined = true; this.playerId = m.playerId; }
      else if (m.type === 'player:state') { this.latestState = m.state; }
      else if (m.type === 'error') { this.errors.push(m.error); }
      else if (m.type === 'kicked') { this.errors.push('kicked: ' + (m.reason || '')); }
    });
    this.ws.on('error', e => this.errors.push('ws error: ' + e.message));
    this.ws.send(JSON.stringify({ type: 'player:join', name: this.name, email: this.email, joinCode }));
    // Wait briefly for player:joined.
    const deadline = Date.now() + 4000;
    while (!this.joined && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    if (!this.joined) {
      const reason = this.errors[0] || 'no response from server';
      throw new Error(`player ${this.idx} (${this.personality.label}) failed to join: ${reason}`);
    }
    return this;
  }
  // Pick an option for the current question based on personality.
  pickFor(correctIdx) {
    if (Math.random() < this.personality.skipRate) return null;     // skip → eliminated
    if (Math.random() < this.personality.correctRate) return correctIdx;
    // wrong: pick a random non-correct option
    const wrongs = [0,1,2,3].filter(i => i !== correctIdx);
    return wrongs[Math.floor(Math.random() * wrongs.length)];
  }
  async actOn(questionIndex, correctIdx, eliminatedOptions = []) {
    if (questionIndex === this.lastAnsweredQ) return;
    this.lastAnsweredQ = questionIndex;
    const personality = this.personality;
    // Random delay (skewed to early-mid window so we don't all hit at once).
    const delay = ANSWER_MIN_MS + Math.random() * (ANSWER_MAX_MS - ANSWER_MIN_MS);
    await new Promise(r => setTimeout(r, delay));
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (Math.random() < personality.skipRate) return;
    let pick = this.pickFor(correctIdx);
    if (pick == null || eliminatedOptions.includes(pick)) {
      // 50:50 removed our pick — choose any remaining non-eliminated option.
      const available = [0,1,2,3].filter(i => !eliminatedOptions.includes(i));
      pick = available[Math.floor(Math.random() * available.length)];
    }
    this.ws.send(JSON.stringify({ type: 'player:answer', answerIndex: pick }));
    // Optional "change my mind" — quick mode only; server tracks the flip.
    if (Math.random() < personality.changeRate) {
      await new Promise(r => setTimeout(r, 150 + Math.random() * 500));
      if (this.ws.readyState !== WebSocket.OPEN) return;
      const available = [0,1,2,3].filter(i => i !== pick && !eliminatedOptions.includes(i));
      if (available.length > 0) {
        const newPick = available[Math.floor(Math.random() * available.length)];
        this.ws.send(JSON.stringify({ type: 'player:answer', answerIndex: newPick }));
      }
    }
  }
  close() { try { this.ws && this.ws.close(); } catch {} }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  section(`OmegaQuiz stress test  ·  ${N_PLAYERS} players  ·  ${BASE_URL}`);
  log('boot', `personalities: ${PERSONALITIES.map(p => `${p.label}×${p.weight}%`).join(', ')}`);

  if (SPAWN_SERVER) await bootServer();
  else              log('boot', `connecting to running server at ${BASE_URL}`);

  const admin = await newAdmin();
  log('admin', 'signed in, admin WS open');

  // Make sure questions exist.
  admin.adminAction('questions:reset-defaults');
  await new Promise(r => setTimeout(r, 300));
  // Reset the game so we get a fresh lobby + joinCode. Clear latestState first
  // so waitFor blocks until the post-reset push arrives (not a stale admin:hello
  // push that still has the old joinCode).
  admin.latestState = null;
  admin.act('reset-game');
  const lobby = await admin.waitFor(s => s.phase === 'lobby' && typeof s.joinCode === 'string');
  record(lobby.totalQuestions > 0, `questions loaded (${lobby.totalQuestions} main, ${lobby.totalBonus} bonus)`);
  const joinCode = lobby.joinCode;
  log('setup', `joinCode=${joinCode}`);

  // Spawn players in parallel.
  log('join', `connecting ${N_PLAYERS} players…`);
  const t0 = Date.now();
  const players = await Promise.all(
    Array.from({ length: N_PLAYERS }, (_, i) => new StressPlayer(i + 1).connect(joinCode))
  );
  const joinMs = Date.now() - t0;
  record(players.length === N_PLAYERS, `${players.length}/${N_PLAYERS} joined in ${joinMs}ms`);

  // Personality breakdown.
  const tally = {};
  players.forEach(p => { tally[p.personality.label] = (tally[p.personality.label] || 0) + 1; });
  log('join', 'personalities: ' + Object.entries(tally).map(([k,v]) => `${k}=${v}`).join(', '));

  // Wait until admin sees them all (eventual consistency from broadcast).
  await admin.waitFor(s => s.playerCount >= N_PLAYERS);

  // Start the game.
  admin.act('start-game');
  let state = await admin.waitFor(s => s.phase === 'question' && s.questionIndex === 0);
  log('start', `game started, alive=${state.aliveCount}`);

  section('Game flow');

  // Loop until phase='end'. Each iteration handles one question.
  let round = 0;
  let totalAnswerEvents = 0;
  let totalChangeEvents = 0;

  while (true) {
    state = admin.latestState;
    if (state.phase === 'end') break;
    if (state.phase !== 'question') {
      // E.g. reveal phase if next-question hasn't been pressed yet.
      admin.act('next-question');
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    round++;
    const qLabel = state.inBonus ? `B${state.bonusIndex + 1}` : `Q${state.questionIndex + 1}`;
    const q = state.currentQuestionRef;
    const correctIdx = q.correct;
    const aliveBefore = state.aliveCount;

    // Every player who's alive (or eliminated, if branding allows) picks
    // independently. Eliminated players' picks are dropped by the server (toggle off).
    // Use a unique key per (main vs bonus, index) pair — questionIndex stays
    // at the last main index during the bonus round, so we'd otherwise treat
    // B1, B2, B3… all as "already answered".
    const actionKey = state.inBonus ? (1000 + state.bonusIndex) : state.questionIndex;
    const tStart = Date.now();
    await Promise.all(players.map(p => p.actOn(actionKey, correctIdx, state.eliminatedOptions)));

    // Wait until ≥95% of alive players have answered (or 4 s, whichever first).
    await admin.waitFor(s => {
      const t = s.liveAnswerTally;
      return t && (t.answeredAlive >= Math.floor(t.aliveTotal * 0.95));
    }, 4500).catch(() => {});

    const preCloseTally = admin.latestState.liveAnswerTally || {};
    const answeredAlive = preCloseTally.answeredAlive || 0;
    const aliveTotal    = preCloseTally.aliveTotal   || aliveBefore;
    const changeEvents  = preCloseTally.changeEvents || 0;
    totalAnswerEvents  += answeredAlive;
    totalChangeEvents  += changeEvents;

    admin.act('close-question');
    state = await admin.waitFor(s => s.phase === 'reveal');
    const aliveAfter = state.aliveCount;
    const elapsedMs = Date.now() - tStart;

    const dist = (preCloseTally.counts || []).map((n, i) =>
      `${'ABCD'[i]}${i === correctIdx ? '*' : ''}=${n}`
    ).join(' ');

    log(qLabel, `${C.bold}${answeredAlive}/${aliveTotal}${C.reset} answered  ·  [${dist}]  ·  changes=${changeEvents}  ·  alive ${aliveBefore}→${aliveAfter}  ·  ${elapsedMs}ms`);

    // Move on.
    admin.act('next-question');
    // Wait for next phase.
    await admin.waitFor(s => s.phase !== 'reveal');
    if (round > 30) {  // safety
      record(false, 'stuck loop (>30 rounds)', `last phase=${admin.latestState.phase}`);
      break;
    }
  }

  section('Outcome');
  const finalState = admin.latestState;
  record(finalState.phase === 'end', `game reached 'end' phase`, `was ${finalState.phase}`);
  const winners = finalState.players.filter(p => p.alive);
  if (winners.length === 1) {
    ok(`single winner: ${winners[0].name} (${winners[0].score} pts)`);
  } else if (winners.length > 1) {
    log('final', `${winners.length}-way finalist tie: ${winners.map(w => w.name).join(', ')}`);
  } else {
    log('final', 'no survivors!');
  }
  const ranked = [...finalState.players].sort((a,b) => b.score - a.score).slice(0, 5);
  log('top 5', ranked.map((p, i) => `#${i+1} ${p.name} (${p.score})`).join('  ·  '));

  // Per-player error tally.
  const playerErrors = players.filter(p => p.errors.length > 0);
  record(playerErrors.length === 0, `no per-player errors`, playerErrors.length ? `${playerErrors.length} players hit errors: ${playerErrors[0].errors[0]}…` : '');

  log('totals', `${totalAnswerEvents} answer events, ${totalChangeEvents} change events, ${round} rounds played`);

  // Shutdown
  players.forEach(p => p.close());
  try { admin.ws.close(); } catch {}

  section('Result');
  if (failures.length === 0) {
    console.log(`${C.green}${C.bold}✓ Stress test passed${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}✗ Stress test failed${C.reset}`);
    failures.forEach(f => console.log('  - ' + f.msg + (f.detail ? '  ' + f.detail : '')));
  }
  return failures.length;
}

(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error(`${C.red}Fatal:${C.reset}`, e && e.stack || e);
  } finally {
    killServer();
    setTimeout(() => process.exit(code === 0 ? 0 : 1), 200);
  }
})();
