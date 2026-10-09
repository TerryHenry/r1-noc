'use strict';

// Local MAC → vendor lookup against the IEEE OUI registries. Nothing leaves
// the machine: the bundled snapshot (lib/oui/oui-db.json.gz) is used unless
// Settings → "Update from IEEE" has saved a newer copy in userData.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildDb, fetchIeee } = require('./build');

const BUNDLED = path.join(__dirname, 'oui-db.json.gz');
let userDir = null;
let db = null;

function init(dir) {
  userDir = dir;
  db = null;
}

function userFile() {
  return userDir ? path.join(userDir, 'oui-db.json.gz') : null;
}

function load() {
  if (db) return db;
  const candidates = [userFile(), BUNDLED].filter(Boolean);
  for (const file of candidates) {
    try {
      const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
      db = {
        info: { source: raw.source, generatedAt: raw.generatedAt, counts: raw.counts, file: file === BUNDLED ? 'bundled' : 'downloaded' },
        vendors: raw.vendors,
        l: new Map(Object.entries(raw.l)),
        m: new Map(Object.entries(raw.m)),
        s: new Map(Object.entries(raw.s))
      };
      return db;
    } catch {
      /* try next */
    }
  }
  db = { info: { source: 'none', counts: { l: 0, m: 0, s: 0 } }, vendors: [], l: new Map(), m: new Map(), s: new Map() };
  return db;
}

function hex(mac) {
  return String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
}

// → { vendor, randomized, multicast } or null for things that aren't MACs.
// Locally administered addresses (2nd-lowest bit of the first octet) are
// what phones/laptops use for "private Wi-Fi address", Docker/VMs use for
// virtual NICs, etc. — they carry no vendor, so say so instead of guessing.
function lookup(mac) {
  const h = hex(mac);
  if (h.length !== 12) return null;
  const first = parseInt(h.slice(0, 2), 16);
  if (first & 0x01) return { vendor: '', multicast: true, randomized: false };
  if (first & 0x02) return { vendor: '', multicast: false, randomized: true };
  const d = load();
  const idx = d.s.get(h.slice(0, 9)) ?? d.m.get(h.slice(0, 7)) ?? d.l.get(h.slice(0, 6));
  return { vendor: idx != null ? d.vendors[idx] : '', multicast: false, randomized: false };
}

function info() {
  return load().info;
}

async function updateFromIeee() {
  if (!userDir) throw new Error('OUI store not initialised');
  const gz = buildDb(await fetchIeee());
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userFile(), gz);
  db = null;
  return info();
}

const MAC_RE = /^[0-9a-f]{2}([:-])[0-9a-f]{2}(\1[0-9a-f]{2}){4}$/i;

// Walk a model and build { NORMALIZED_MAC: label } for every MAC it
// contains, so the renderer can show vendors anywhere without its own DB.
// Skips raw API payloads/history (same MACs, much bigger).
function vendorIndex(model) {
  const out = {};
  const seen = new Set();
  const visit = (v, key) => {
    if (key === 'raw' || key === 'history') return;
    if (typeof v === 'string') {
      if (!MAC_RE.test(v)) return;
      const h = hex(v);
      if (seen.has(h)) return;
      seen.add(h);
      const r = lookup(v);
      if (!r) return;
      out[h] = r.randomized ? '~random' : r.multicast ? '~multicast' : r.vendor || '';
      return;
    }
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(model);
  return out;
}

module.exports = { init, lookup, info, updateFromIeee, vendorIndex };
