'use strict';
// Rolling metric history in node:sqlite so trend widgets build up from day one.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, demo } = require('./config');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, demo ? 'history-demo.db' : 'history.db'));
db.exec(`CREATE TABLE IF NOT EXISTS samples (ts INTEGER NOT NULL, key TEXT NOT NULL, val REAL NOT NULL);
         CREATE INDEX IF NOT EXISTS samples_key_ts ON samples(key, ts);`);
const ins = db.prepare('INSERT INTO samples (ts, key, val) VALUES (?, ?, ?)');
const sel = db.prepare('SELECT ts, val FROM samples WHERE key = ? AND ts >= ? ORDER BY ts');
const selRange = db.prepare('SELECT ts, val FROM samples WHERE key = ? AND ts >= ? AND ts <= ? ORDER BY ts');
const prune = db.prepare('DELETE FROM samples WHERE ts < ?');

const RETAIN_MS = 30 * 86400e3;

function record(ts, metrics) {
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(metrics)) if (Number.isFinite(v)) ins.run(ts, k, v);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (Math.random() < 0.01) prune.run(ts - RETAIN_MS);
}

// Average into at most `maxPoints` buckets across [now-hours, now].
function series(key, hours, maxPoints = 240, now = Date.now()) {
  const since = now - hours * 3600e3;
  const rows = sel.all(key, since);
  if (rows.length <= maxPoints) return rows.map((r) => [r.ts, r.val]);
  const size = (now - since) / maxPoints;
  const buckets = new Map();
  for (const r of rows) {
    const b = Math.floor((r.ts - since) / size);
    const cur = buckets.get(b) || { t: 0, v: 0, n: 0 };
    cur.t += r.ts; cur.v += r.val; cur.n++;
    buckets.set(b, cur);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((b) => { const c = buckets.get(b); return [c.t / c.n, c.v / c.n]; });
}

// Top `n` series whose key starts with `prefix` (keys look like "<prefix><label>@*"), ranked by latest value.
const keysIn = db.prepare('SELECT DISTINCT key FROM samples WHERE key >= ? AND key < ? AND ts >= ?');
function topSeries(prefix, suffix, hours, n, maxPoints = 200, now = Date.now()) {
  const since = now - hours * 3600e3;
  const keys = keysIn.all(prefix, prefix + '\uffff', since).map((r) => r.key).filter((k) => k.endsWith(suffix));
  const out = keys.map((k) => ({ label: k.slice(prefix.length, k.length - suffix.length), points: series(k, hours, maxPoints, now) })).filter((x) => x.points.length);
  out.sort((a, b) => b.points[b.points.length - 1][1] - a.points[a.points.length - 1][1]);
  return out.slice(0, n);
}

const range = (key, from, to) => selRange.all(key, from, to).map((r) => [r.ts, r.val]);
const count = () => db.prepare('SELECT COUNT(*) AS n FROM samples').get().n;
module.exports = { record, series, topSeries, range, count };
