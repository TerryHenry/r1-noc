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
  if (s.msp && typeof s.msp === 'object') {   // one MSP key + delegated access to every customer it manages
    const m = cfg.msp, i = s.msp;
    if (i.enabled !== undefined) m.enabled = Boolean(i.enabled);
    if (i.tenantId !== undefined) m.tenantId = String(i.tenantId).trim();
    if (i.clientId !== undefined) m.clientId = String(i.clientId).trim();
    if (i.clientSecret) m.clientSecret = String(i.clientSecret).trim();
    if (i.apiBase) m.apiBase = url(i.apiBase, m.apiBase);
    if (i.oauthBase) m.oauthBase = url(i.oauthBase, m.oauthBase);
    if (Array.isArray(i.exclude)) m.exclude = [...new Set(i.exclude.map(String).filter((x) => /^[\w-]{1,64}$/.test(x)))].slice(0, 500);
  }
  if (Array.isArray(s.customers)) cfg.customers = cleanCustomers(s.customers, cfg.customers || []);
  if (['single', 'msp', 'customers'].includes(s.mode)) cfg.mode = s.mode;
  if (!['single', 'msp', 'customers'].includes(cfg.mode)) cfg.mode = cfg.msp.enabled ? 'msp' : (cfg.customers || []).length ? 'customers' : 'single';   // installs from before the mode switch
  cfg.msp.enabled = cfg.mode === 'msp';
  if (s.pollSeconds) cfg.pollSeconds = Math.max(15, Math.min(3600, Math.round(Number(s.pollSeconds)) || cfg.pollSeconds));
}

function load() {
  let s = {}; try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* none yet */ }
  apply(s);   // also sets the connection mode when there is no file yet
}

function save(input) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* new */ }
  const next = { ...cur };
  for (const k of ['tenantId', 'clientId', 'apiBase', 'oauthBase', 'pollSeconds']) if (input[k] !== undefined && input[k] !== '') next[k] = input[k];
  if (input.clientSecret) next.clientSecret = input.clientSecret; // blank = keep existing
  if (['single', 'msp', 'customers'].includes(input.mode)) next.mode = input.mode;
  if (Array.isArray(input.customers)) next.customers = cleanCustomers(input.customers, cfg.customers || []);
  if (input.msp && typeof input.msp === 'object') { const prev = cfg.msp, i = input.msp; next.msp = { enabled: i.enabled !== undefined ? Boolean(i.enabled) : prev.enabled, tenantId: i.tenantId !== undefined ? String(i.tenantId).trim() : prev.tenantId, clientId: i.clientId !== undefined ? String(i.clientId).trim() : prev.clientId, clientSecret: i.clientSecret ? String(i.clientSecret).trim() : prev.clientSecret, apiBase: i.apiBase || prev.apiBase, oauthBase: i.oauthBase || prev.oauthBase, exclude: Array.isArray(i.exclude) ? i.exclude : prev.exclude }; }
  if (next.mode) { const m = next.msp || { ...cfg.msp }; next.msp = { ...m, enabled: next.mode === 'msp' }; }
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
  apply(next);
}

function get() {
  const r = cfg.r1;
  return { mode: cfg.mode, tenantId: r.tenantId, clientId: r.clientId, secretSet: Boolean(r.clientSecret), apiBase: r.apiBase, oauthBase: r.oauthBase, pollSeconds: cfg.pollSeconds, demo: cfg.demo, msp: { enabled: cfg.msp.enabled, tenantId: cfg.msp.tenantId, clientId: cfg.msp.clientId, secretSet: Boolean(cfg.msp.clientSecret), apiBase: cfg.msp.apiBase, exclude: cfg.msp.exclude }, customers: (cfg.customers || []).map(({ clientSecret, ...c }) => ({ ...c, secretSet: Boolean(clientSecret) })) };
}

load();
module.exports = { get, save };
