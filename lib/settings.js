'use strict';
// GUI-editable connection settings → data/settings.json (0600). They override .env values.
// The client secret is write-only: it is never returned by get().
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');

const FILE = path.join(cfg.DATA_DIR, 'settings.json');
// MSP mode: one entry per customer tenant (API tokens are per tenant). Empty list = the single connection above.
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
function cleanCustomers(list, existing = []) {
  const out = []; const used = new Set();
  for (const c of Array.isArray(list) ? list.slice(0, 100) : []) {
    if (!c || typeof c !== 'object') continue;
    const prev = existing.find((x) => x.id && x.id === c.id) || {};
    let id = slug(c.id) || slug(c.name) || 'customer'; const base = id; for (let i = 2; used.has(id); i++) id = `${base}-${i}`; used.add(id);
    out.push({
      id, name: String(c.name || c.tenantId || id).trim().slice(0, 80), tenantId: String(c.tenantId !== undefined ? c.tenantId : prev.tenantId || '').trim(), clientId: String(c.clientId !== undefined ? c.clientId : prev.clientId || '').trim(),
      clientSecret: c.clientSecret ? String(c.clientSecret).trim() : prev.clientSecret || '',   // blank = keep existing
      apiBase: url(c.apiBase, prev.apiBase || cfg.r1.apiBase), oauthBase: url(c.oauthBase, prev.oauthBase || cfg.r1.oauthBase), enabled: c.enabled !== false
    });
  }
  return out;
}
const url = (s, d) => { s = String(s || '').trim().replace(/\/+$/, ''); return /^https:\/\/[\w.-]+(:\d+)?$/.test(s) ? s : d; };

function apply(s) {
  const r = cfg.r1;
  if (s.tenantId !== undefined) r.tenantId = String(s.tenantId).trim();
  if (s.clientId !== undefined) r.clientId = String(s.clientId).trim();
  if (s.clientSecret) r.clientSecret = String(s.clientSecret).trim();
  if (s.apiBase) r.apiBase = url(s.apiBase, r.apiBase);
  if (s.oauthBase) r.oauthBase = url(s.oauthBase, r.oauthBase);
  if (Array.isArray(s.customers)) cfg.customers = cleanCustomers(s.customers, cfg.customers || []);
  if (s.pollSeconds) cfg.pollSeconds = Math.max(15, Math.min(3600, Math.round(Number(s.pollSeconds)) || cfg.pollSeconds));
}

function load() {
  try { apply(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { /* none yet */ }
}

function save(input) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* new */ }
  const next = { ...cur };
  for (const k of ['tenantId', 'clientId', 'apiBase', 'oauthBase', 'pollSeconds']) if (input[k] !== undefined && input[k] !== '') next[k] = input[k];
  if (input.clientSecret) next.clientSecret = input.clientSecret; // blank = keep existing
  if (Array.isArray(input.customers)) next.customers = cleanCustomers(input.customers, cfg.customers || []);
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
  apply(next);
}

function get() {
  const r = cfg.r1;
  return { tenantId: r.tenantId, clientId: r.clientId, secretSet: Boolean(r.clientSecret), apiBase: r.apiBase, oauthBase: r.oauthBase, pollSeconds: cfg.pollSeconds, demo: cfg.demo, customers: (cfg.customers || []).map(({ clientSecret, ...c }) => ({ ...c, secretSet: Boolean(clientSecret) })) };
}

load();
module.exports = { get, save };
