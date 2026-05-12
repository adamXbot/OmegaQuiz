// OmegaQuiz Employee — live quiz server
// Express + WebSocket. Single in-memory game (one quiz at a time).

const path = require('path');
const fs = require('fs');

// ----------------------------------------------------------------------------
// .env loader (dependency-free).
// Loads ./.env (or $DOTENV_PATH) into process.env at startup. Existing env
// vars always win — actual environment > .env file > built-in defaults. This
// runs BEFORE any process.env read elsewhere in the file, so it must be at
// the top.
// ----------------------------------------------------------------------------
function loadDotenv(envPath) {
  envPath = envPath || process.env.DOTENV_PATH || path.join(__dirname, '.env');
  let text;
  try { text = fs.readFileSync(envPath, 'utf8'); }
  catch { return { loaded: false, path: envPath, count: 0 }; }
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // KEY=value, allow optional "export " prefix and trailing inline # comments.
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    // Strip surrounding single or double quotes.
    if (val.length >= 2 && ((val[0] === '"' && val[val.length-1] === '"') ||
                            (val[0] === "'" && val[val.length-1] === "'"))) {
      val = val.slice(1, -1);
    } else {
      // Strip inline comments only when unquoted (so URLs with #fragments stay intact when quoted).
      const hashAt = val.indexOf(' #');
      if (hashAt >= 0) val = val.slice(0, hashAt);
      val = val.trim();
    }
    // Process env wins — never clobber values the operator set explicitly.
    if (process.env[key] === undefined) {
      process.env[key] = val;
      count++;
    }
  }
  return { loaded: true, path: envPath, count };
}
const DOTENV_RESULT = loadDotenv();

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { QUESTIONS: DEFAULT_QUESTIONS, BONUS_QUESTIONS: DEFAULT_BONUS } = require('./questions');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
const server = http.createServer(app);
// Cap WS message size at 4 MiB. Question banks with per-question images can
// run several MB once images are inlined as data URIs; 4 MiB covers ~15
// questions at the per-image cap and leaves DoS surface small (admin-only).
const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

const PORT = process.env.PORT || 3000;

// --- Tokens / secrets (A01-4 / A02-3) ---
// Use CSPRNG for any auto-generated default. Refuse to start in prod without env vars.
function cryptoToken(prefix) {
  return prefix + '-' + crypto.randomBytes(24).toString('hex');
}
const HOST_TOKEN  = process.env.HOST_TOKEN  || cryptoToken('host');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || cryptoToken('admin');
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');
const TOKENS_AUTO_GENERATED = !process.env.HOST_TOKEN || !process.env.ADMIN_TOKEN;
if (process.env.NODE_ENV === 'production' && TOKENS_AUTO_GENERATED) {
  console.error('FATAL: HOST_TOKEN and ADMIN_TOKEN must be set in production.');
  process.exit(1);
}

// Behind Railway / a reverse proxy, trust X-Forwarded-* for protocol & IP.
app.set('trust proxy', 1);

// Where to fetch the catalogue of sample question packs from. By default this
// uses the bundled samples/manifest.json shipped with the app; set
// SAMPLE_PACKS_URL to a public https:// manifest if you want to publish your
// own catalogue.
const BUNDLED_SAMPLE_PREFIX = 'bundled:samples/';
const SAMPLE_PACKS_URL = process.env.SAMPLE_PACKS_URL
  || (BUNDLED_SAMPLE_PREFIX + 'manifest.json');
const SAMPLE_FETCH_TIMEOUT_MS = 8000;
const SAMPLE_MAX_BYTES = 1024 * 1024;          // 1 MB max payload

function loadBundledSampleJson(url) {
  if (typeof url !== 'string' || !url.startsWith(BUNDLED_SAMPLE_PREFIX)) {
    throw new Error('not a bundled sample URL');
  }
  const name = url.slice(BUNDLED_SAMPLE_PREFIX.length);
  if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) throw new Error('invalid bundled sample path');
  const full = path.join(__dirname, 'samples', name);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}
async function fetchSampleJson(url) {
  if (typeof url === 'string' && url.startsWith(BUNDLED_SAMPLE_PREFIX)) {
    return loadBundledSampleJson(url);
  }
  return fetchJsonSafe(url);
}

// Server-side fetch with safety rails. Used only by the sample-packs flow.
//
// Refusals:
//   - non-https scheme
//   - hostnames pointing at loopback / private IPv4 ranges (basic SSRF guard)
//   - HTTP responses > SAMPLE_MAX_BYTES
//   - responses that don't decode as JSON
//
// Note: admin role is required by the WS handler before this is ever called.
// Shared SSRF-safe fetcher. Returns { text, contentType, url } and enforces
// https-only, no private/loopback hosts, max-size + timeout. Both
// fetchJsonSafe (existing sample-pack path) and seedQuestionsFromUrl (the
// new -u CLI flag) build on this so the safety bar stays consistent.
async function fetchTextSafe(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'https:') throw new Error('only https:// URLs are allowed');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) {
    throw new Error('private/loopback hosts are not allowed');
  }
  // Block IPv4 literals in private/loopback ranges. Public IPv4 literals are
  // technically allowed but unusual for a sample-pack source.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) {
      throw new Error('loopback / link-local IPs are not allowed');
    }
    const parts = host.split('.').map(Number);
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
      throw new Error('private IPv4 range not allowed');
    }
  }
  // IPv6 [::1] and friends
  if (host.startsWith('[')) throw new Error('IPv6 literals not allowed in sample URLs');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SAMPLE_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { Accept: 'application/json, text/csv;q=0.95, text/plain;q=0.9' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + u.host);
    // Stream-limit the response.
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SAMPLE_MAX_BYTES) throw new Error('response exceeds ' + Math.floor(SAMPLE_MAX_BYTES / 1024) + ' KB');
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    return {
      text: buf.toString('utf8'),
      contentType: (r.headers.get('content-type') || '').toLowerCase(),
      url: u.href
    };
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonSafe(url) {
  const { text } = await fetchTextSafe(url);
  try { return JSON.parse(text); }
  catch { throw new Error('response was not valid JSON'); }
}

// Mutable in-memory copies of the questions (admin can edit).
//
// Empty-start policy: the server boots with no questions. An admin must
// import a CSV, paste JSON, manually add questions, or click "Load sample
// questions" before a game can begin. This keeps the tool generic — the
// included `questions.js` bank is now an opt-in sample, not a default.
//
// Persistence: once questions are loaded (any path), we write them to
// data/questions.json so they survive restarts. Path is configurable via
// DATA_DIR.
let questions = [];
let bonusQuestions = [];
const QUESTIONS_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'questions.json');
function loadQuestionsFromDisk() {
  try {
    const raw = fs.readFileSync(QUESTIONS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeQuestionBank(parsed, { label: 'saved question bank' });
  } catch (e) {
    // Missing or corrupt — fall back to the empty state. Admin can re-import.
    return { main: [], bonus: [] };
  }
}
function saveQuestionsToDisk() {
  try {
    const dir = path.dirname(QUESTIONS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUESTIONS_PATH, JSON.stringify({ main: questions, bonus: bonusQuestions }, null, 2), 'utf8');
  } catch (e) {
    logJson('warn', 'failed to persist questions', { error: e.message });
  }
}
{
  const loaded = loadQuestionsFromDisk();
  questions = loaded.main;
  bonusQuestions = loaded.bonus;
}

// ----------------------------------------------------------------------------
// Startup CLI args — `-u <URL>` / `--seed-url <URL>` seeds the question bank
// from a JSON or CSV at first run (when the bank is empty). The same value
// can also come from the QUESTIONS_SEED_URL env var.
//
// Example:
//   node server.js -u https://raw.githubusercontent.com/me/quiz/main/pack.json
//   QUESTIONS_SEED_URL=https://.../pack.csv node server.js
//
// Format detection: JSON if URL ends in .json OR Content-Type contains 'json';
// otherwise treated as CSV.
// ----------------------------------------------------------------------------
function parseStartupArgs(argv) {
  // Parse a small, focused subset — keeps the surface tiny and predictable.
  // We deliberately don't pull in a dep here.
  const out = { seedUrl: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-u' || a === '--seed-url' || a === '--url') {
      out.seedUrl = argv[i + 1] || '';
      i++;
    } else if (a.startsWith('--seed-url=') || a.startsWith('--url=')) {
      out.seedUrl = a.split('=').slice(1).join('=');
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    }
  }
  // Env var fallback (only when the flag isn't present).
  if (!out.seedUrl && process.env.QUESTIONS_SEED_URL) {
    out.seedUrl = process.env.QUESTIONS_SEED_URL.trim();
  }
  return out;
}

// Sniff the response shape and turn it into { main, bonus }. JSON wins if
// the body parses; otherwise we treat the body as CSV.
function parseSeedBody(text, contentType, urlStr) {
  const isJsonByCt   = /json/.test(contentType || '');
  const isJsonByExt  = /\.json($|\?)/i.test(urlStr || '');
  const tryJsonFirst = isJsonByCt || isJsonByExt;
  const tryJson = () => {
    const parsed = JSON.parse(text);
    const bank = normalizeQuestionBank(parsed, {
      label: 'seed JSON',
      requireMain: true,
      allowQuestionsAlias: true
    });
    return { ...bank, format: 'json' };
  };
  const tryCsv = () => {
    const bank = normalizeQuestionBank(questionsFromCsv(text), {
      label: 'seed CSV',
      requireMain: true
    });
    return { ...bank, format: 'csv' };
  };
  if (tryJsonFirst) {
    try { return tryJson(); } catch { /* fall through to CSV */ }
    return tryCsv();
  }
  try { return tryCsv(); } catch { /* fall through */ }
  return tryJson();
}

async function seedQuestionsFromUrl(url) {
  const { text, contentType, url: finalUrl } = await fetchTextSafe(url);
  const parsed = parseSeedBody(text, contentType, finalUrl);
  questions = parsed.main;
  bonusQuestions = parsed.bonus;
  saveQuestionsToDisk();
  return { mainCount: parsed.main.length, bonusCount: parsed.bonus.length, format: parsed.format };
}

// Structured operational logger (O5). Emits one JSON object per line so that
// PaaS log ingestion (Fly / Render / Railway) can index fields without regex
// scraping. The human-readable boot banner deliberately stays as plain
// console.log() — operators read it once at startup. Anything that fires
// during normal runtime (auth failures, rate-limit hits, crashes, shutdown)
// goes through logJson.
//
// Self-hosted Docker users who tail stdout still get a readable stream; JSON
// is easier to grep than free-form text.
// Disable when tests are running (keeps test output uncluttered) or when an
// operator explicitly opts out via LOG_DISABLE_JSON=1.
const LOG_DISABLE = String(process.env.LOG_DISABLE_JSON || '').toLowerCase() === '1'
  || process.env.NODE_ENV === 'test';
function logJson(level, msg, fields) {
  if (LOG_DISABLE) return;
  const entry = { ts: new Date().toISOString(), level, msg };
  if (fields && typeof fields === 'object') Object.assign(entry, fields);
  try {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } catch {
    // Last resort if stdout is closed (rare). Fall back so we don't crash
    // the logger itself.
    try { console.log(level + ': ' + msg); } catch {}
  }
}

// Event log for admin troubleshooting
const eventLog = [];
const MAX_LOG = 200;
function logEvent(type, msg, meta) {
  const e = { ts: Date.now(), type, msg, meta: meta || null };
  eventLog.unshift(e);
  if (eventLog.length > MAX_LOG) eventLog.pop();
  broadcast({ type: 'admin:event', event: e }, c => c.role === 'admin');
}

// --- Game state ---
function newGame() {
  return {
    phase: 'lobby',                 // lobby | question | reveal | bonus | end
    joinCode: String(crypto.randomInt(100000, 1000000)),
    questionIndex: 0,
    bonusIndex: 0,
    inBonus: false,
    players: new Map(),
    currentAnswers: new Map(),
    // Per-question change tracking — reset alongside currentAnswers.
    changesThisQuestion: 0,             // total change events
    playersChangedThisQuestion: new Set(), // distinct players who changed
    // Per-lifeline usage tracker. Each type can be used independently within
    // the same round (e.g. 50/50 then Ask IT on the same question), but once
    // a type is used it's gone unless the refill schedule tops it up.
    // The legacy `lifelineUsed` flag is now derived (all three used = no more lifelines).
    lifelinesUsed: { '5050': false, 'askit': false, 'skip': false },
    lifelineActive: null,
    eliminatedOptions: [],
    revealedCorrect: null,
    audienceTally: null
  };
}
let game = newGame();

const DEFAULT_PLAYER_RECONNECT_WINDOW_SECONDS = 300;
const MIN_PLAYER_RECONNECT_WINDOW_SECONDS = 30;
const MAX_PLAYER_RECONNECT_WINDOW_SECONDS = 900;
function parseReconnectWindowSeconds(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_PLAYER_RECONNECT_WINDOW_SECONDS;
  return Math.max(
    MIN_PLAYER_RECONNECT_WINDOW_SECONDS,
    Math.min(MAX_PLAYER_RECONNECT_WINDOW_SECONDS, Math.round(n))
  );
}
const PLAYER_RECONNECT_WINDOW_SECONDS = parseReconnectWindowSeconds(process.env.PLAYER_RECONNECT_WINDOW_SECONDS);
const PLAYER_RECONNECT_WINDOW_MS = PLAYER_RECONNECT_WINDOW_SECONDS * 1000;

function reconnectRemainingMs(player, now = Date.now()) {
  if (!player || !player.disconnectedAt) return 0;
  return Math.max(0, PLAYER_RECONNECT_WINDOW_MS - (now - player.disconnectedAt));
}
function isWithinReconnectWindow(player, now = Date.now()) {
  return reconnectRemainingMs(player, now) > 0;
}
function scheduleReconnectExpiryPush(playerId) {
  const timer = setTimeout(() => {
    const cur = game.players.get(playerId);
    if (!cur) return;
    if (cur.disconnectedAt && (Date.now() - cur.disconnectedAt) >= PLAYER_RECONNECT_WINDOW_MS && !cur.ws) {
      logEvent('disconnect-final', `${cur.name} reconnect window expired`, { playerId: cur.id });
    }
    pushAll();
  }, PLAYER_RECONNECT_WINDOW_MS + 500);
  timer.unref?.();
}

// Reset per-question answer state — answers and the change counters that
// track how many players altered their selection on the current question.
function resetCurrentAnswerState() {
  game.currentAnswers = new Map();
  game.changesThisQuestion = 0;
  game.playersChangedThisQuestion = new Set();
}

// Lifelines: per-type accounting. Each type ('5050' | 'askit' | 'skip') can be
// used independently within the same round. lifelinesAllUsed() returns true
// once every type is spent, which is what gates the "no more lifelines" UI.
function lifelinesAllUsed() {
  const u = game.lifelinesUsed || {};
  return !!(u['5050'] && u['askit'] && u['skip']);
}
// Refill helper: called from next-question / bonus-entry depending on the
// branding-configured schedule.
function refillLifelinesIfDue({ atBonus = false, eachQuestion = false } = {}) {
  const sched = (branding && branding.lifelineRefill) || 'never';
  let refill = false;
  if (sched === 'each-question' && eachQuestion) refill = true;
  else if (sched === 'at-bonus' && atBonus) refill = true;
  if (refill) {
    game.lifelinesUsed = { '5050': false, 'askit': false, 'skip': false };
  }
}

// ----------------------------------------------------------------------------
// Security helpers
// ----------------------------------------------------------------------------

// A03-1: small allowlist HTML sanitiser for question / option / lesson text.
// Strategy: escape everything, then reintroduce a tiny allowlist of tags.
// Allowed: <em>, </em>, <br>, <span class="mono">, </span>.
function sanitizeQuestionHtml(s) {
  if (typeof s !== 'string') return '';
  // Strip control characters that don't belong in display text.
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Escape metacharacters. The `&` arm only fires when NOT already part of a
  // valid entity — this makes the function idempotent, so a value that round-
  // trips through (save → reload → edit → save) doesn't accumulate `&amp;amp;`
  // chains.
  let out = s.replace(
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)|[<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
  // Reintroduce allowlisted tags via exact-match replacements.
  out = out
    .replace(/&lt;em&gt;/g, '<em>')
    .replace(/&lt;\/em&gt;/g, '</em>')
    .replace(/&lt;br\s*\/?&gt;/g, '<br>')
    .replace(/&lt;span class=&quot;mono&quot;&gt;/g, '<span class="mono">')
    .replace(/&lt;span class=&#39;mono&#39;&gt;/g, '<span class="mono">')
    .replace(/&lt;\/span&gt;/g, '</span>');
  return out;
}
// Per-question image cap. Inline the MIME allowlist (this function runs at
// module-load time when LOGO_MIME_ALLOW is still in TDZ). Empty string → no image.
const QUESTION_IMAGE_MAX_BYTES = 256 * 1024;
const QUESTION_IMAGE_MIME_ALLOW = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
function sanitizeQuestionImage(s) {
  if (typeof s !== 'string' || s === '') return '';
  const m = s.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return '';
  if (!QUESTION_IMAGE_MIME_ALLOW.includes(m[1].toLowerCase())) return '';
  if (s.length > QUESTION_IMAGE_MAX_BYTES) return '';
  return s;
}
function sanitizeQuestionList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(q => ({
    q: sanitizeQuestionHtml(q.q),
    options: (q.options || []).map(sanitizeQuestionHtml),
    correct: q.correct,
    lesson: sanitizeQuestionHtml(q.lesson),
    image: sanitizeQuestionImage(q.image),
    // A11Y: alt text for the image. Plain text only (no HTML allowed here).
    imageAlt: typeof q.imageAlt === 'string' ? q.imageAlt.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f<>"&]/g, '').slice(0, 200) : ''
  }));
}

function sanitizeAndValidateQuestionList(arr, sectionName) {
  if (!Array.isArray(arr)) {
    throw new Error(`${sectionName} must be an array`);
  }
  arr.forEach((q, idx) => {
    const label = `${sectionName} question ${idx + 1}`;
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      throw new Error(`${label} must be an object`);
    }
    if (typeof q.q !== 'string' || q.q.trim() === '') {
      throw new Error(`${label} needs non-empty q text`);
    }
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(`${label} needs exactly 4 options`);
    }
    q.options.forEach((option, optionIdx) => {
      if (typeof option !== 'string' || option.trim() === '') {
        throw new Error(`${label} option ${optionIdx + 1} must be non-empty text`);
      }
    });
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) {
      throw new Error(`${label} correct must be an integer from 0 to 3`);
    }
    if (typeof q.lesson !== 'string') {
      throw new Error(`${label} needs lesson text`);
    }
    if (q.image !== undefined && q.image !== '' && sanitizeQuestionImage(q.image) === '') {
      throw new Error(`${label} image must be a PNG, JPEG, WEBP, or SVG data URI under 256 KB`);
    }
    if (q.imageAlt !== undefined && typeof q.imageAlt !== 'string') {
      throw new Error(`${label} imageAlt must be text`);
    }
  });
  return sanitizeQuestionList(arr);
}

function normalizeQuestionBank(raw, {
  label = 'question bank',
  requireMain = false,
  allowQuestionsAlias = false,
  requireBonusKey = false
} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }

  let mainRaw = raw.main;
  if (mainRaw === undefined && allowQuestionsAlias) mainRaw = raw.questions;
  if (!Array.isArray(mainRaw)) {
    throw new Error(`${label} main must be an array`);
  }

  if (requireBonusKey && raw.bonus === undefined) {
    throw new Error(`${label} bonus must be an array`);
  }
  const bonusRaw = raw.bonus === undefined ? [] : raw.bonus;
  if (!Array.isArray(bonusRaw)) {
    throw new Error(`${label} bonus must be an array`);
  }

  const main = sanitizeAndValidateQuestionList(mainRaw, `${label} main`);
  const bonus = sanitizeAndValidateQuestionList(bonusRaw, `${label} bonus`);
  if (requireMain && main.length === 0) {
    throw new Error(`${label} must contain at least one main question`);
  }
  return { main, bonus };
}

// A03-2: CSV field escape — prevent formula injection in Excel / LibreOffice.
function csvField(v) {
  let s = v == null ? '' : String(v);
  s = s.replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// ----------------------------------------------------------------------------
// CSV parse / stringify — RFC 4180-ish. Used by the question import/export.
// Kept inline (no new deps).
// ----------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^﻿/, '');  // strip BOM if present
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(field); field = '';
        // Skip blank lines
        if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row);
  }
  return rows;
}

// ----------------------------------------------------------------------------
// Minimal XLSX writer (no external deps).
// Generates a ZIP-wrapped Office Open XML spreadsheet with per-cell fills so
// the conditional colouring "bakes in" — no need for Excel to evaluate any
// CF rules at open time.
// ----------------------------------------------------------------------------
const _crcTable = (function() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function xmlText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function colName(idx) {
  // 0 -> A, 25 -> Z, 26 -> AA, …
  let s = '', n = idx;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}
// Build a ZIP archive in memory. `files` is { 'path/in/zip': Buffer }.
function zipFiles(files) {
  const zlib = require('zlib');
  const parts = [];
  const cdEntries = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | (Math.floor(now.getSeconds() / 2) & 0x1f);
  const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f);
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);            // UTF-8 file names
    lfh.writeUInt16LE(8, 8);                 // method = deflate
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    parts.push(lfh, nameBuf, compressed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);                  // version made by
    cd.writeUInt16LE(20, 6);                  // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    cdEntries.push(Buffer.concat([cd, nameBuf]));
    offset += lfh.length + nameBuf.length + compressed.length;
  }
  const cdBuf = Buffer.concat(cdEntries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(cdEntries.length, 8);
  eocd.writeUInt16LE(cdEntries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

// Style indexes (must match the order in xl/styles.xml below).
// 0=default, 1=header, 2=correct, 3=wrong, 4=no-answer,
// 5=correct (eliminated, italic, lighter), 6=wrong (eliminated, italic, lighter), 7=numeric
const XLSX_STYLES_XML =
'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="6">' +
    '<font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/></font>' +    // 0 default
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' + // 1 header bold white
    '<font><sz val="11"/><color rgb="FF006100"/><name val="Calibri"/></font>' +     // 2 green
    '<font><sz val="11"/><color rgb="FF9C0006"/><name val="Calibri"/></font>' +     // 3 red
    '<font><sz val="11"/><color rgb="FF9C5700"/><name val="Calibri"/></font>' +     // 4 amber
    '<font><i/><sz val="11"/><color rgb="FF666666"/><name val="Calibri"/></font>' + // 5 muted grey italic
  '</fonts>' +
  '<fills count="8">' +
    '<fill><patternFill patternType="none"/></fill>' +                              // 0
    '<fill><patternFill patternType="gray125"/></fill>' +                           // 1 (reserved)
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill>' + // 2 header navy
    '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/></patternFill></fill>' + // 3 light green
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/></patternFill></fill>' + // 4 light red
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/></patternFill></fill>' + // 5 light amber
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/></patternFill></fill>' + // 6 paler green (eliminated)
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFCE4E4"/></patternFill></fill>' + // 7 paler red (eliminated)
  '</fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="8">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +                                                     // 0 default
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' + // 1 header
    '<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>' + // 2 correct
    '<xf numFmtId="0" fontId="3" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>' + // 3 wrong
    '<xf numFmtId="0" fontId="4" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>' + // 4 no-answer
    '<xf numFmtId="0" fontId="5" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>' + // 5 correct (eliminated)
    '<xf numFmtId="0" fontId="5" fillId="7" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>' + // 6 wrong (eliminated)
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>' + // 7 numeric centred
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
'</styleSheet>';

// Build an XLSX bytes from a 2-D array of cells. Each cell is { v, s, t? }:
//   v = value (string or number)
//   s = style index (number)
//   t = 'n' for numeric, otherwise inline string
function buildXlsx(headers, rows /* array of arrays of { v, s, t? } */, sheetName) {
  const safeName = (sheetName || 'Sheet1').replace(/[\\\/?*\[\]:]/g, '_').slice(0, 31);
  const allRows = [headers, ...rows];
  const colCount = headers.length;
  const lastCell = colName(colCount - 1) + allRows.length;

  // <sheetData>
  let body = '';
  allRows.forEach((cells, rIdx) => {
    const rNum = rIdx + 1;
    body += `<row r="${rNum}">`;
    cells.forEach((c, cIdx) => {
      const ref = colName(cIdx) + rNum;
      const styleAttr = (c.s != null) ? ` s="${c.s}"` : '';
      if (c.t === 'n' || typeof c.v === 'number') {
        body += `<c r="${ref}"${styleAttr}><v>${Number(c.v) || 0}</v></c>`;
      } else if (c.v == null || c.v === '') {
        body += `<c r="${ref}"${styleAttr}/>`;
      } else {
        body += `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xmlText(c.v)}</t></is></c>`;
      }
    });
    body += '</row>';
  });

  // Auto-size hints: <cols> with explicit widths makes it readable on open.
  const colWidths = headers.map((h, i) => {
    const label = String((h && h.v) || '');
    // Per-question columns get fixed narrow widths.
    if (/answer$/i.test(label)) return 11;
    if (/result$/i.test(label)) return 22;
    return Math.max(12, Math.min(34, Math.ceil(label.length * 1.15) + 4));
  });
  let colsXml = '<cols>';
  colWidths.forEach((w, i) => {
    colsXml += `<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`;
  });
  colsXml += '</cols>';

  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<dimension ref="A1:${lastCell}"/>` +
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      colsXml +
      `<sheetData>${body}</sheetData>` +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>';

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${xmlText(safeName)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  return zipFiles({
    '[Content_Types].xml': Buffer.from(contentTypes, 'utf8'),
    '_rels/.rels': Buffer.from(rootRels, 'utf8'),
    'xl/workbook.xml': Buffer.from(workbookXml, 'utf8'),
    'xl/_rels/workbook.xml.rels': Buffer.from(workbookRels, 'utf8'),
    'xl/styles.xml': Buffer.from(XLSX_STYLES_XML, 'utf8'),
    'xl/worksheets/sheet1.xml': Buffer.from(sheetXml, 'utf8'),
  });
}

// CSV cell escape that PRESERVES embedded newlines (RFC 4180 quoted fields can
// contain them). Used by the question import/export where lesson text may span
// lines. The /results.csv export uses csvField() which strips newlines because
// player names should always be on a single row.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function stringifyCsv(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// Question bank ↔ CSV. Columns: section, question, optionA-D, correct, lesson.
// Images intentionally NOT included — they live in the per-question editor as
// data URIs and would bloat the CSV. The CSV row format matches what Excel
// shows when you open it.
const CSV_HEADERS = ['section', 'question', 'optionA', 'optionB', 'optionC', 'optionD', 'correct', 'lesson'];

function questionsToCsv(main, bonus) {
  const rows = [CSV_HEADERS];
  const push = (section, q) => {
    rows.push([
      section,
      q.q || '',
      (q.options && q.options[0]) || '',
      (q.options && q.options[1]) || '',
      (q.options && q.options[2]) || '',
      (q.options && q.options[3]) || '',
      'ABCD'[q.correct] || '',
      q.lesson || ''
    ]);
  };
  (main  || []).forEach(q => push('main',  q));
  (bonus || []).forEach(q => push('bonus', q));
  return stringifyCsv(rows);
}

// Returns { main: [...], bonus: [...] } or throws on malformed input.
function questionsFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV is empty');
  // First row must be the header.
  const header = rows[0].map(h => String(h || '').trim().toLowerCase());
  const expect = CSV_HEADERS.map(h => h.toLowerCase());
  for (const col of expect) {
    if (!header.includes(col)) throw new Error('Missing required CSV column: ' + col);
  }
  const idx = Object.fromEntries(expect.map(col => [col, header.indexOf(col)]));
  const main = [];
  const bonus = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(v => String(v || '').trim() === '')) continue;
    const section = String(r[idx.section] || '').trim().toLowerCase();
    if (section !== 'main' && section !== 'bonus') {
      throw new Error(`Row ${i + 1}: section must be "main" or "bonus" (got "${r[idx.section]}")`);
    }
    let correctRaw = String(r[idx.correct] || '').trim().toUpperCase();
    let correct;
    if (/^[ABCD]$/.test(correctRaw)) correct = 'ABCD'.indexOf(correctRaw);
    else if (/^[0-3]$/.test(correctRaw)) correct = parseInt(correctRaw, 10);
    else throw new Error(`Row ${i + 1}: correct must be A/B/C/D or 0/1/2/3 (got "${r[idx.correct]}")`);
    const q = {
      q: String(r[idx.question] || '').trim(),
      options: [
        String(r[idx.optiona] || '').trim(),
        String(r[idx.optionb] || '').trim(),
        String(r[idx.optionc] || '').trim(),
        String(r[idx.optiond] || '').trim()
      ],
      correct,
      lesson: String(r[idx.lesson] || '').trim(),
      image: ''
    };
    if (!q.q) throw new Error(`Row ${i + 1}: question text is required`);
    if (q.options.some(o => !o)) throw new Error(`Row ${i + 1}: all four options are required`);
    (section === 'main' ? main : bonus).push(q);
  }
  return { main, bonus };
}

// A01-3: constant-time token comparison.
function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ----------------------------------------------------------------------------
// Branding (company name, domain, logo) — persists to data/config.json
// ----------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Logo size cap. The data URI prefix is small; we cap the whole string at ~256 KB.
const LOGO_MAX_BYTES = 256 * 1024;
const LOGO_MIME_ALLOW = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

// CSS custom-property colour defaults — kept in sync with the :root blocks in
// the player / host / admin HTML files. Operators can override each via the
// Branding tab; missing keys fall back to these.
const DEFAULT_THEME = Object.freeze({
  navyDeep:    '#020625',
  navyMid:     '#050d3d',
  navyLight:   '#0a1660',
  gold:        '#f4c430',
  goldBright:  '#ffd700',
  goldDim:     '#8a6d10',
  red:         '#c41e3a',
  green:       '#1ea14a',
  white:       '#f5f3e8'
});

// Default privacy notice rendered on the player join screen. AU Privacy Act
// 1988 (APP 5) asks the collector to inform individuals at point of collection;
// this string is the boot-time default and is overridable per deployment via
// admin → Branding → Privacy notice (or the CONSENT_TEXT env var).
const DEFAULT_CONSENT_TEXT =
  'By joining you agree to share your name and work email with the session facilitator. ' +
  'Data is held in memory only, exported as a CSV at the end of the session, and cleared when the server restarts.';

const DEFAULT_BRANDING = {
  companyName: '',
  companyDomain: '',
  restrictDomain: false,
  logoDataUri: '',    // empty = no logo
  tagline: '',
  publicBaseUrl: '',  // overrides PUBLIC_BASE_URL env var at runtime
  levelStyle: 'money',  // 'money' = $100→$1M; 'levels' = "Level 1" → "Level N"
  showNamesAtEnd: true, // true = show player names + run award ceremony at game end; false = anonymise
  answerLockMode: 'quick',  // 'quick' = tap-to-commit (current); 'confirm' = tap-then-Lock-In
  eliminatedCanAnswer: false, // when true, eliminated players can still tap (no scoring, just engagement)
  quizTitle: 'Omega Quiz',    // display title on player / host (overridden by companyName when set)
  quizCategory: 'cyber',      // informational tag from the loaded sample pack
  // Privacy notice shown above the Join button on the player screen. Authored
  // by the operator so each deployment can meet its own legal obligations.
  consentText: DEFAULT_CONSENT_TEXT,
  // Lifeline refill schedule. When the host opens & applies a lifeline,
  // we mark just that lifeline type used. The remaining two can still fire
  // in the same round. This setting decides when they get topped up again:
  //   'never'         — one of each per game (default; classic WWTBAM)
  //   'each-question' — fresh set every question (party / training mode)
  //   'at-bonus'      — fresh set when the bonus / tiebreaker round starts
  lifelineRefill: 'never',
  // Session closed flag — when true the player and host pages show a
  // "session ended" view, new joins are rejected, but the admin can still
  // sign in and reopen. Use case: shut down the storefront between
  // training sessions without taking the process down (PaaS auto-restart
  // makes a true shutdown unreliable anyway).
  sessionClosed: false,
  // Optional CTA shown on the "session ended" screen — e.g. link to a
  // post-session survey or follow-up training. Empty disables the button.
  closedSessionCtaLabel: '',
  closedSessionCtaUrl: '',
  theme: { ...DEFAULT_THEME }
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Normalise + validate a theme object. Unknown keys are dropped; invalid hex
// values fall back to DEFAULT_THEME (or throw in strict mode).
function validateTheme(raw, { tolerant = false } = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_THEME };
  for (const key of Object.keys(DEFAULT_THEME)) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string') {
      if (tolerant) continue;
      throw new Error(`theme.${key} must be a string`);
    }
    const v = raw[key].trim().toLowerCase();
    if (!HEX_RE.test(v)) {
      if (tolerant) continue;
      throw new Error(`theme.${key} is not a valid hex colour (got "${raw[key]}")`);
    }
    // Normalise 3-digit shortform to 6-digit so the client / CSS sees consistent values.
    out[key] = v.length === 4 ? '#' + v.slice(1).split('').map(c => c + c).join('') : v;
  }
  return out;
}

// Detect host shapes that should default to http:// rather than https:// when
// the operator omits the scheme. Local IPs and "localhost"-ish hosts almost
// never have a TLS cert, and silently prepending https:// makes the page fail
// to load. Public hostnames still default to https://.
function looksLikePlainHttpHost(host) {
  if (!host) return false;
  // Strip optional :port
  const bare = host.replace(/:\d+$/, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.local') || bare.endsWith('.localhost')) return true;
  // IPv4
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) return true;
  // IPv6 (bracketed form): [::1], [fe80::...]
  if (bare.startsWith('[') && bare.endsWith(']')) return true;
  // IPv6 (unbracketed) — contains colon AND no letters mixed with dots like a TLD
  if (bare.includes(':') && !/\.[a-z]{2,}$/.test(bare)) return true;
  return false;
}

// Normalise/validate a public-base URL: must be http(s), trailing slash stripped,
// no userinfo, no fragments or paths beyond `/`. Returns the cleaned URL or
// throws.
//
// Scheme defaulting:
//   - "https://example.com"      → https://example.com (kept)
//   - "http://192.168.1.5:3000"  → http://...           (kept)
//   - "example.com"              → https://example.com  (assume hosted = https)
//   - "192.168.1.5:3000"         → http://...           (IP shape = plain http)
//   - "localhost:3000"           → http://localhost:3000
function parsePublicBaseUrl(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) {
    const scheme = looksLikePlainHttpHost(v) ? 'http://' : 'https://';
    v = scheme + v;
  }
  let u;
  try { u = new URL(v); } catch { throw new Error('publicBaseUrl is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('publicBaseUrl must use http or https');
  if (u.username || u.password) throw new Error('publicBaseUrl must not contain credentials');
  if (u.search || u.hash) throw new Error('publicBaseUrl must not contain query or hash');
  if (u.pathname && u.pathname !== '/') throw new Error('publicBaseUrl must not include a path');
  return u.protocol + '//' + u.host;
}

// Build a "first-run defaults" branding object from environment variables.
// Used only when data/config.json is missing — once the admin saves any
// branding, the on-disk config takes over and env vars are ignored. This
// keeps the .env story simple ("starting defaults") and avoids reverting
// admin UI edits on every restart.
function brandingFromEnv() {
  const e = process.env;
  const out = { ...DEFAULT_BRANDING };
  const truthy = v => /^(?:1|true|yes|on)$/i.test(String(v || '').trim());
  const setStr = (k, v) => { if (typeof v === 'string' && v.length > 0) out[k] = v; };

  setStr('companyName',   e.COMPANY_NAME);
  setStr('companyDomain', e.COMPANY_DOMAIN);
  if (e.RESTRICT_DOMAIN !== undefined) out.restrictDomain = truthy(e.RESTRICT_DOMAIN);
  setStr('tagline',       e.TAGLINE);
  setStr('publicBaseUrl', e.PUBLIC_BASE_URL);
  setStr('quizTitle',     e.QUIZ_TITLE);
  setStr('quizCategory',  e.QUIZ_CATEGORY);
  // CONSENT_TEXT can be a privacy notice or an empty string. Empty string
  // suppresses the notice entirely (operator accepts the legal risk).
  if (typeof e.CONSENT_TEXT === 'string') out.consentText = e.CONSENT_TEXT;
  if (e.LEVEL_STYLE === 'money' || e.LEVEL_STYLE === 'levels') out.levelStyle = e.LEVEL_STYLE;
  if (e.SHOW_NAMES_AT_END !== undefined) out.showNamesAtEnd = truthy(e.SHOW_NAMES_AT_END);
  if (e.ANSWER_LOCK_MODE === 'quick' || e.ANSWER_LOCK_MODE === 'confirm') out.answerLockMode = e.ANSWER_LOCK_MODE;
  if (e.ELIMINATED_CAN_ANSWER !== undefined) out.eliminatedCanAnswer = truthy(e.ELIMINATED_CAN_ANSWER);
  if (e.LIFELINE_REFILL === 'never' || e.LIFELINE_REFILL === 'each-question' || e.LIFELINE_REFILL === 'at-bonus') {
    out.lifelineRefill = e.LIFELINE_REFILL;
  }
  // Session-closed CTA defaults — first-run only; admin saves win once
  // data/config.json exists, same precedence as the other branding fields.
  setStr('closedSessionCtaLabel', e.CLOSED_SESSION_CTA_LABEL);
  setStr('closedSessionCtaUrl',   e.CLOSED_SESSION_CTA_URL);

  // Theme overrides — one env var per CSS variable, validated against the
  // same hex regex the admin form uses so bad values fall through to defaults.
  const theme = { ...DEFAULT_THEME };
  const themeMap = {
    THEME_NAVY_DEEP:   'navyDeep',
    THEME_NAVY_MID:    'navyMid',
    THEME_NAVY_LIGHT:  'navyLight',
    THEME_GOLD:        'gold',
    THEME_GOLD_BRIGHT: 'goldBright',
    THEME_GOLD_DIM:    'goldDim',
    THEME_RED:         'red',
    THEME_GREEN:       'green',
    THEME_WHITE:       'white'
  };
  for (const [envKey, themeKey] of Object.entries(themeMap)) {
    const v = (e[envKey] || '').trim();
    if (HEX_RE.test(v)) theme[themeKey] = v.toLowerCase();
  }
  out.theme = theme;

  // Run through the same validator the admin UI uses so e.g. companyDomain
  // gets shape-checked and companyName gets HTML-sanitised before persisting.
  // Tolerant mode means an invalid env var falls back to the default rather
  // than crashing the server.
  return validateBranding(out, { tolerant: true });
}

function loadBranding() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return validateBranding(parsed, { tolerant: true });
  } catch (e) {
    // No / corrupt config — fall back to env-overlay defaults. First-run
    // operators can set everything via .env; once saved via the admin UI,
    // the on-disk config wins and env vars stop being consulted.
    return brandingFromEnv();
  }
}

// Validate + normalise a branding payload. In tolerant mode (loading from disk),
// invalid individual fields fall back to defaults; in strict mode (from admin),
// any invalid field throws.
function validateBranding(raw, { tolerant = false } = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_BRANDING };

  // companyName: plain text, max 80 chars. We sanitise as HTML to be safe when
  // the client interpolates it into the page title.
  if (typeof raw.companyName === 'string') {
    out.companyName = sanitizeQuestionHtml(raw.companyName.trim().slice(0, 80));
  } else if (!tolerant && raw.companyName !== undefined) {
    throw new Error('companyName must be a string');
  }

  // companyDomain: lowercase, regex-checked
  if (typeof raw.companyDomain === 'string') {
    const d = raw.companyDomain.trim().toLowerCase().replace(/^@/, '');
    if (d === '' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)) {
      out.companyDomain = d;
    } else if (!tolerant) {
      throw new Error('companyDomain must look like example.com');
    }
  } else if (!tolerant && raw.companyDomain !== undefined) {
    throw new Error('companyDomain must be a string');
  }

  // restrictDomain: boolean
  out.restrictDomain = !!raw.restrictDomain;

  // tagline: plain text, max 120 chars
  if (typeof raw.tagline === 'string') {
    out.tagline = sanitizeQuestionHtml(raw.tagline.trim().slice(0, 120));
  } else if (!tolerant && raw.tagline !== undefined) {
    throw new Error('tagline must be a string');
  }

  // logoDataUri: must be data:image/(png|jpeg|webp|svg+xml);base64,…  AND under cap.
  if (typeof raw.logoDataUri === 'string' && raw.logoDataUri.length > 0) {
    const m = raw.logoDataUri.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) {
      if (tolerant) { /* drop the logo */ }
      else throw new Error('logoDataUri must be a base64 data URI');
    } else if (!LOGO_MIME_ALLOW.includes(m[1].toLowerCase())) {
      if (tolerant) { /* drop */ }
      else throw new Error('logoDataUri MIME not allowed (use PNG, JPEG, WEBP, or SVG)');
    } else if (raw.logoDataUri.length > LOGO_MAX_BYTES) {
      if (tolerant) { /* drop */ }
      else throw new Error('logo is larger than ' + Math.floor(LOGO_MAX_BYTES / 1024) + ' KB');
    } else {
      out.logoDataUri = raw.logoDataUri;
    }
  } else if (!tolerant && raw.logoDataUri !== undefined && raw.logoDataUri !== '') {
    throw new Error('logoDataUri must be a string');
  }

  // publicBaseUrl: validated by parsePublicBaseUrl (drops trailing slash, no path).
  if (typeof raw.publicBaseUrl === 'string') {
    try { out.publicBaseUrl = parsePublicBaseUrl(raw.publicBaseUrl); }
    catch (e) { if (!tolerant) throw e; }
  } else if (!tolerant && raw.publicBaseUrl !== undefined && raw.publicBaseUrl !== '') {
    throw new Error('publicBaseUrl must be a string');
  }

  // levelStyle: enum
  if (raw.levelStyle !== undefined) {
    if (raw.levelStyle === 'money' || raw.levelStyle === 'levels') out.levelStyle = raw.levelStyle;
    else if (!tolerant) throw new Error('levelStyle must be "money" or "levels"');
  }

  // showNamesAtEnd: boolean (default true). Drives whether the host projector
  // reveals player names in the final podium and runs the award ceremony.
  if (raw.showNamesAtEnd !== undefined) {
    out.showNamesAtEnd = !!raw.showNamesAtEnd;
  }

  // answerLockMode: enum
  if (raw.answerLockMode !== undefined) {
    if (raw.answerLockMode === 'quick' || raw.answerLockMode === 'confirm') out.answerLockMode = raw.answerLockMode;
    else if (!tolerant) throw new Error('answerLockMode must be "quick" or "confirm"');
  }

  // eliminatedCanAnswer: boolean
  if (raw.eliminatedCanAnswer !== undefined) {
    out.eliminatedCanAnswer = !!raw.eliminatedCanAnswer;
  }

  // lifelineRefill: enum — when used lifelines come back. 'never' is the
  // classic single-set-per-game; 'each-question' refills every question;
  // 'at-bonus' refills at the bonus/tiebreaker round only.
  if (raw.lifelineRefill !== undefined) {
    if (raw.lifelineRefill === 'never' || raw.lifelineRefill === 'each-question' || raw.lifelineRefill === 'at-bonus') {
      out.lifelineRefill = raw.lifelineRefill;
    } else if (!tolerant) {
      throw new Error('lifelineRefill must be "never", "each-question", or "at-bonus"');
    }
  }

  // sessionClosed: boolean. When true, new player joins are blocked and the
  // player/host pages show a "session ended" view. The admin can reopen.
  if (raw.sessionClosed !== undefined) {
    out.sessionClosed = !!raw.sessionClosed;
  }

  // closedSessionCtaLabel: 0–60 chars, plain text after sanitisation.
  if (typeof raw.closedSessionCtaLabel === 'string') {
    out.closedSessionCtaLabel = sanitizeQuestionHtml(raw.closedSessionCtaLabel.trim().slice(0, 60));
  } else if (!tolerant && raw.closedSessionCtaLabel !== undefined) {
    throw new Error('closedSessionCtaLabel must be a string');
  }

  // closedSessionCtaUrl: must be http(s) or mailto:, max 500 chars. Empty allowed.
  if (typeof raw.closedSessionCtaUrl === 'string') {
    const v = raw.closedSessionCtaUrl.trim().slice(0, 500);
    if (v === '') {
      out.closedSessionCtaUrl = '';
    } else if (/^(https?:\/\/|mailto:)/i.test(v)) {
      // Reject obvious XSS / control characters but otherwise let the URL through.
      if (/[\x00-\x1f<>"`]/.test(v)) {
        if (!tolerant) throw new Error('closedSessionCtaUrl contains invalid characters');
      } else {
        out.closedSessionCtaUrl = v;
      }
    } else if (!tolerant) {
      throw new Error('closedSessionCtaUrl must start with https://, http://, or mailto:');
    }
  } else if (!tolerant && raw.closedSessionCtaUrl !== undefined) {
    throw new Error('closedSessionCtaUrl must be a string');
  }

  // quizTitle: trimmed string, max 80 chars, HTML-escaped via the question sanitiser
  if (typeof raw.quizTitle === 'string') {
    out.quizTitle = sanitizeQuestionHtml(raw.quizTitle.trim().slice(0, 80)) || DEFAULT_BRANDING.quizTitle;
  } else if (!tolerant && raw.quizTitle !== undefined) {
    throw new Error('quizTitle must be a string');
  }
  // consentText: 0–800 chars, HTML-sanitised through the same allowlist as
  // question content (so <em>, <br>, and <span class="mono"> can be used to
  // format the notice). Empty string opts out of showing any notice.
  if (typeof raw.consentText === 'string') {
    const trimmed = raw.consentText.trim().slice(0, 800);
    out.consentText = trimmed === '' ? '' : sanitizeQuestionHtml(trimmed);
  } else if (!tolerant && raw.consentText !== undefined) {
    throw new Error('consentText must be a string');
  }
  // quizCategory: lowercase slug, alphanumeric + hyphens, max 40
  if (typeof raw.quizCategory === 'string') {
    const slug = raw.quizCategory.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
    out.quizCategory = slug;
  } else if (!tolerant && raw.quizCategory !== undefined) {
    throw new Error('quizCategory must be a string');
  }

  // theme: per-key hex validation; unknown keys ignored.
  try { out.theme = validateTheme(raw.theme, { tolerant }); }
  catch (e) { if (!tolerant) throw e; out.theme = { ...DEFAULT_THEME }; }

  return out;
}

function saveBranding(next) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
}

let branding = loadBranding();

// Resolution order for the URL used in QR codes, magic links, and the boot banner:
//   1. runtime admin override   (branding.publicBaseUrl)
//   2. PUBLIC_BASE_URL env var  (parsed/cleaned the same way)
//   3. incoming request's Host  (so /qr still works when neither is configured)
//   4. http://localhost:PORT    (boot-time fallback)
function envPublicBaseUrl() {
  if (!process.env.PUBLIC_BASE_URL) return '';
  try { return parsePublicBaseUrl(process.env.PUBLIC_BASE_URL); }
  catch (e) {
    logJson('warn', 'PUBLIC_BASE_URL env var ignored', { error: e.message });
    return '';
  }
}
const ENV_PUBLIC_BASE_URL = envPublicBaseUrl();

function getPublicBaseUrl(req) {
  if (branding.publicBaseUrl) return branding.publicBaseUrl;
  if (ENV_PUBLIC_BASE_URL)    return ENV_PUBLIC_BASE_URL;
  if (req) {
    const proto = isHttps(req) ? 'https' : 'http';
    return proto + '://' + req.get('host');
  }
  return 'http://localhost:' + PORT;
}

// --- Sessions (A01-1 / A07-1) ---
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const sessions = new Map(); // sessionId -> { role, expiresAt, createdAt, ip }

function createSession(role, ip) {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { role, expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now(), ip });
  return id;
}
function deleteSession(id) { if (id) sessions.delete(id); }
function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(id); return null; }
  return s;
}
function signValue(value) {
  return crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('hex');
}
function packCookie(sessionId) {
  return sessionId + '.' + signValue(sessionId);
}
function unpackCookie(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const idx = raw.lastIndexOf('.');
  if (idx < 0) return null;
  const id = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  if (!tokensEqual(sig, signValue(id))) return null;
  return id;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(/;\s*/).forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}
function sessionFromReq(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const id = unpackCookie(cookies.omegaquiz_sess);
  return getSession(id);
}
function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}
function setSessionCookie(req, res, sessionId) {
  const parts = [
    'omegaquiz_sess=' + encodeURIComponent(packCookie(sessionId)),
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000)
  ];
  if (isHttps(req) || process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'omegaquiz_sess=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

// --- Magic-link tokens (one-shot, time-limited URL login) ---
// These are short-lived, single-use tokens used as a UX shortcut. The static
// HOST_TOKEN / ADMIN_TOKEN env vars remain the durable credentials behind the
// form login. Because each magic token is consumed on first use AND expires
// after MAGIC_TTL_MS, its appearance in browser history / server logs has no
// lasting security value — the cost of leaking it falls off a cliff at first click.
const MAGIC_TTL_MS = 10 * 60 * 1000;
const magicLinks = new Map(); // token -> { role, expiresAt }

function mintMagicToken(role) {
  const token = crypto.randomBytes(32).toString('base64url');
  magicLinks.set(token, { role, expiresAt: Date.now() + MAGIC_TTL_MS });
  return token;
}
function consumeMagicToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const entry = magicLinks.get(token);
  if (!entry) return null;
  // Always delete on first read (single-use) — even if expired.
  magicLinks.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}
function pruneExpiredMagic() {
  const now = Date.now();
  for (const [t, e] of magicLinks.entries()) if (e.expiresAt < now) magicLinks.delete(t);
}
setInterval(pruneExpiredMagic, 60_000).unref?.();

// Initial magic tokens minted at module load so the test harness can read them
// before server.listen fires the boot banner.
let HOST_MAGIC  = mintMagicToken('host');
let ADMIN_MAGIC = mintMagicToken('admin');

// --- Login rate limiter (A04-2 / A07-3) ---
const loginFailures = new Map(); // ip -> { count, blockedUntil }
function recordLoginFailure(ip) {
  const now = Date.now();
  let entry = loginFailures.get(ip);
  if (!entry || entry.blockedUntil < now) entry = { count: 0, blockedUntil: 0 };
  entry.count++;
  if (entry.count >= 5) entry.blockedUntil = now + 5 * 60 * 1000; // 5 min
  loginFailures.set(ip, entry);
}
function isBlocked(ip) {
  const e = loginFailures.get(ip);
  return !!(e && e.blockedUntil > Date.now());
}
function clearLoginFailures(ip) { loginFailures.delete(ip); }

// --- WebSocket player:join rate limiter (A01-6 follow-up) ---
// Six-digit join code + per-client throttling keeps public joining practical
// without trusting spoofable proxy headers from direct-to-origin traffic.
const JOIN_FAILURE_MAX = 8;
const JOIN_BLOCK_MS    = 5 * 60 * 1000;
const JOIN_WINDOW_MS   = 60 * 1000;
const joinFailures = new Map(); // ip -> { count, firstAt, blockedUntil }
function recordJoinFailure(ip) {
  const now = Date.now();
  let entry = joinFailures.get(ip);
  // Reset the window when previous failures aged out, so a slow scan doesn't
  // accumulate strikes over the course of an hour.
  if (!entry || entry.blockedUntil < now && (now - entry.firstAt) > JOIN_WINDOW_MS) {
    entry = { count: 0, firstAt: now, blockedUntil: 0 };
  }
  entry.count++;
  if (entry.count >= JOIN_FAILURE_MAX) entry.blockedUntil = now + JOIN_BLOCK_MS;
  joinFailures.set(ip, entry);
}
function isJoinBlocked(ip) {
  const e = joinFailures.get(ip);
  return !!(e && e.blockedUntil > Date.now());
}
function clearJoinFailures(ip) { joinFailures.delete(ip); }

const CLOUDFLARE_EDGE_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
];

function normalizeIp(ip) {
  let out = String(ip || '').trim();
  if (!out) return '';
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  const zoneAt = out.indexOf('%');
  if (zoneAt >= 0) out = out.slice(0, zoneAt);
  if (out.toLowerCase().startsWith('::ffff:')) {
    const mapped = out.slice(7);
    if (net.isIP(mapped) === 4) return mapped;
  }
  return out;
}

function ipv4ToBytes(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    bytes.push(n);
  }
  return Buffer.from(bytes);
}

function ipv6ToBytes(ip) {
  let src = String(ip || '').toLowerCase();
  if (src.includes('.')) {
    const lastColon = src.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4Bytes = ipv4ToBytes(src.slice(lastColon + 1));
    if (!v4Bytes) return null;
    src = src.slice(0, lastColon)
      + ':' + ((v4Bytes[0] << 8) | v4Bytes[1]).toString(16)
      + ':' + ((v4Bytes[2] << 8) | v4Bytes[3]).toString(16);
  }
  const halves = src.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.includes('') || right.includes('')) return null;
  const zeroCount = 8 - left.length - right.length;
  if (halves.length === 1 && zeroCount !== 0) return null;
  if (halves.length === 2 && zeroCount < 1) return null;
  const groups = [...left, ...Array(Math.max(0, zeroCount)).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  for (let i = 0; i < groups.length; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    out.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  }
  return out;
}

function ipToBytes(ip) {
  const normalized = normalizeIp(ip);
  const version = net.isIP(normalized);
  if (version === 4) return ipv4ToBytes(normalized);
  if (version === 6) return ipv6ToBytes(normalized);
  return null;
}

function ipMatchesCidr(ip, cidr) {
  const [range, prefixRaw] = String(cidr || '').split('/');
  const ipBytes = ipToBytes(ip);
  const rangeBytes = ipToBytes(range);
  const prefix = Number(prefixRaw);
  if (!ipBytes || !rangeBytes || ipBytes.length !== rangeBytes.length) return false;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ipBytes.length * 8) return false;
  let bitsLeft = prefix;
  for (let i = 0; i < ipBytes.length && bitsLeft > 0; i++) {
    const bits = Math.min(8, bitsLeft);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((ipBytes[i] & mask) !== (rangeBytes[i] & mask)) return false;
    bitsLeft -= bits;
  }
  return true;
}

function isCloudflareEdgeIp(ip) {
  const normalized = normalizeIp(ip);
  if (!net.isIP(normalized)) return false;
  return CLOUDFLARE_EDGE_CIDRS.some(cidr => ipMatchesCidr(normalized, cidr));
}

function firstValidIpHeader(value) {
  if (value == null) return '';
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  for (const part of raw.split(',')) {
    const ip = normalizeIp(part);
    if (net.isIP(ip)) return ip;
  }
  return '';
}

function getClientIp(req) {
  const remote = normalizeIp(req && req.socket && req.socket.remoteAddress);
  if (isCloudflareEdgeIp(remote)) {
    return firstValidIpHeader(req.headers['cf-connecting-ip'])
      || firstValidIpHeader(req.headers['x-forwarded-for'])
      || remote
      || 'unknown';
  }
  return remote || 'unknown';
}

// --- Security headers (A05-1) ---
// S3: CSP migrated to per-response nonces for script-src. `'unsafe-inline'` is
// gone from script-src — every inline <script> in our pages carries a
// nonce="..." attribute that matches the CSP header. style-src keeps
// `'unsafe-inline'` because we use plenty of inline style="..." attributes
// (CSS-based exfiltration is a far narrower attack class than JS injection).
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !isHttps(req)) {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  // Per-response nonce. 16 random bytes → 24-char base64 string. Stash on
  // res.locals so the HTML-serving helper can read it.
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${res.locals.cspNonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; '));
  next();
});

// Cache the three HTML pages at boot so we can do a cheap string substitute
// per request rather than re-reading from disk. Each contains the literal
// placeholder __CSP_NONCE__ on its inline <script> tags; we replace it with
// the per-response nonce just before sending.
const HTML_CACHE = {};
function loadHtml(name) {
  HTML_CACHE[name] = fs.readFileSync(path.join(__dirname, 'public', name), 'utf8');
}
['index.html', 'host.html', 'admin.html'].forEach(loadHtml);
function serveHtmlWithNonce(name, res) {
  const html = HTML_CACHE[name];
  if (!html) { res.status(500).send('html cache miss: ' + name); return; }
  const nonce = res.locals.cspNonce || '';
  // Replace every occurrence of __CSP_NONCE__ with the per-response nonce.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html.split('__CSP_NONCE__').join(nonce));
}

// --- Auth middleware ---
function requireRole(...roles) {
  return (req, res, next) => {
    const s = sessionFromReq(req);
    if (!s || !roles.includes(s.role)) {
      if (req.method === 'GET') {
        const role = roles[0];
        return res.redirect(302, '/auth/login?role=' + encodeURIComponent(role) + '&next=' + encodeURIComponent(req.originalUrl));
      }
      return res.status(401).json({ error: 'auth required' });
    }
    req.session = s;
    next();
  };
}

// --- Helpers ---
function publicPlayers() {
  return [...game.players.values()].map(p => ({
    id: p.id, name: p.name, alive: p.alive, score: p.answeredScore
  }));
}
function survivors() { return [...game.players.values()].filter(p => p.alive); }
function topSurvivorsByScore(n = 5) {
  return survivors()
    .sort((a, b) => b.answeredScore - a.answeredScore || a.name.localeCompare(b.name))
    .slice(0, n)
    .map(p => ({ name: p.name, score: p.answeredScore }));
}
function broadcast(obj, filterFn = null) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState !== 1) return;
    if (filterFn && !filterFn(client)) return;
    client.send(msg);
  });
}

function pushHostState() {
  const q = currentQuestion();
  broadcast({
    type: 'host:state',
    state: {
      phase: game.phase,
      joinCode: game.joinCode,
      questionIndex: game.questionIndex,
      bonusIndex: game.bonusIndex,
      inBonus: game.inBonus,
      totalQuestions: questions.length,
      playerCount: game.players.size,
      aliveCount: survivors().length,
      answeredCount: game.currentAnswers.size,
      topSurvivors: topSurvivorsByScore(5),
      players: publicPlayers(),
      // Legacy boolean (true only when all three are used) — kept for back-compat
      // with older test harnesses. New clients use lifelinesUsed (per-type map).
      lifelineUsed: lifelinesAllUsed(),
      lifelinesUsed: { ...game.lifelinesUsed },
      lifelineActive: game.lifelineActive ? {
        type: game.lifelineActive.type,
        voteCounts: tallyLifelineVotes()
      } : null,
      eliminatedOptions: game.eliminatedOptions,
      revealedCorrect: game.revealedCorrect,
      audienceTally: game.audienceTally,
      currentQuestion: q ? {
        q: q.q, options: q.options,
        image: q.image || '',
        imageAlt: q.imageAlt || '',
        correct: game.phase === 'reveal' ? q.correct : null,
        lesson: game.phase === 'reveal' ? q.lesson : null
      } : null
    }
  }, c => c.role === 'host');
}

function pushPlayerStates() {
  const isEnd = game.phase === 'end';
  // Build the post-game review payload once per push, not per player.
  // Only emitted when phase === 'end' so we don't bloat every state push.
  const review = isEnd ? {
    main:  questions.map(qq => ({ q: qq.q, options: qq.options, correct: qq.correct, lesson: qq.lesson, image: qq.image || '' })),
    bonus: bonusQuestions.map(qq => ({ q: qq.q, options: qq.options, correct: qq.correct, lesson: qq.lesson, image: qq.image || '' }))
  } : null;
  game.players.forEach(p => {
    if (!p.ws || p.ws.readyState !== 1) return;
    const q = currentQuestion();
    const myAnswer = game.currentAnswers.get(p.id);
    // history is built incrementally by close-question; expose to the player
    // so the "running correct" badge and post-game review have data to render.
    const history = p.history || [];
    const correctCount = history.reduce((n, h) => n + (h.correct ? 1 : 0), 0);
    const answeredCount = history.reduce((n, h) => n + (h.answer != null ? 1 : 0), 0);
    p.ws.send(JSON.stringify({
      type: 'player:state',
      state: {
        phase: game.phase,
        you: {
          name: p.name, alive: p.alive,
          score: p.answeredScore,
          // Total questions the player got right across the whole game,
          // including ones they answered after being eliminated (engagement mode).
          correctCount,
          answeredCount,
          // Per-question record so the player can review at the end.
          history,
          answered: myAnswer != null,
          myAnswer: myAnswer != null ? myAnswer : null
        },
        joinCode: game.joinCode,
        questionIndex: game.questionIndex,
        inBonus: game.inBonus,
        totalQuestions: questions.length,
        question: q ? {
          q: q.q,
          options: q.options,
          image: q.image || '',
          imageAlt: q.imageAlt || '',
          eliminatedOptions: game.eliminatedOptions,
          revealedCorrect: game.phase === 'reveal' ? q.correct : null,
          audienceTally: game.phase === 'reveal' ? game.audienceTally : null
        } : null,
        lifelineActive: game.lifelineActive ? {
          type: game.lifelineActive.type,
          alreadyVoted: game.lifelineActive.votes.has(p.id)
        } : null,
        lifelineUsed: lifelinesAllUsed(),
        lifelinesUsed: { ...game.lifelinesUsed },
        review
      }
    }));
  });
}

function buildLiveAnswerTally() {
  // Live snapshot of how alive players have answered the current question.
  // Admin only — host shouldn't see this (would spoil the suspense).
  if (game.phase !== 'question') return null;
  const counts = [0, 0, 0, 0];
  const eliminatedCounts = [0, 0, 0, 0];
  let answeredAlive = 0;
  let aliveTotal = 0;
  let answeredEliminated = 0;
  let eliminatedTotal = 0;
  game.players.forEach(p => {
    if (p.alive) aliveTotal++;
    else eliminatedTotal++;
    const a = game.currentAnswers.get(p.id);
    if (a == null || a < 0 || a >= 4) return;
    if (p.alive) {
      counts[a]++;
      answeredAlive++;
    } else {
      eliminatedCounts[a]++;
      answeredEliminated++;
    }
  });
  return {
    counts,
    answeredAlive,
    aliveTotal,
    eliminatedCounts,
    answeredEliminated,
    eliminatedTotal,
    eliminatedOptions: [...game.eliminatedOptions],
    changeEvents: game.changesThisQuestion,
    playersWhoChanged: game.playersChangedThisQuestion.size
  };
}

function pushAdminState() {
  const q = currentQuestion();
  const playersDetailed = [...game.players.values()].map(p => ({
    id: p.id, name: p.name, email: p.email,
    alive: p.alive, score: p.answeredScore,
    online: !!(p.ws && p.ws.readyState === 1),
    disconnectedAt: p.disconnectedAt,
    reconnectExpiresAt: p.disconnectedAt ? p.disconnectedAt + PLAYER_RECONNECT_WINDOW_MS : null,
    joinedAt: p.joinedAt, lastSeen: p.lastSeen,
    history: p.history,
    currentAnswer: game.currentAnswers.has(p.id) ? game.currentAnswers.get(p.id) : null
  }));
  broadcast({
    type: 'admin:state',
    state: {
      phase: game.phase,
      joinCode: game.joinCode,
      questionIndex: game.questionIndex,
      bonusIndex: game.bonusIndex,
      inBonus: game.inBonus,
      totalQuestions: questions.length,
      totalBonus: bonusQuestions.length,
      reconnectWindowMs: PLAYER_RECONNECT_WINDOW_MS,
      playerCount: game.players.size,
      aliveCount: survivors().length,
      answeredCount: game.currentAnswers.size,
      lifelineUsed: lifelinesAllUsed(),
      lifelinesUsed: { ...game.lifelinesUsed },
      lifelineActive: game.lifelineActive ? { type: game.lifelineActive.type, voteCounts: tallyLifelineVotes() } : null,
      eliminatedOptions: game.eliminatedOptions,
      revealedCorrect: game.revealedCorrect,
      audienceTally: game.audienceTally,
      liveAnswerTally: buildLiveAnswerTally(),
      currentQuestionRef: q ? {
        q: q.q, options: q.options, correct: q.correct, lesson: q.lesson, image: q.image || ''
      } : null,
      players: playersDetailed
    }
  }, c => c.role === 'admin');
}

function pushAll() { pushHostState(); pushPlayerStates(); pushAdminState(); }

function currentQuestion() {
  if (game.inBonus) return bonusQuestions[game.bonusIndex] || null;
  return questions[game.questionIndex] || null;
}

function tallyLifelineVotes() {
  const counts = { '5050': 0, 'askit': 0, 'skip': 0 };
  if (!game.lifelineActive) return counts;
  game.lifelineActive.votes.forEach(v => { if (counts[v] != null) counts[v]++; });
  return counts;
}

// --- Host actions ---
function hostAction(action, payload = {}) {
  switch (action) {
    case 'start-game': {
      if (game.phase !== 'lobby') return;
      if (questions.length === 0) {
        // Empty bank — admin must import or load samples first.
        logEvent('warn', 'start-game refused — no questions loaded');
        return;
      }
      game.phase = 'question';
      game.questionIndex = 0;
      resetCurrentAnswerState();
      game.eliminatedOptions = []; game.audienceTally = null;
      game.revealedCorrect = null;
      pushAll();
      break;
    }
    case 'open-lifeline-vote': {
      // Vote panel is only useful if at least one lifeline type is still available.
      if (lifelinesAllUsed()) return;
      if (game.phase !== 'question') return;
      game.lifelineActive = { type: 'vote', votes: new Map() };
      pushAll();
      break;
    }
    case 'apply-lifeline': {
      const type = payload.type;
      if (!['5050','askit','skip'].includes(type)) return;
      // Only block this specific type if it's already been spent — the other
      // two are still fair game on the same question.
      if (game.lifelinesUsed && game.lifelinesUsed[type]) return;
      if (game.phase !== 'question') return;
      const q = currentQuestion();
      if (!q) return;

      game.lifelinesUsed[type] = true;
      game.lifelineActive = null;

      if (type === '5050') {
        const wrongs = [0,1,2,3].filter(i => i !== q.correct);
        const remove = wrongs.sort(()=>Math.random()-0.5).slice(0,2);
        game.eliminatedOptions = remove;
      } else if (type === 'askit') {
        broadcast({ type: 'lifeline:askit', correctLetter: 'ABCD'[q.correct], hint: (q.lesson || '').split('.')[0] + '.' });
      } else if (type === 'skip') {
        game.phase = 'reveal';
        game.revealedCorrect = q.correct;
        broadcast({ type: 'lifeline:skip' });
      }
      pushAll();
      break;
    }
    case 'cancel-lifeline-vote': {
      game.lifelineActive = null;
      pushAll();
      break;
    }
    case 'close-question': {
      if (game.phase !== 'question') return;
      const q = currentQuestion();
      if (!q) return;
      const qLabel = game.inBonus ? `B${game.bonusIndex + 1}` : `Q${game.questionIndex + 1}`;

      const wasAliveIds = new Set([...game.players.values()].filter(p => p.alive).map(p => p.id));

      game.players.forEach(p => {
        const a = game.currentAnswers.get(p.id);
        const correct = a === q.correct;
        p.history.push({
          label: qLabel,
          answer: a == null ? null : a,
          correct: a == null ? false : correct,
          wasAlive: p.alive
        });
        if (!p.alive) return;
        if (a == null || a !== q.correct) {
          p.alive = false;
          if (a == null) logEvent('timeout', `${p.name} eliminated — no answer on ${qLabel}`, { playerId: p.id });
        } else {
          p.answeredScore += 1;
        }
      });

      const aliveBars = [0,0,0,0];
      const elimBars  = [0,0,0,0];
      let aliveTotal = 0, elimTotal = 0;
      game.players.forEach(p => {
        const a = game.currentAnswers.get(p.id);
        if (a == null) return;
        if (p.alive) { aliveBars[a]++; aliveTotal++; }
        else { elimBars[a]++; elimTotal++; }
      });
      game.audienceTally = { aliveBars, elimBars, aliveTotal, elimTotal, wasAliveCount: wasAliveIds.size };

      game.phase = 'reveal';
      game.revealedCorrect = q.correct;
      logEvent('reveal', `${qLabel} closed — ${survivors().length} survivors`);
      pushAll();
      break;
    }
    case 'next-question': {
      if (game.phase !== 'reveal') return;
      if (game.inBonus) {
        const aliveAfter = survivors();
        if (aliveAfter.length === 1) {
          game.phase = 'end';
        } else if (aliveAfter.length === 0) {
          game.phase = 'end';
        } else {
          game.bonusIndex++;
          // BUG FIX: was BONUS_questions.length (undefined identifier).
          if (game.bonusIndex >= bonusQuestions.length) {
            game.phase = 'end';
          } else {
            game.phase = 'question';
            resetCurrentAnswerState();
            game.eliminatedOptions = []; game.audienceTally = null;
            game.revealedCorrect = null;
            // Bonus → bonus is still "each new question", but no separate at-bonus trigger.
            refillLifelinesIfDue({ eachQuestion: true });
          }
        }
      } else {
        game.questionIndex++;
        if (game.questionIndex >= questions.length) {
          const alive = survivors();
          if (alive.length > 1) {
            game.inBonus = true;
            game.bonusIndex = 0;
            game.phase = 'question';
            resetCurrentAnswerState();
            game.eliminatedOptions = []; game.audienceTally = null;
            game.revealedCorrect = null;
            // Entering the bonus / tiebreaker round — fires both each-question
            // and at-bonus triggers (whichever the branding selected).
            refillLifelinesIfDue({ atBonus: true, eachQuestion: true });
          } else {
            game.phase = 'end';
          }
        } else {
          game.phase = 'question';
          resetCurrentAnswerState();
          game.eliminatedOptions = []; game.audienceTally = null;
          game.revealedCorrect = null;
          refillLifelinesIfDue({ eachQuestion: true });
        }
      }
      pushAll();
      break;
    }
    case 'reset-game': {
      // A01-6: rotate the join code on reset so old links don't carry over.
      game = newGame();
      pushAll();
      break;
    }
    case 'return-to-lobby': {
      // Soft reset for the "I clicked Start Game too early" scenario.
      // Only valid while we're still in Q1 with everyone alive — once anyone
      // has been eliminated, the host should use Reset (New Game) instead.
      if (game.phase !== 'question' || game.questionIndex !== 0) {
        logEvent('warn', 'return-to-lobby refused — not at Q1 question phase');
        return;
      }
      const allAlive = [...game.players.values()].every(p => p.alive);
      if (!allAlive) {
        logEvent('warn', 'return-to-lobby refused — at least one player already eliminated');
        return;
      }
      game.phase = 'lobby';
      game.questionIndex = 0;
      resetCurrentAnswerState();
      game.eliminatedOptions = [];
      game.audienceTally = null;
      game.revealedCorrect = null;
      // Wipe any history entries from the aborted Q1 (there shouldn't be any
      // because history only writes on close-question, but be defensive).
      game.players.forEach(p => { p.history = []; p.answeredScore = 0; });
      logEvent('admin', 'Returned to lobby (game restarted, players retained)');
      pushAll();
      break;
    }
    case 'kick-player': {
      const pid = payload.playerId;
      const p = game.players.get(pid);
      if (p) {
        if (p.ws && p.ws.readyState === 1) p.ws.close();
        game.players.delete(pid);
        game.currentAnswers.delete(pid);
        pushAll();
      }
      break;
    }
  }
}

// --- Admin actions ---
function adminAction(action, payload = {}, adminWs = null) {
  switch (action) {
    case 'questions:update': {
      if (game.phase !== 'lobby' && game.phase !== 'end') {
        if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'Questions can only be edited in lobby or after game end.' }));
        return;
      }
      let bank;
      try {
        bank = normalizeQuestionBank(
          { main: payload.main, bonus: payload.bonus },
          { label: 'question bank', requireBonusKey: true }
        );
      } catch (e) {
        if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'Question validation failed: ' + e.message }));
        return;
      }
      questions = bank.main;
      bonusQuestions = bank.bonus;
      saveQuestionsToDisk();
      logEvent('admin', `Questions updated (${questions.length} main, ${bonusQuestions.length} bonus)`);
      broadcast({ type: 'admin:questions', questions, bonusQuestions }, c => c.role === 'admin');
      pushAll();
      break;
    }
    case 'questions:import-csv': {
      if (game.phase !== 'lobby' && game.phase !== 'end') {
        if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'CSV import only allowed in lobby or after game end.' }));
        return;
      }
      try {
        const bank = normalizeQuestionBank(questionsFromCsv(payload.csv || ''), {
          label: 'CSV import',
          requireMain: true
        });
        questions = bank.main;
        bonusQuestions = bank.bonus;
        saveQuestionsToDisk();
        logEvent('admin', `Questions imported from CSV (${questions.length} main, ${bonusQuestions.length} bonus)`);
        broadcast({ type: 'admin:questions', questions, bonusQuestions }, c => c.role === 'admin');
        pushAll();
        if (adminWs) adminWs.send(JSON.stringify({ type: 'questions:imported', mainCount: questions.length, bonusCount: bonusQuestions.length }));
      } catch (e) {
        if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'CSV import failed: ' + e.message }));
      }
      break;
    }
    case 'samples:list': {
      // Fetch the manifest from SAMPLE_PACKS_URL and return a slim catalogue.
      // Async — runs on the same tick as the admin action.
      (async () => {
        try {
          const manifest = await fetchSampleJson(SAMPLE_PACKS_URL);
          if (!manifest || !Array.isArray(manifest.packs)) {
            throw new Error('manifest missing "packs" array');
          }
          const packs = manifest.packs
            .filter(p => p && typeof p.id === 'string' && typeof p.url === 'string')
            .map(p => ({
              id: String(p.id).slice(0, 80),
              title: String(p.title || p.id).slice(0, 120),
              category: String(p.category || '').toLowerCase().slice(0, 40),
              description: String(p.description || '').slice(0, 400),
              url: String(p.url),
              mainCount: Number(p.questions || p.main || 0) || null,
              bonusCount: Number(p.bonus || 0) || null,
            }));
          if (adminWs) adminWs.send(JSON.stringify({ type: 'samples:list', sourceUrl: SAMPLE_PACKS_URL, packs }));
        } catch (e) {
          if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'Sample browse failed: ' + e.message }));
        }
      })();
      break;
    }

    case 'samples:load': {
      if (game.phase !== 'lobby' && game.phase !== 'end') {
        if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'Sample load only allowed in lobby or after game end.' }));
        return;
      }
      const packId = String((payload && payload.packId) || '').slice(0, 80);
      if (!packId) {
        if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'Missing packId.' }));
        return;
      }
      (async () => {
        try {
          // Always re-fetch the manifest to resolve the pack's URL. This
          // means an admin can't be tricked into fetching arbitrary URLs —
          // only those that the manifest currently exposes.
          const manifest = await fetchSampleJson(SAMPLE_PACKS_URL);
          const pack = (manifest && Array.isArray(manifest.packs))
            ? manifest.packs.find(p => p && p.id === packId)
            : null;
          if (!pack) throw new Error('pack id not found in manifest');
          const data = await fetchSampleJson(pack.url);
          const bank = normalizeQuestionBank(data, {
            label: `sample pack "${packId}"`,
            requireMain: true
          });
          questions       = bank.main;
          bonusQuestions  = bank.bonus;
          saveQuestionsToDisk();
          // Update branding category/title/tagline from the pack metadata —
          // gives operators a one-click "load nature quiz" experience.
          const next = { ...branding };
          if (typeof data.title === 'string')    next.quizTitle    = data.title;
          if (typeof data.category === 'string') next.quizCategory = data.category;
          if (typeof data.tagline === 'string')  next.tagline      = data.tagline;
          try {
            const validated = validateBranding(next, { tolerant: true });
            saveBranding(validated);
            branding = validated;
            broadcast({ type: 'branding:updated' });
          } catch (e) { /* ignore branding update failures, questions still load */ }
          logEvent('admin', `Loaded sample pack "${pack.title}" (${questions.length} main, ${bonusQuestions.length} bonus)`);
          broadcast({ type: 'admin:questions', questions, bonusQuestions }, c => c.role === 'admin');
          pushAll();
          if (adminWs) adminWs.send(JSON.stringify({
            type: 'samples:loaded',
            pack: { id: pack.id, title: data.title || pack.title, category: data.category || pack.category || '' },
            mainCount: questions.length,
            bonusCount: bonusQuestions.length,
          }));
        } catch (e) {
          if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'Pack load failed: ' + e.message }));
        }
      })();
      break;
    }

    case 'questions:reset-defaults': {
      if (game.phase !== 'lobby' && game.phase !== 'end') {
        if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'Reset only allowed in lobby or after game end.' }));
        return;
      }
      const bank = normalizeQuestionBank({
        main: JSON.parse(JSON.stringify(DEFAULT_QUESTIONS)),
        bonus: JSON.parse(JSON.stringify(DEFAULT_BONUS))
      }, { label: 'bundled question bank', requireMain: true });
      questions = bank.main;
      bonusQuestions = bank.bonus;
      saveQuestionsToDisk();
      logEvent('admin', `Sample questions loaded (${questions.length} main, ${bonusQuestions.length} bonus)`);
      broadcast({ type: 'admin:questions', questions, bonusQuestions }, c => c.role === 'admin');
      pushAll();
      break;
    }
    case 'player:kick': {
      const p = game.players.get(payload.playerId);
      if (!p) return;
      if (p.ws && p.ws.readyState === 1) {
        try { p.ws.send(JSON.stringify({ type: 'kicked', reason: payload.reason || 'Removed by admin' })); } catch {}
        p.ws.close();
      }
      const name = p.name;
      game.players.delete(p.id);
      game.currentAnswers.delete(p.id);
      logEvent('admin', `Kicked: ${name}`, { playerId: p.id });
      pushAll();
      break;
    }
    case 'player:set-alive': {
      const p = game.players.get(payload.playerId);
      if (!p) return;
      p.alive = !!payload.alive;
      logEvent('admin', `${p.name} marked ${p.alive ? 'ALIVE' : 'ELIMINATED'} (manual)`, { playerId: p.id });
      pushAll();
      break;
    }
    case 'player:set-score': {
      const p = game.players.get(payload.playerId);
      if (!p) return;
      const s = parseInt(payload.score, 10);
      if (isNaN(s) || s < 0) return;
      p.answeredScore = s;
      logEvent('admin', `${p.name} score set to ${s}`, { playerId: p.id });
      pushAll();
      break;
    }
    case 'player:force-reconnect-window': {
      const p = game.players.get(payload.playerId);
      if (!p) return;
      p.disconnectedAt = Date.now();
      scheduleReconnectExpiryPush(p.id);
      logEvent('admin', `Reconnect window extended for ${p.name}`, { playerId: p.id });
      pushAll();
      break;
    }
    case 'player:clear-disconnect': {
      const p = game.players.get(payload.playerId);
      if (!p) return;
      p.disconnectedAt = null;
      logEvent('admin', `Disconnect flag cleared for ${p.name}`, { playerId: p.id });
      pushAll();
      break;
    }
    case 'game:host-action': {
      hostAction(payload.hostAction, payload.hostPayload || {});
      logEvent('admin', `Admin fired host action: ${payload.hostAction}`);
      break;
    }

    case 'auth:mint-magic-link': {
      // Re-issue a single-use magic-link URL for the requested role. Useful when
      // the original boot-time URL has expired or been consumed.
      const wantRole = payload && payload.role === 'admin' ? 'admin' : 'host';
      const token = mintMagicToken(wantRole);
      if (wantRole === 'admin') ADMIN_MAGIC = token; else HOST_MAGIC = token;
      const url = getPublicBaseUrl(null) + '/auth/magic?t=' + token;
      logEvent('admin', `Magic link re-issued for role=${wantRole}`);
      if (adminWs) adminWs.send(JSON.stringify({ type: 'auth:magic-link', role: wantRole, token, url, ttlMs: MAGIC_TTL_MS }));
      break;
    }

    case 'branding:update': {
      try {
        const prevPublicBase = branding.publicBaseUrl;
        const incoming = payload.branding && typeof payload.branding === 'object' ? payload.branding : {};
        const next = validateBranding({ ...branding, ...incoming }, { tolerant: false });
        saveBranding(next);
        branding = next;
        logEvent('admin', `Branding updated (company="${branding.companyName}", domain="${branding.companyDomain}", restrict=${branding.restrictDomain}, publicBaseUrl="${branding.publicBaseUrl}")`);
        // Broadcast to every connected client; they re-fetch /branding.json.
        broadcast({ type: 'branding:updated' });
        if (adminWs) adminWs.send(JSON.stringify({ type: 'branding:saved', branding }));
        // If the public URL changed, log a fresh banner so operations / deploy
        // logs show the new clickable URLs.
        if (prevPublicBase !== branding.publicBaseUrl) {
          printBanner('publicBaseUrl changed via admin');
        }
      } catch (e) {
        if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'Branding update rejected: ' + e.message }));
      }
      break;
    }

    // Session close / reopen — flips branding.sessionClosed and broadcasts so
    // every connected client re-fetches /branding.json and shows the right view.
    // Closing rejects new player joins; existing players (still in game.players)
    // can keep their WS connection alive to view their results.
    case 'session:close':
    case 'session:reopen': {
      const wantClosed = (action === 'session:close');
      try {
        const next = validateBranding({ ...branding, sessionClosed: wantClosed }, { tolerant: false });
        saveBranding(next);
        branding = next;
        logEvent('admin', wantClosed
          ? `Session closed by admin — new player joins blocked`
          : `Session reopened by admin`);
        broadcast({ type: 'branding:updated' });
        if (adminWs) adminWs.send(JSON.stringify({ type: 'branding:saved', branding }));
      } catch (e) {
        if (adminWs) adminWs.send(JSON.stringify({ type: 'error', error: 'Session ' + (wantClosed ? 'close' : 'reopen') + ' failed: ' + e.message }));
      }
      break;
    }

    // Admin-initiated process shutdown / restart. Both go through
    // gracefulShutdown(), but with different `final` flags so the client banner
    // and reconnect behaviour differ:
    //   admin:shutdown  → final=true  (clients show "session ended", stop reconnect loop)
    //   admin:restart   → final=false (clients show "reconnecting…", keep retrying)
    //
    // Rate-limited: at most one shutdown/restart per 30s per admin session,
    // so a compromised cookie can't trivially DoS the service.
    case 'admin:shutdown':
    case 'admin:restart': {
      const now = Date.now();
      const sid = adminWs && adminWs.sessionId || 'unknown';
      const last = lastShutdownAt.get(sid) || 0;
      if (now - last < SHUTDOWN_COOLDOWN_MS) {
        if (adminWs) adminWs.send(JSON.stringify({
          type: 'error',
          error: `Please wait ${Math.ceil((SHUTDOWN_COOLDOWN_MS - (now - last)) / 1000)}s before triggering another shutdown.`
        }));
        break;
      }
      lastShutdownAt.set(sid, now);
      const isShutdown = (action === 'admin:shutdown');
      const reason = typeof payload.reason === 'string' && payload.reason.trim().slice(0, 200);
      logEvent('admin', `${isShutdown ? 'Shutdown' : 'Restart'} requested by admin (session=${sid})`);
      if (adminWs) adminWs.send(JSON.stringify({ type: 'admin:shutdown-ack', mode: isShutdown ? 'shutdown' : 'restart' }));
      // Defer slightly so the ack flushes before we tear down the WS.
      setTimeout(() => {
        gracefulShutdown(isShutdown ? 'ADMIN_SHUTDOWN' : 'ADMIN_RESTART', {
          final: isShutdown,
          reason: reason || undefined
        });
      }, 100);
      break;
    }
  }
}

// Rate-limit cache for admin:shutdown / admin:restart — keyed by admin session
// id. Stale entries are pruned in-place when the map grows past 16, which is
// way more headroom than the realistic number of concurrent admin sessions.
const lastShutdownAt = new Map();
const SHUTDOWN_COOLDOWN_MS = 30_000;

// --- WebSocket handlers ---
// On upgrade, read the role from the signed session cookie. Players are unauthenticated.
wss.on('connection', (ws, req) => {
  const session = sessionFromReq(req);
  ws.role = session ? session.role : null;
  // Carry the session id so admin actions can be rate-limited per-session
  // (a compromised cookie can otherwise spam destructive admin actions). The
  // session id never appears in `getSession()`'s return object, so reach for
  // the cookie directly here.
  ws.sessionId = (function(){
    try {
      const cookies = parseCookies(req.headers.cookie || '');
      return unpackCookie(cookies.omegaquiz_sess) || null;
    } catch { return null; }
  })();
  // Cache the IP at upgrade time — req.headers / req.socket stay stable for
  // the lifetime of the WS, so we don't need to recompute per message.
  ws.clientIp = getClientIp(req);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'host:hello') {
      if (ws.role !== 'host' && ws.role !== 'admin') {
        ws.send(JSON.stringify({ type: 'error', error: 'Not signed in as host' }));
        ws.close();
        return;
      }
      pushHostState();
      return;
    }

    if (msg.type === 'admin:hello') {
      if (ws.role !== 'admin') {
        ws.send(JSON.stringify({ type: 'error', error: 'Not signed in as admin' }));
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: 'admin:init', questions, bonusQuestions, eventLog }));
      pushAdminState();
      return;
    }

    if (msg.type === 'admin:action' && ws.role === 'admin') {
      adminAction(msg.action, msg.payload || {}, ws);
      return;
    }

    if (msg.type === 'host:action' && (ws.role === 'host' || ws.role === 'admin')) {
      hostAction(msg.action, msg.payload || {});
      return;
    }

    if (msg.type === 'player:join') {
      const { name, email, joinCode, reconnectId } = msg;
      const ip = ws.clientIp || 'unknown';
      // S2: per-IP rate limit. Reject before doing any work — the 6-digit
      // join code space is still brute-forceable in minutes without throttling.
      if (isJoinBlocked(ip)) {
        logJson('warn', 'player.join.rate-limited', { ip });
        ws.send(JSON.stringify({ type: 'error', error: 'Too many join attempts from this network. Please wait a few minutes and try again.' }));
        return;
      }
      // Session closed: reject new joins. Existing players reconnecting with
      // a valid reconnectId fall through to the reconnect branch below — that's
      // intentional so they can still view their results.
      if (branding.sessionClosed && !(reconnectId && game.players.has(reconnectId))) {
        ws.send(JSON.stringify({ type: 'error', error: 'This session has ended. Reach out to the facilitator if this is unexpected.' }));
        return;
      }
      if (joinCode !== game.joinCode) {
        recordJoinFailure(ip);
        logEvent('auth-fail', `player:join rejected — wrong join code from ${ip}`);
        logJson('warn', 'player.join.wrong-code', { ip });
        ws.send(JSON.stringify({ type: 'error', error: 'Wrong join code' }));
        return;
      }
      if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Name and a valid email are required' }));
        return;
      }
      // Branding: optionally restrict joins to the configured company domain.
      if (branding.restrictDomain && branding.companyDomain) {
        const emailDomain = String(email).trim().toLowerCase().split('@')[1] || '';
        if (emailDomain !== branding.companyDomain) {
          ws.send(JSON.stringify({ type: 'error', error: `Please use your ${branding.companyDomain} email address.` }));
          return;
        }
      }
      // A01-5: reconnect only when supplied (name, email) match the stored player.
      if (reconnectId && game.players.has(reconnectId)) {
        const p = game.players.get(reconnectId);
        const sameEmail = p.email.toLowerCase() === String(email).trim().toLowerCase();
        const sameName  = p.name === String(name).trim().slice(0, 40);
        if (sameEmail && sameName && isWithinReconnectWindow(p)) {
          p.ws = ws;
          p.disconnectedAt = null;
          p.lastSeen = Date.now();
          ws.role = 'player';
          ws.playerId = p.id;
          ws.send(JSON.stringify({ type: 'player:joined', playerId: p.id, name: p.name }));
          logEvent('reconnect', `${p.name} reconnected`, { playerId: p.id });
          pushAll();
          return;
        }
      }
      if (game.phase !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', error: 'The game has already started — joining is closed.' }));
        return;
      }
      const dup = [...game.players.values()].find(p => p.email.toLowerCase() === email.toLowerCase());
      if (dup) {
        ws.send(JSON.stringify({ type: 'error', error: 'That email is already registered for this game.' }));
        return;
      }
      // A02-3: CSPRNG player id.
      const id = 'p_' + crypto.randomBytes(12).toString('hex');
      const player = {
        id, name: name.trim().slice(0, 40), email: email.trim().toLowerCase(),
        alive: true, answeredScore: 0, history: [], ws, disconnectedAt: null,
        joinedAt: Date.now(), lastSeen: Date.now()
      };
      game.players.set(id, player);
      ws.role = 'player';
      ws.playerId = id;
      // Successful join clears any prior rate-limit strikes for this IP.
      clearJoinFailures(ip);
      ws.send(JSON.stringify({ type: 'player:joined', playerId: id, name: player.name }));
      logEvent('join', `${player.name} (${player.email}) joined`, { playerId: id });
      pushAll();
      return;
    }

    if (msg.type === 'player:answer' && ws.role === 'player') {
      const p = game.players.get(ws.playerId);
      // Eliminated players can submit only when the admin has enabled
      // engagement mode. They never score or revive — their picks just
      // appear in the audience tally.
      if (!p || (!p.alive && !branding.eliminatedCanAnswer)) return;
      if (game.phase !== 'question') return;
      const idx = msg.answerIndex;
      if (![0,1,2,3].includes(idx)) return;
      if (game.eliminatedOptions.includes(idx)) return;
      // Track "changes" — when the player overrides a previous answer with a
      // different option on the same question.
      if (game.currentAnswers.has(p.id) && game.currentAnswers.get(p.id) !== idx) {
        game.changesThisQuestion++;
        game.playersChangedThisQuestion.add(p.id);
      }
      game.currentAnswers.set(p.id, idx);
      p.lastSeen = Date.now();
      pushAll();
      return;
    }

    if (msg.type === 'player:lifeline-vote' && ws.role === 'player') {
      if (!game.lifelineActive) return;
      const p = game.players.get(ws.playerId);
      if (!p || !p.alive) return;
      const t = msg.lifelineType;
      if (!['5050','askit','skip'].includes(t)) return;
      // Reject votes for lifelines that have already been spent this round —
      // shouldn't happen if the client is well-behaved, but a malicious client
      // could try to push a vote for an unavailable type to skew the tally.
      if (game.lifelinesUsed && game.lifelinesUsed[t]) return;
      game.lifelineActive.votes.set(p.id, t);
      pushAll();
      return;
    }
  });

  ws.on('close', () => {
    if (ws.role === 'player' && ws.playerId) {
      const p = game.players.get(ws.playerId);
      if (p) {
        p.ws = null;
        p.disconnectedAt = Date.now();
        logEvent('disconnect', `${p.name} disconnected`, { playerId: p.id });
        scheduleReconnectExpiryPush(p.id);
        pushAll();
      }
    }
  });
});

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------

// --- Auth flow (A01-1, A07-1) ---
app.get('/auth/login', (req, res) => {
  const role = req.query.role === 'admin' ? 'admin' : 'host';
  const nextRaw = typeof req.query.next === 'string' ? req.query.next : ('/' + role);
  const safeNext = /^\/[A-Za-z0-9_\-./?=&%]*$/.test(nextRaw) ? nextRaw : ('/' + role);
  const error = req.query.error ? '<p class="err">Invalid token. Try again.</p>' : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Omega Quiz</title>
<style>
  body{margin:0;font-family:Georgia,serif;background:#020625;color:#f5f3e8;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:rgba(13,26,110,.6);border:2px solid #f4c430;border-radius:16px;padding:28px 30px;width:min(460px,92vw);box-shadow:0 0 24px rgba(244,196,48,.25)}
  h1{color:#f4c430;font-size:18px;letter-spacing:.2em;text-transform:uppercase;margin:0 0 6px;text-align:center}
  .sub{color:#bdc4eb;font-size:12px;letter-spacing:.2em;text-transform:uppercase;text-align:center;margin-bottom:18px}
  :focus-visible{outline:2px solid #ffd700;outline-offset:2px}
  label{display:block;color:#bdc4eb;font-size:12px;letter-spacing:.15em;text-transform:uppercase;margin:12px 0 6px}
  .token-row{display:flex;gap:6px;align-items:stretch}
  .token-row input{flex:1;padding:12px 14px;background:rgba(0,0,0,.4);border:1px solid #8a6d10;border-radius:10px;color:#f5f3e8;font-family:'Courier New',monospace;font-size:14px;letter-spacing:.05em;box-sizing:border-box;min-width:0}
  .token-row input:focus{border-color:#f4c430;box-shadow:0 0 12px rgba(244,196,48,.25)}
  .icon-btn{flex:0 0 auto;padding:0 12px;background:transparent;border:1px solid #8a6d10;border-radius:10px;color:#f4c430;font-family:Georgia,serif;font-size:12px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
  .icon-btn:hover{border-color:#f4c430;background:rgba(244,196,48,.08)}
  .submit-btn{width:100%;padding:13px;margin-top:18px;background:linear-gradient(180deg,#ffd700,#8a6d10);color:#020625;font-weight:bold;font-size:14px;letter-spacing:.2em;text-transform:uppercase;border:none;border-radius:10px;cursor:pointer;font-family:Georgia,serif}
  .hint{color:#9aa3d4;font-size:11px;text-align:center;margin-top:10px;letter-spacing:.05em}
  .err{color:#fca5a5;font-size:13px;text-align:center;margin:10px 0 0}
  .recovery-note{background:rgba(244,196,48,.08);border:1px solid #8a6d10;border-radius:8px;padding:9px 12px;color:#d8c684;font-size:12px;line-height:1.45;margin-bottom:8px}
  .muted-inline{color:#9aa3d4;font-size:11px;font-weight:normal;letter-spacing:0;text-transform:none}
</style></head><body>
<form class="card" id="loginForm" method="POST" action="/auth/login" autocomplete="off">
  <h1>Omega Quiz</h1><div class="sub">${role === 'admin' ? 'Admin recovery sign-in' : 'Host recovery sign-in'}</div>
  <div class="recovery-note">Use this form when your magic-link URL has expired. Most of the time you should just click the magic link from the server logs.</div>
  <input type="hidden" name="role" value="${role}">
  <input type="hidden" name="next" value="${safeNext.replace(/"/g, '&quot;')}">
  <label for="token">${role === 'admin' ? 'ADMIN_TOKEN' : 'HOST_TOKEN'} <span class="muted-inline">(recovery token)</span></label>
  <div class="token-row">
    <input id="token" name="token" type="password" autofocus
           autocomplete="one-time-code" inputmode="text"
           spellcheck="false" autocapitalize="off" autocorrect="off">
    <button type="button" class="icon-btn" id="toggleBtn" title="Show / hide token" aria-label="Show token">Show</button>
    <button type="button" class="icon-btn" id="pasteBtn"  title="Paste from clipboard">Paste</button>
  </div>
  <div class="hint">Paste with ⌘V / Ctrl+V, or click <strong>Paste</strong>. Spaces and newlines are stripped automatically.</div>
  <button class="submit-btn" type="submit">Sign in</button>
  ${error}
</form>
<script nonce="${res.locals.cspNonce || ''}">
  // Defensive: trim whitespace/newlines so a stray copy from the terminal still works.
  const tokenEl = document.getElementById('token');
  tokenEl.addEventListener('input', () => {
    const trimmed = tokenEl.value.replace(/[\\s\\r\\n]+/g, '');
    if (trimmed !== tokenEl.value) tokenEl.value = trimmed;
  });
  // Form submit safety net (covers paste-then-Enter without an intermediate input event).
  document.getElementById('loginForm').addEventListener('submit', () => {
    tokenEl.value = tokenEl.value.replace(/[\\s\\r\\n]+/g, '');
  });
  // Show / hide toggle — useful for verifying a paste worked.
  const toggleBtn = document.getElementById('toggleBtn');
  toggleBtn.addEventListener('click', () => {
    const showing = tokenEl.type === 'text';
    tokenEl.type = showing ? 'password' : 'text';
    toggleBtn.textContent = showing ? 'Show' : 'Hide';
    tokenEl.focus();
  });
  // Paste button — sidesteps password manager / extension interference.
  document.getElementById('pasteBtn').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      tokenEl.value = t.replace(/[\\s\\r\\n]+/g, '');
      tokenEl.focus();
    } catch (e) {
      alert('Clipboard read was blocked by the browser. Click into the token field and press ⌘V / Ctrl+V instead.');
    }
  });
</script>
</body></html>`);
});

app.post('/auth/login', (req, res) => {
  const ip = getClientIp(req);
  if (isBlocked(ip)) {
    logJson('warn', 'auth.login.rate-limited', { ip, role: req.body && req.body.role });
    return res.status(429).type('text/plain').send('Too many failed sign-in attempts. Try again later.');
  }
  const role = req.body && req.body.role === 'admin' ? 'admin' : 'host';
  // Trim incidental whitespace/newlines (e.g. from terminal copy-paste).
  const token = String((req.body && req.body.token) || '').replace(/[\s\r\n]+/g, '');
  const expected = role === 'admin' ? ADMIN_TOKEN : HOST_TOKEN;
  if (!tokensEqual(token, expected)) {
    recordLoginFailure(ip);
    logEvent('auth-fail', `Login failed for role=${role} from ${ip}`);
    logJson('warn', 'auth.login.fail', { ip, role });
    return res.redirect(302, '/auth/login?role=' + role + '&error=1');
  }
  clearLoginFailures(ip);
  const sid = createSession(role, ip);
  setSessionCookie(req, res, sid);
  logEvent('auth-ok', `Signed in as ${role} from ${ip}`);
  logJson('info', 'auth.login.ok', { ip, role });
  const next = typeof req.body.next === 'string' && /^\/[A-Za-z0-9_\-./?=&%]*$/.test(req.body.next) ? req.body.next : ('/' + role);
  res.redirect(302, next);
});

// Magic-link login: GET /auth/magic?t=XYZ
// Consumes the token (single-use), sets a session cookie, redirects to the role's page.
app.get('/auth/magic', (req, res) => {
  const ip = getClientIp(req);
  if (isBlocked(ip)) {
    return res.status(429).type('text/plain').send('Too many failed sign-in attempts. Try again later.');
  }
  const t = typeof req.query.t === 'string' ? req.query.t : '';
  const entry = consumeMagicToken(t);
  if (!entry) {
    recordLoginFailure(ip);
    logEvent('auth-fail', `Magic-link login failed (expired/invalid/used) from ${ip}`);
    return res.redirect(302, '/auth/login?role=host&error=1');
  }
  clearLoginFailures(ip);
  const sid = createSession(entry.role, ip);
  setSessionCookie(req, res, sid);
  logEvent('auth-ok', `Signed in via magic-link as ${entry.role} from ${ip}`);
  res.redirect(302, '/' + entry.role);
});

app.post('/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const id = unpackCookie(cookies.omegaquiz_sess);
  deleteSession(id);
  clearSessionCookie(res);
  res.redirect(302, '/');
});
app.get('/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const id = unpackCookie(cookies.omegaquiz_sess);
  deleteSession(id);
  clearSessionCookie(res);
  res.redirect(302, '/');
});

// Player join page (public). Served through the nonce helper so the CSP
// stays tight without `'unsafe-inline'` on script-src.
app.get('/', (req, res) => serveHtmlWithNonce('index.html', res));

// Protected pages
app.get('/host',  requireRole('host', 'admin'), (req, res) => {
  serveHtmlWithNonce('host.html', res);
});
app.get('/admin', requireRole('admin'), (req, res) => {
  serveHtmlWithNonce('admin.html', res);
});

// Health check — PaaS providers (Fly, Render, Railway) poll this to decide
// whether the instance is ready for traffic. Returns 200 when the server is
// fully initialised; 503 if startup state is incomplete (e.g. shutting down).
// Deliberately lightweight: no auth, no rate limit, no allocations beyond
// the JSON serialise. Question-bank emptiness is NOT a failure — a fresh
// deploy is expected to boot with no questions until the admin imports.
const BOOT_TIME = Date.now();
app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (shuttingDown) {
    return res.status(503).json({ ok: false, reason: 'shutting down' });
  }
  res.status(200).json({
    ok: true,
    uptimeSec: Math.floor((Date.now() - BOOT_TIME) / 1000),
    questionsLoaded: questions.length,
    bonusLoaded: bonusQuestions.length,
    phase: game.phase,
    players: game.players.size
  });
});

// Public branding info — needed by the unauthenticated player join screen.
// We do NOT expose any secrets here. companyName / domain / logo are all meant
// to be public-facing brand assets.
app.get('/branding.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json(branding);
});

// QR encodes the live join code, so keep it behind host/admin auth.
// The hosted display has the session cookie and can still load it normally.
app.get('/qr', requireRole('host', 'admin'), async (req, res) => {
  const base = getPublicBaseUrl(req);
  const url = `${base}/?code=${game.joinCode}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#f4c430', light: '#020625' } });
    res.set('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (e) {
    res.status(500).send('QR error');
  }
});

// CSV export (PII!) — admin only, with formula-injection guard.
// Wide format: one row per player, with summary columns plus an (Answer, Result)
// pair per main and per bonus question. Result is one of:
//   "correct" / "wrong" / "no answer"  — with "(eliminated)" appended if the
//   player was already out at the time (engagement mode).
function formatHistoryResult(h) {
  if (!h || h.answer == null) return 'no answer';
  const tag = h.wasAlive ? '' : ' (eliminated)';
  return (h.correct ? 'correct' : 'wrong') + tag;
}
app.get('/results.csv', requireRole('admin'), (req, res) => {
  const mainCount  = questions.length;
  const bonusCount = bonusQuestions.length;
  const header = [
    'Name', 'Email',
    'Score (in-race correct)',
    'Total correct (all answers)',
    'Total answered',
    'Survived to End',
    'Status',
  ];
  for (let i = 1; i <= mainCount;  i++) { header.push('Q' + i + ' answer'); header.push('Q' + i + ' result'); }
  for (let i = 1; i <= bonusCount; i++) { header.push('B' + i + ' answer'); header.push('B' + i + ' result'); }
  const rows = [header.map(csvField)];

  [...game.players.values()]
    .sort((a, b) => b.answeredScore - a.answeredScore)
    .forEach(p => {
      const status = p.alive ? (game.phase === 'end' ? 'WINNER / FINALIST' : 'still alive') : 'eliminated';
      const history = p.history || [];
      const totalCorrect  = history.reduce((n, h) => n + (h.correct ? 1 : 0), 0);
      const totalAnswered = history.reduce((n, h) => n + (h.answer != null ? 1 : 0), 0);
      // Build a label → history-entry index so we can render in question order
      // even if (hypothetically) entries are out-of-order.
      const byLabel = {};
      history.forEach(h => { byLabel[h.label] = h; });

      const row = [
        csvField(p.name),
        csvField(p.email),
        csvField(p.answeredScore),
        csvField(totalCorrect),
        csvField(totalAnswered),
        csvField(p.alive ? 'Yes' : 'No'),
        csvField(status),
      ];
      for (let i = 1; i <= mainCount; i++) {
        const h = byLabel['Q' + i];
        row.push(csvField(h && h.answer != null ? 'ABCD'[h.answer] : '—'));
        row.push(csvField(formatHistoryResult(h)));
      }
      for (let i = 1; i <= bonusCount; i++) {
        const h = byLabel['B' + i];
        row.push(csvField(h && h.answer != null ? 'ABCD'[h.answer] : '—'));
        row.push(csvField(formatHistoryResult(h)));
      }
      rows.push(row);
    });
  const csv = rows.map(r => r.join(',')).join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="quiz-results-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

// Excel export — same shape as /results.csv but with cell-level fills:
//   green   = correct answer
//   red     = wrong answer
//   amber   = no answer
//   muted shades + italic = "(eliminated)" variants
// File is built inline (no deps); open it in Excel / Numbers / LibreOffice.
app.get('/results.xlsx', requireRole('admin'), (req, res) => {
  const mainCount  = questions.length;
  const bonusCount = bonusQuestions.length;

  const headerLabels = [
    'Name', 'Email',
    'Score (in-race correct)',
    'Total correct (all answers)',
    'Total answered',
    'Survived to End',
    'Status',
  ];
  for (let i = 1; i <= mainCount;  i++) { headerLabels.push('Q' + i + ' answer'); headerLabels.push('Q' + i + ' result'); }
  for (let i = 1; i <= bonusCount; i++) { headerLabels.push('B' + i + ' answer'); headerLabels.push('B' + i + ' result'); }
  const headers = headerLabels.map(label => ({ v: label, s: 1 }));

  // Style indexes: 0=plain, 2=correct, 3=wrong, 4=no-answer,
  //                5=correct(elim), 6=wrong(elim), 7=numeric.
  function styleFor(h) {
    if (!h || h.answer == null) return 4;
    if (h.correct)              return h.wasAlive ? 2 : 5;
    return h.wasAlive ? 3 : 6;
  }
  function resultText(h) {
    if (!h || h.answer == null) return 'no answer';
    const tag = h.wasAlive ? '' : ' (eliminated)';
    return (h.correct ? 'correct' : 'wrong') + tag;
  }

  const rows = [];
  [...game.players.values()]
    .sort((a, b) => b.answeredScore - a.answeredScore)
    .forEach(p => {
      const status = p.alive ? (game.phase === 'end' ? 'WINNER / FINALIST' : 'still alive') : 'eliminated';
      const history = p.history || [];
      const totalCorrect  = history.reduce((n, h) => n + (h.correct ? 1 : 0), 0);
      const totalAnswered = history.reduce((n, h) => n + (h.answer != null ? 1 : 0), 0);
      const byLabel = {};
      history.forEach(h => { byLabel[h.label] = h; });

      const row = [
        { v: p.name, s: 0 },
        { v: p.email, s: 0 },
        { v: p.answeredScore, s: 7, t: 'n' },
        { v: totalCorrect,    s: 7, t: 'n' },
        { v: totalAnswered,   s: 7, t: 'n' },
        { v: p.alive ? 'Yes' : 'No', s: 0 },
        { v: status, s: 0 },
      ];
      for (let i = 1; i <= mainCount; i++) {
        const h = byLabel['Q' + i];
        const style = styleFor(h);
        row.push({ v: h && h.answer != null ? 'ABCD'[h.answer] : '—', s: style });
        row.push({ v: resultText(h),                                  s: style });
      }
      for (let i = 1; i <= bonusCount; i++) {
        const h = byLabel['B' + i];
        const style = styleFor(h);
        row.push({ v: h && h.answer != null ? 'ABCD'[h.answer] : '—', s: style });
        row.push({ v: resultText(h),                                  s: style });
      }
      rows.push(row);
    });

  const xlsx = buildXlsx(headers, rows, 'Quiz Results');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="quiz-results-${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(xlsx);
});

// Export & Wipe — one-click "we're done with this event" action. The response
// is the XLSX (so the operator must download a snapshot before the wipe lands)
// and the side-effects are: in-memory state reset, on-disk data/config.json and
// data/questions.json deleted, every connected client told to reload.
//
// Refuses mid-game (only lobby or end phases) so an accidental click can't
// wipe a session in progress.
app.post('/admin/data:wipe', requireRole('admin'), (req, res) => {
  if (game.phase !== 'lobby' && game.phase !== 'end') {
    return res.status(409).type('text/plain').send('Wipe refused — a game is in progress. End the game or return to lobby first.');
  }
  const confirm = String((req.body && req.body.confirm) || '').trim();
  if (confirm !== 'WIPE DATA') {
    return res.status(400).type('text/plain').send('Wipe refused — confirmation string did not match. Type WIPE DATA (in capitals) to confirm.');
  }

  // Build the XLSX snapshot before mutating any state. If serialisation
  // throws, we never delete anything.
  const mainCount  = questions.length;
  const bonusCount = bonusQuestions.length;
  const headerLabels = [
    'Name', 'Email',
    'Score (in-race correct)',
    'Total correct (all answers)',
    'Total answered',
    'Survived to End',
    'Status',
  ];
  for (let i = 1; i <= mainCount;  i++) { headerLabels.push('Q' + i + ' answer'); headerLabels.push('Q' + i + ' result'); }
  for (let i = 1; i <= bonusCount; i++) { headerLabels.push('B' + i + ' answer'); headerLabels.push('B' + i + ' result'); }
  const headers = headerLabels.map(label => ({ v: label, s: 1 }));
  function styleFor(h) {
    if (!h || h.answer == null) return 4;
    if (h.correct)              return h.wasAlive ? 2 : 5;
    return h.wasAlive ? 3 : 6;
  }
  function resultText(h) {
    if (!h || h.answer == null) return 'no answer';
    const tag = h.wasAlive ? '' : ' (eliminated)';
    return (h.correct ? 'correct' : 'wrong') + tag;
  }
  const rows = [];
  [...game.players.values()]
    .sort((a, b) => b.answeredScore - a.answeredScore)
    .forEach(p => {
      const status = p.alive ? (game.phase === 'end' ? 'WINNER / FINALIST' : 'still alive') : 'eliminated';
      const history = p.history || [];
      const totalCorrect  = history.reduce((n, h) => n + (h.correct ? 1 : 0), 0);
      const totalAnswered = history.reduce((n, h) => n + (h.answer != null ? 1 : 0), 0);
      const byLabel = {};
      history.forEach(h => { byLabel[h.label] = h; });
      const row = [
        { v: p.name, s: 0 },
        { v: p.email, s: 0 },
        { v: p.answeredScore, s: 7, t: 'n' },
        { v: totalCorrect,    s: 7, t: 'n' },
        { v: totalAnswered,   s: 7, t: 'n' },
        { v: p.alive ? 'Yes' : 'No', s: 0 },
        { v: status, s: 0 },
      ];
      for (let i = 1; i <= mainCount; i++) {
        const h = byLabel['Q' + i];
        const style = styleFor(h);
        row.push({ v: h && h.answer != null ? 'ABCD'[h.answer] : '—', s: style });
        row.push({ v: resultText(h),                                  s: style });
      }
      for (let i = 1; i <= bonusCount; i++) {
        const h = byLabel['B' + i];
        const style = styleFor(h);
        row.push({ v: h && h.answer != null ? 'ABCD'[h.answer] : '—', s: style });
        row.push({ v: resultText(h),                                  s: style });
      }
      rows.push(row);
    });
  let xlsx;
  try {
    xlsx = buildXlsx(headers, rows, 'Final Results');
  } catch (e) {
    return res.status(500).type('text/plain').send('Wipe aborted — could not build XLSX snapshot: ' + e.message);
  }

  // Delete on-disk files. Use unlinkSync wrapped — missing files are fine.
  for (const p of [CONFIG_PATH, QUESTIONS_PATH]) {
    try { fs.unlinkSync(p); } catch (e) { /* ENOENT is fine */ }
  }

  // Reset in-memory state. New game (new join code, empty players), default
  // branding, empty question bank.
  game = newGame();
  branding = brandingFromEnv();    // env-driven defaults; respects CONSENT_TEXT etc.
  questions = [];
  bonusQuestions = [];

  // Kick all live player sockets; the dashboard reload (triggered via WS)
  // will pull a fresh state push for the operator.
  wss.clients.forEach(c => {
    if (c.role === 'player') {
      try { c.send(JSON.stringify({ type: 'kicked', reason: 'Session ended — data wiped' })); } catch {}
      try { c.close(); } catch {}
    }
  });

  logEvent('admin', 'Data wiped — config.json + questions.json removed, state reset');
  broadcast({ type: 'data-wipe:done' }, c => c.role === 'admin' || c.role === 'host');
  broadcast({ type: 'branding:updated' });

  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="omegaquiz-final-${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(xlsx);
});

// Question bank as CSV — admin only.
app.get('/questions.csv', requireRole('admin'), (req, res) => {
  const csv = questionsToCsv(questions, bonusQuestions);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="omegaquiz-questions.csv"');
  res.send(csv);
});

// Blank template (admin only — keeps the file behind auth so it's the same
// flow as the export, but the content is non-sensitive).
app.get('/questions-template.csv', requireRole('admin'), (req, res) => {
  const csv = stringifyCsv([
    CSV_HEADERS,
    [
      'main',
      'Sample question — replace this row with your own.',
      'First option', 'Second option', 'Third option', 'Fourth option',
      'B',
      'Lesson / explanation shown to players after the reveal.'
    ],
    [
      'bonus',
      'Sample tiebreaker — used only if multiple players survive all 10.',
      'Option A', 'Option B', 'Option C', 'Option D',
      'A',
      'Tiebreaker lesson.'
    ]
  ]);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="omegaquiz-template.csv"');
  res.send(csv);
});

// Lesson recap — host or admin (host uses this for the post-game review screen).
app.get('/lessons.json', requireRole('host', 'admin'), (req, res) => {
  res.json({
    main:  questions.map(q => ({ q: q.q, options: q.options, correct: q.correct, lesson: q.lesson })),
    // BUG FIX: was BONUS_questions.map (undefined identifier).
    bonus: bonusQuestions.map(q => ({ q: q.q, options: q.options, correct: q.correct, lesson: q.lesson }))
  });
});

// All three HTML pages are now served through the nonce helper above. The
// static middleware would otherwise leak the un-templated `__CSP_NONCE__`
// placeholder via direct paths, so we block it explicitly. There are no
// other static assets in public/ today; this stays a 404 net.
app.use((req, res, next) => {
  if (req.path === '/host.html' || req.path === '/admin.html' || req.path === '/index.html') {
    return res.status(404).send('Not Found');
  }
  next();
});

// ----------------------------------------------------------------------------
// Start (only when invoked directly — the test harness imports this file)
// ----------------------------------------------------------------------------
// Re-usable: print the operator banner with the current public-base URL.
// Called once at startup and again whenever the admin changes publicBaseUrl
// (so deploy logs always reflect the URLs operators should click).
function printBanner(reason) {
  const base = getPublicBaseUrl(null);
  const ttlMin = Math.round(MAGIC_TTL_MS / 60_000);
  const urlSource =
    branding.publicBaseUrl ? 'admin override' :
    ENV_PUBLIC_BASE_URL    ? 'PUBLIC_BASE_URL env var' :
                             'localhost (set PUBLIC_BASE_URL or use the admin URL field)';
  console.log('========================================');
  if (reason) console.log(` [${reason}]`);
  console.log(` Omega Quiz running on port ${PORT}`);
  console.log(` Public URL:  ${base}    (source: ${urlSource})`);
  console.log(` Player URL:  ${base}/`);
  console.log(` Join code:   ${game.joinCode}`);
  console.log(` Questions:   ${questions.length} main + ${bonusQuestions.length} bonus${questions.length === 0 ? '   (empty — import a CSV or load samples from the admin Questions tab)' : ''}`);
  console.log('');
  console.log(` ──  Sign in  ─────────────────────────`);
  console.log(` Click one of these magic links from your terminal (single-use, ${ttlMin} min):`);
  console.log(`    Host  →  ${base}/auth/magic?t=${HOST_MAGIC}`);
  console.log(`    Admin →  ${base}/auth/magic?t=${ADMIN_MAGIC}`);
  console.log('');
  console.log(` Recovery sign-in (only needed if all magic links have expired):`);
  console.log(`    ${base}/auth/login?role=host    — enter HOST_TOKEN`);
  console.log(`    ${base}/auth/login?role=admin   — enter ADMIN_TOKEN`);
  if (TOKENS_AUTO_GENERATED && !reason) {
    console.log('');
    console.log(' (Dev mode — recovery tokens were auto-generated this boot. Save them somewhere safe:)');
    console.log(' HOST_TOKEN  = ' + HOST_TOKEN);
    console.log(' ADMIN_TOKEN = ' + ADMIN_TOKEN);
  } else if (!reason) {
    console.log(' (Recovery tokens configured via HOST_TOKEN / ADMIN_TOKEN env vars — not logged.)');
  }
  console.log('========================================');
}

// ----------------------------------------------------------------------------
// Graceful shutdown.
//
// PaaS providers (Railway, Fly, Render, Cloudflare Pages/Workers in front of
// our origin) send SIGTERM ~10–30 seconds before they kill the process during
// deploys, restarts, or scale-down events. Without a handler, every connected
// player's WebSocket gets dropped mid-question with no notice and the host
// projector goes blank.
//
// What we do here:
//   1. Mark shuttingDown so duplicate signals are no-ops.
//   2. Tell all connected clients via a "server:shutdown" WS broadcast so
//      they can show a "reconnecting…" banner instead of guessing.
//   3. Stop accepting new HTTP/WS connections.
//   4. Give clients ~1.5s to actually receive the message, then terminate
//      any remaining sockets.
//   5. Force-exit at 5s if the close handshake stalls.
//
// We only register the handlers when running as the entry-point — test
// harnesses that require() server.js shouldn't have the process exit out
// from under them.
// ----------------------------------------------------------------------------
let shuttingDown = false;
// `opts.exit = false` is for tests — keeps the process alive so the harness
// can verify behaviour without the runner dying. Real signal paths leave
// opts at default and exit normally.
// opts.exit   — false in tests; default true.
// opts.final  — true tells clients "session ended" (stop auto-reconnect).
//               false (default) means "rolling restart" (clients keep retrying).
// opts.reason — short string surfaced on the client banner.
function gracefulShutdown(signal, opts = {}) {
  if (shuttingDown) return null;
  shuttingDown = true;
  const shouldExit = opts.exit !== false;
  const final = opts.final === true;
  const reason = (typeof opts.reason === 'string' && opts.reason.trim())
    || (final ? 'Session ended — thanks for playing!'
              : 'Server is restarting — please reconnect in a moment.');
  logJson('info', 'graceful shutdown', { signal, final, reason });
  try { logEvent('shutdown', `received ${signal} (final=${final})`); } catch {}
  // Best-effort notify — broadcast() iterates wss.clients and is safe to call
  // even if some sockets are mid-handshake.
  try {
    broadcast({ type: 'server:shutdown', message: reason, final, reason });
  } catch (e) { /* nothing we can do */ }

  // Stop accepting new connections (only when actually exiting — tests want
  // to leave the listener up for subsequent assertions).
  if (shouldExit) {
    try { server.close(() => { logJson('info', 'http server closed'); }); } catch {}
  }

  // Drain WebSocket clients. 1.5s lets the broadcast frame actually flush in
  // production; a short delay is enough in tests.
  setTimeout(() => {
    if (shouldExit) {
      wss.clients.forEach(c => { try { c.terminate(); } catch {} });
      try {
        wss.close(() => {
          logJson('info', 'ws server closed');
          process.exit(0);
        });
      } catch { process.exit(0); }
    }
  }, shouldExit ? 1500 : 50);

  // Last-resort kill switch in case wss.close() hangs (e.g. lingering CLOSE_WAIT).
  if (shouldExit) {
    setTimeout(() => {
      logJson('warn', 'shutdown timeout exceeded, forcing exit', { afterMs: 5000 });
      process.exit(1);
    }, 5000).unref();
  }
  // Reset hook for tests so the same require()'d module can be exercised twice.
  return { reset() { shuttingDown = false; } };
}

if (require.main === module) {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  // Last-resort safety net: an exception or rejected promise that escaped
  // every try/catch in the request paths would otherwise crash the process
  // with no graceful drain. Log the context, then run the same shutdown
  // sequence so connected clients see the "reconnecting" banner instead of a
  // silent drop.
  process.on('uncaughtException', err => {
    try {
      logJson('error', 'uncaughtException', {
        error: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : null
      });
      logEvent('crash', 'uncaughtException: ' + (err && err.message ? err.message : String(err)));
    } catch {}
    gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', reason => {
    try {
      logJson('error', 'unhandledRejection', {
        error: reason && reason.message ? reason.message : String(reason),
        stack: reason && reason.stack ? reason.stack : null
      });
      logEvent('crash', 'unhandledRejection: ' + (reason && reason.message ? reason.message : String(reason)));
    } catch {}
    gracefulShutdown('unhandledRejection');
  });
}

if (require.main === module) {
  const cli = parseStartupArgs(process.argv);
  if (cli.help) {
    console.log('Usage: node server.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  -u, --seed-url <URL>   Bootstrap the question bank from a JSON or CSV at this URL.');
    console.log('                         Only runs when the on-disk bank is empty. https:// only.');
    console.log('  -h, --help             Show this help text.');
    console.log('');
    console.log('Environment variables:');
    console.log('  QUESTIONS_SEED_URL     Same as --seed-url. CLI flag takes precedence.');
    console.log('  PORT, DATA_DIR, HOST_TOKEN, ADMIN_TOKEN, PUBLIC_BASE_URL, SAMPLE_PACKS_URL');
    process.exit(0);
  }
  server.listen(PORT, async () => {
    // Seed-on-first-run. We do this after listen() so the server is already
    // accepting traffic — slow fetches don't block the boot, and a failure
    // here doesn't crash the process (admin can always import via UI).
    if (cli.seedUrl && questions.length === 0 && bonusQuestions.length === 0) {
      console.log(`Seeding question bank from ${cli.seedUrl} …`);
      try {
        const r = await seedQuestionsFromUrl(cli.seedUrl);
        console.log(`✓ Seeded ${r.mainCount} main + ${r.bonusCount} bonus questions (${r.format}) from CLI seed URL.`);
        logEvent('seed', `loaded ${r.mainCount}+${r.bonusCount} questions from CLI seed URL`, { source: cli.seedUrl, format: r.format });
        // Re-broadcast so any already-connected admins see the new bank.
        pushAll();
      } catch (e) {
        console.warn('Seed-URL fetch failed:', e.message);
        console.warn('Continuing with empty question bank — load via admin UI.');
        logEvent('warn', 'CLI seed URL failed: ' + e.message, { source: cli.seedUrl });
      }
    } else if (cli.seedUrl) {
      console.log(`Note: --seed-url ignored — disk bank already has ${questions.length}+${bonusQuestions.length} questions.`);
    }
    printBanner();
  });
}

// Export internals for the test harness.
module.exports = {
  app, server, wss,
  sanitizeQuestionHtml, sanitizeQuestionList, sanitizeQuestionImage,
  sanitizeAndValidateQuestionList, normalizeQuestionBank,
  csvField, tokensEqual,
  parseCsv, stringifyCsv, questionsToCsv, questionsFromCsv,
  CSV_HEADERS,
  loadQuestionsFromDisk, saveQuestionsToDisk,
  QUESTIONS_PATH,
  get questions() { return questions; },
  get bonusQuestions() { return bonusQuestions; },
  createSession, deleteSession, getSession, packCookie, unpackCookie,
  loadBranding, saveBranding, validateBranding,
  parsePublicBaseUrl, getPublicBaseUrl, printBanner,
  fetchJsonSafe, fetchTextSafe, fetchSampleJson, loadBundledSampleJson,
  parseStartupArgs, parseSeedBody, seedQuestionsFromUrl,
  loadDotenv, brandingFromEnv,
  gracefulShutdown,
  validateTheme, DEFAULT_THEME,
  DEFAULT_CONSENT_TEXT,
  mintMagicToken, consumeMagicToken,
  recordJoinFailure, isJoinBlocked, clearJoinFailures,
  getClientIp, isCloudflareEdgeIp, ipMatchesCidr, normalizeIp,
  parseReconnectWindowSeconds, reconnectRemainingMs, isWithinReconnectWindow,
  PLAYER_RECONNECT_WINDOW_MS,
  JOIN_FAILURE_MAX,
  CONFIG_PATH, DATA_DIR, MAGIC_TTL_MS,
  get ENV_PUBLIC_BASE_URL() { return ENV_PUBLIC_BASE_URL; },
  get branding()    { return branding; },
  get HOST_MAGIC()  { return HOST_MAGIC; },
  get ADMIN_MAGIC() { return ADMIN_MAGIC; },
  get HOST_TOKEN()  { return HOST_TOKEN; },
  get ADMIN_TOKEN() { return ADMIN_TOKEN; }
};
