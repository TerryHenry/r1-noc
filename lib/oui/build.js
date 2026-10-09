'use strict';

// Turns the IEEE registry CSVs (MA-L /24, MA-M /28, MA-S /36) into the
// compact gzipped JSON the app loads. Used by scripts/build-oui.js for the
// bundled snapshot and by the in-app "Update from IEEE" button.
const zlib = require('zlib');

const IEEE_SOURCES = {
  l: 'https://standards-oui.ieee.org/oui/oui.csv',
  m: 'https://standards-oui.ieee.org/oui28/mam.csv',
  s: 'https://standards-oui.ieee.org/oui36/oui36.csv'
};

// Registry names → what people call them on a network map.
const OVERRIDES = {
  'routerboard.com': 'MikroTik',
  'mikrotikls sia': 'MikroTik',
  'ruckus wireless': 'RUCKUS',
  'hon hai precision ind': 'Foxconn',
  'hon hai precision industry': 'Foxconn',
  'raspberry pi trading': 'Raspberry Pi',
  'raspberry pi (trading)': 'Raspberry Pi',
  'amazon technologies': 'Amazon',
  'google': 'Google',
  'hewlett packard': 'HP',
  'hewlett packard enterprise': 'HPE',
  'tp-link technologies': 'TP-Link',
  'tp-link corporation': 'TP-Link',
  'ubiquiti': 'Ubiquiti',
  'ubiquiti networks': 'Ubiquiti',
  'espressif': 'Espressif (IoT module)',
  'tuya smart': 'Tuya (IoT)',
  'murata manufacturing': 'Murata (Wi-Fi module)',
  'azurewave technology': 'AzureWave (Wi-Fi module)',
  'intel corporate': 'Intel'
};

const SUFFIX = /[\s,.]*(incorporated|inc|corporation|corp|co\.?\s*,?\s*ltd|company\s+limited|co|ltd|limited|llc|l\.l\.c|gmbh(\s*&\s*co\.?\s*kg)?|ag|s\.?a\.?(\s*de\s*c\.?v\.?)?|s\.?p\.?a|b\.?v|n\.?v|a\/s|ab|oy|pty|pte|plc|kg|srl|s\.r\.l|sas|sarl|k\.?k|s\.?l)\.?$/i;

function tidyName(raw) {
  let name = String(raw || '').replace(/\uFF0C/g, ',').replace(/\s+/g, ' ').trim();
  // Strip legal suffixes repeatedly ("Foo Co., Ltd." → "Foo").
  for (let i = 0; i < 4; i++) {
    const next = name.replace(SUFFIX, '').replace(/[\s,.]+$/, '').trim();
    if (next === name || !next) break;
    name = next;
  }
  const o = OVERRIDES[name.toLowerCase()];
  if (o) return o;
  // SHOUTING REGISTRY NAMES → Title Case (keep short tokens like TP, HP, IBM).
  if (name.length > 4 && name === name.toUpperCase() && /[A-Z]{4}/.test(name)) {
    const small = new Set(['and', 'of', 'the', 'for', 'de']);
    name = name.toLowerCase().replace(/[a-z0-9]+/g, (w) => (small.has(w) ? w : w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  }
  return name;
}

// Minimal RFC-4180 CSV row splitter (IEEE quotes names containing commas).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// csvByRegistry: { l: text, m: text, s: text } → gzipped JSON Buffer.
function buildDb(csvByRegistry, { source = 'IEEE Registration Authority' } = {}) {
  const vendors = [];
  const vendorIdx = new Map();
  const tables = { l: {}, m: {}, s: {} };
  const want = { l: 6, m: 7, s: 9 };
  for (const [reg, text] of Object.entries(csvByRegistry)) {
    const lines = String(text).split(/\r?\n/);
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const [, assignment, org] = parseCsvLine(line);
      const key = String(assignment || '').toUpperCase().replace(/[^0-9A-F]/g, '');
      if (key.length !== want[reg] || !org) continue;
      const name = tidyName(org);
      if (!name || /^private$/i.test(name)) continue;
      if (!vendorIdx.has(name)) {
        vendorIdx.set(name, vendors.length);
        vendors.push(name);
      }
      tables[reg][key] = vendorIdx.get(name);
    }
  }
  const counts = { l: Object.keys(tables.l).length, m: Object.keys(tables.m).length, s: Object.keys(tables.s).length };
  if (counts.l < 10000) throw new Error(`OUI data looks incomplete (${counts.l} MA-L entries)`);
  const db = { source, generatedAt: new Date().toISOString(), counts, vendors, ...tables };
  return zlib.gzipSync(Buffer.from(JSON.stringify(db)), { level: 9 });
}

async function fetchIeee() {
  const out = {};
  for (const [reg, url] of Object.entries(IEEE_SOURCES)) {
    const res = await fetch(url, { headers: { Accept: 'text/csv' } });
    if (!res.ok) throw new Error(`IEEE ${reg.toUpperCase()} download failed (${res.status})`);
    out[reg] = await res.text();
  }
  return out;
}

module.exports = { IEEE_SOURCES, buildDb, fetchIeee, tidyName, parseCsvLine };
