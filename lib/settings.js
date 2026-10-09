'use strict';
// GUI-editable connection settings → data/settings.json (0600). They override .env values.
// The client secret is write-only: it is never returned by get().
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');

const FILE = path.join(cfg.DATA_DIR, 'settings.json');
const url = (s, d) => { s = String(s || '').trim().replace(/\/+$/, ''); return /^https:\/\/[\w.-]+(:\d+)?$/.test(s) ? s : d; };

function apply(s) {
  const r = cfg.r1;
  if (s.tenantId !== undefined) r.tenantId = String(s.tenantId).trim();
  if (s.clientId !== undefined) r.clientId = String(s.clientId).trim();
  if (s.clientSecret) r.clientSecret = String(s.clientSecret).trim();
  if (s.apiBase) r.apiBase = url(s.apiBase, r.apiBase);
  if (s.oauthBase) r.oauthBase = url(s.oauthBase, r.oauthBase);
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
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
  apply(next);
}

function get() {
  const r = cfg.r1;
  return { tenantId: r.tenantId, clientId: r.clientId, secretSet: Boolean(r.clientSecret), apiBase: r.apiBase, oauthBase: r.oauthBase, pollSeconds: cfg.pollSeconds, demo: cfg.demo };
}

load();
module.exports = { get, save };
