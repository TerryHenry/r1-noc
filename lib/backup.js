'use strict';
// Configuration backup / restore.
//   • A backup is one JSON file: { format:'r1-noc-backup', version, createdAt, files:{ name: text } }.
//   • "Configuration only" backups contain no credentials (R1 secrets, notification passwords/URLs and the TLS key are left out)
//     and are plain JSON. "Full" backups include them and are ALWAYS encrypted (scrypt + AES-256-GCM) with a passphrase.
//   • Restore never writes files directly: every part goes through its module's own save(), which validates it. Before anything
//     changes, the current configuration is snapshotted to data/backups/pre-restore-<time>.json (0600).
//   • Metric history (history.db) and generated report files are not part of a backup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./config');
const dash = require('./dashboard');
const rules = require('./rules');
const notify = require('./notify');
const feeds = require('./feeds');
const report = require('./report');
const settings = require('./settings');
const tls = require('./tls');

const DIR = path.join(DATA_DIR, 'backups');
const FORMAT = 'r1-noc-backup';
const PARTS = [   // name → { file under data/, label, secret?: contains credentials }
  { name: 'dashboard.json', label: 'Screens, views and schedules' },
  { name: 'rules.json', label: 'Alert rules' },
  { name: 'notify.json', label: 'Notification channels', secret: true },
  { name: 'ticker.json', label: 'Ticker messages and feeds' },
  { name: 'reports.json', label: 'Scheduled reports' },
  { name: 'settings.json', label: 'R1 connection and customers (MSP)', secret: true },
  { name: 'tls/config.json', label: 'HTTPS settings' },
  { name: 'tls/server.crt', label: 'TLS certificate', secretOnly: true },
  { name: 'tls/server.key', label: 'TLS private key', secretOnly: true, secret: true }
];
const readPart = (name) => { try { return fs.readFileSync(path.join(DATA_DIR, name), 'utf8'); } catch { return null; } };

// Remove credentials from a part's JSON text.
function strip(name, text) {
  let j; try { j = JSON.parse(text); } catch { return text; }
  if (name === 'settings.json') { delete j.clientSecret; if (Array.isArray(j.customers)) j.customers.forEach((c) => { delete c.clientSecret; }); }
  if (name === 'notify.json' && Array.isArray(j)) j.forEach((c) => { delete c.url; delete c.pass; });
  return JSON.stringify(j, null, 2);
}

function collect(full) {
  const files = {};
  for (const p of PARTS) {
    if (p.secretOnly && !full) continue;
    const t = readPart(p.name); if (t == null) continue;
    files[p.name] = full || !p.secret ? t : strip(p.name, t);
  }
  return files;
}
function bundle(full) { return { format: FORMAT, version: 1, app: 'R1 NOC Wall', createdAt: new Date().toISOString(), includesCredentials: Boolean(full), files: collect(full) }; }

// ---- encryption ----
const KDF = { N: 32768, r: 8, p: 1 };
const key = (pass, salt) => crypto.scryptSync(String(pass), salt, 32, { ...KDF, maxmem: 128 * 1024 * 1024 });
function encrypt(obj, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(pass, salt), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { format: FORMAT, version: 1, encrypted: true, includesCredentials: true, createdAt: obj.createdAt, kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') }, cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decrypt(env, pass) {
  if (!pass) throw new Error('This backup is encrypted — enter its passphrase');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(pass, Buffer.from(env.kdf.salt, 'base64')), Buffer.from(env.iv, 'base64')); d.setAuthTag(Buffer.from(env.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).toString('utf8'));
  } catch { throw new Error('Wrong passphrase, or the backup file is damaged'); }
}

// ---- create ----
function create({ full = false, passphrase = '' } = {}) {
  if (full && String(passphrase).length < 8) throw new Error('A full backup contains credentials, so it is always encrypted — choose a passphrase of at least 8 characters');
  const b = bundle(full);
  const out = full ? encrypt(b, passphrase) : b;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  return { name: `r1-noc-wall-${full ? 'full' : 'config'}-${stamp}.json`, text: JSON.stringify(out, null, 2), parts: Object.keys(b.files).length };
}

// ---- inspect / restore ----
function open(input, passphrase) {
  let b = input; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { throw new Error('That is not a backup file (not valid JSON)'); } }
  if (!b || b.format !== FORMAT) throw new Error('That is not an R1 NOC Wall backup file');
  if (b.encrypted) b = decrypt(b, passphrase);
  if (!b.files || typeof b.files !== 'object') throw new Error('The backup has no content');
  if (b.version > 1) throw new Error('This backup was made by a newer version of the app');
  return b;
}
function inspect(input, passphrase) {
  const b = open(input, passphrase); const cur = (n) => readPart(n) != null;
  return { createdAt: b.createdAt, includesCredentials: Boolean(b.includesCredentials), encrypted: Boolean(typeof input === 'object' ? input.encrypted : /"encrypted":\s*true/.test(String(input).slice(0, 400))),
    parts: PARTS.filter((p) => b.files[p.name] != null).map((p) => ({ name: p.name, label: p.label, bytes: Buffer.byteLength(b.files[p.name]), replaces: cur(p.name), credentials: Boolean(p.secret && b.includesCredentials) })) };
}
function snapshot(label = 'pre-restore') {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const f = path.join(DIR, `${label}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}.json`);
  fs.writeFileSync(f, JSON.stringify(bundle(true), null, 2), { mode: 0o600 }); prune(label, label === 'auto' ? 14 : 5); return path.basename(f);
}
function prune(label, keep) { try { const l = fs.readdirSync(DIR).filter((n) => n.startsWith(label + '-')).sort(); for (const n of l.slice(0, Math.max(0, l.length - keep))) fs.unlinkSync(path.join(DIR, n)); } catch { /* none */ } }

// parts: optional list of names to restore (default: all in the backup). Returns what was applied and which module state changed.
function restore(input, passphrase, parts) {
  const b = open(input, passphrase); const want = new Set(parts && parts.length ? parts : Object.keys(b.files));
  if (want.has('tls/server.crt') || want.has('tls/server.key')) { want.add('tls/server.crt'); want.add('tls/server.key'); }   // a certificate and its key only make sense together
  const todo = PARTS.filter((p) => b.files[p.name] != null && want.has(p.name)); if (!todo.length) throw new Error('Nothing selected to restore');
  // validate everything BEFORE touching anything
  const parsed = {};
  for (const p of todo) {
    if (p.name.endsWith('.crt') || p.name.endsWith('.key')) { parsed[p.name] = b.files[p.name]; continue; }
    try { parsed[p.name] = JSON.parse(b.files[p.name]); } catch { throw new Error(`${p.name} in the backup is damaged (not valid JSON)`); }
  }
  if (parsed['dashboard.json']) dash.validate(parsed['dashboard.json']);
  const snap = snapshot('pre-restore'); const done = []; const out = { snapshot: snap, applied: done, layout: null };
  const step = (name, fn) => { try { fn(); done.push(name); } catch (e) { throw new Error(`Restoring ${name} failed: ${e.message} (your previous configuration is in backups/${snap})`); } };
  for (const p of todo) {
    const v = parsed[p.name];
    if (p.name === 'settings.json') step(p.name, () => settings.save(v));                         // blank secrets keep the current ones
    else if (p.name === 'dashboard.json') step(p.name, () => { out.layout = dash.save(v); });
    else if (p.name === 'rules.json') step(p.name, () => rules.save(v));
    else if (p.name === 'notify.json') step(p.name, () => notify.save(v));                         // blank secrets keep the current ones (same id)
    else if (p.name === 'ticker.json') step(p.name, () => feeds.save(v));
    else if (p.name === 'reports.json') step(p.name, () => report.save(v));
    else if (p.name === 'tls/config.json') step(p.name, () => { const c = { ...v }; if (c.enabled && !tls.info().installed && !(todo.some((x) => x.name === 'tls/server.crt'))) c.enabled = false; tls.saveConfig({ ...c, enabled: false }); out.tlsEnable = Boolean(c.enabled); });
  }
  if (parsed['tls/server.crt'] && parsed['tls/server.key']) step('tls/server.crt', () => tls.install({ cert: parsed['tls/server.crt'], key: parsed['tls/server.key'] }));
  if (out.tlsEnable && tls.info().installed) step('tls enabled', () => tls.saveConfig({ enabled: true }));
  return out;
}

// ---- automatic (credential-free) daily backups, kept for 14 days ----
function auto() {
  try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); const f = path.join(DIR, `auto-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`);
    if (!fs.existsSync(f) && Object.keys(collect(false)).length) { fs.writeFileSync(f, JSON.stringify(bundle(false), null, 2), { mode: 0o600 }); prune('auto', 14); } } catch { /* disk issue: skip */ }
}
function list() {
  try { return fs.readdirSync(DIR).filter((n) => /^(auto|pre-restore)-[\w-]+\.json$/.test(n)).sort().reverse().map((n) => { const s = fs.statSync(path.join(DIR, n)); return { name: n, bytes: s.size, at: s.mtimeMs, kind: n.startsWith('auto') ? 'automatic (no credentials)' : 'before a restore (includes credentials)' }; }); } catch { return []; }
}
function read(name) { if (!/^(auto|pre-restore)-[\w-]+\.json$/.test(name)) return null; try { return fs.readFileSync(path.join(DIR, name), 'utf8'); } catch { return null; } }
module.exports = { create, inspect, restore, auto, list, read, PARTS };
