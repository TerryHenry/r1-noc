'use strict';
// Editor sign-in (an alternative to the ?key= URL). Two account sources, either or both:
//   • local   — an account you create in the editor (Editor login panel) or with `node scripts/passwd.js`; stored hashed (scrypt) in data/auth.json
//   • os      — the appliance: the password of the machine's `noc` user, checked by a root-owned helper (NOC_AUTH_HELPER) through sudo
// A successful sign-in sets an HttpOnly, SameSite=Strict cookie. Sessions survive restarts (hashed tokens in data/sessions.json).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'auth.json'), SESS = path.join(DATA_DIR, 'sessions.json');
const HELPER = () => process.env.NOC_AUTH_HELPER || '';
const TTL = 12 * 3600e3, COOKIE = 'noc_session';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saveJson = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };

let local = loadJson(FILE, { users: [] }).users || [];
let sessions = new Map(Object.entries(loadJson(SESS, {})).filter(([, s]) => s.exp > Date.now()));
const persist = () => saveJson(SESS, Object.fromEntries(sessions));

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
const enabled = () => Boolean(HELPER()) || local.length > 0;
const info = () => ({ enabled: enabled(), os: Boolean(HELPER()), local: local.map((u) => u.user) });

function setLocal(user, password) {
  user = String(user || '').trim(); password = String(password || '');
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(user)) throw new Error('User name: 1–32 letters, digits, . _ -');
  if (password.length < 8) throw new Error('Choose a password of at least 8 characters');
  const salt = crypto.randomBytes(16).toString('hex'); local = [{ user, salt, hash: hash(password, salt) }];   // one local account
  saveJson(FILE, { users: local }); sessions.clear(); persist();
}
function removeLocal() { local = []; saveJson(FILE, { users: [] }); }

const timingEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function checkOs(user, password) {
  return new Promise((resolve) => {
    if (!HELPER() || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) return resolve(false);
    const p = spawn('sudo', ['-n', HELPER(), user], { stdio: ['pipe', 'ignore', 'ignore'] });
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve(false); }, 8000);
    p.on('error', () => { clearTimeout(t); resolve(false); }); p.on('close', (c) => { clearTimeout(t); resolve(c === 0); });
    p.stdin.on('error', () => {}); p.stdin.end(password + '\n');   // the password goes through stdin, never the command line
  });
}
async function verify(user, password) {
  user = String(user || '').trim(); password = String(password || ''); if (!user || !password || password.length > 256) return false;
  const l = local.find((u) => u.user === user); if (l) return timingEq(hash(password, l.salt), l.hash);
  return checkOs(user, password);
}

// ---- brute-force damping: 5 failures from one address → locked out for a minute, doubling each time ----
const fails = new Map();
const locked = (ip) => { const f = fails.get(ip); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
async function login(ip, user, password) {
  const wait = locked(ip); if (wait) return { ok: false, status: 429, error: `Too many attempts — try again in ${wait} s` };
  await new Promise((r) => setTimeout(r, 400));
  if (!(await verify(user, password))) {
    const f = fails.get(ip) || { n: 0, until: 0, round: 0 }; f.n++; if (f.n >= 5) { f.n = 0; f.round++; f.until = Date.now() + 60e3 * 2 ** Math.min(f.round - 1, 5); } fails.set(ip, f);
    return { ok: false, status: 401, error: 'Wrong user name or password' };
  }
  fails.delete(ip); const token = crypto.randomBytes(32).toString('hex');
  sessions.set(sha(token), { user: String(user).trim(), exp: Date.now() + TTL }); persist();
  return { ok: true, token };
}
function cookieOf(req) { const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`).exec(req.headers.cookie || ''); return m ? m[1] : ''; }
function session(req) {
  const t = cookieOf(req); if (!t) return null; const s = sessions.get(sha(t)); if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(sha(t)); return null; }
  return s;
}
function logout(req) { const t = cookieOf(req); if (t) { sessions.delete(sha(t)); persist(); } }
const setCookie = (token, secure) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1000}${secure ? '; Secure' : ''}`;
const clearCookie = (secure) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
setInterval(() => { let d = false; for (const [k, s] of sessions) if (s.exp < Date.now()) { sessions.delete(k); d = true; } if (d) persist(); }, 600e3).unref();
module.exports = { enabled, info, setLocal, removeLocal, login, session, logout, setCookie, clearCookie };
