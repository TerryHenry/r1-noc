'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Minimal .env loader (no dependency). Real env vars win.
function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const env = process.env;
module.exports = {
  ROOT,
  DATA_DIR: process.env.NOC_DATA_DIR ? path.resolve(process.env.NOC_DATA_DIR) : path.join(ROOT, 'data'),
  port: Number(env.PORT) || 8080,
  pollSeconds: Math.max(15, Number(env.POLL_SECONDS) || 60), // mutable: settings GUI can change it
  demo: env.NOC_DEMO === '1',
  demoMsp: env.NOC_DEMO_MSP === '1',   // with NOC_DEMO: pretend three customers (try MSP mode without an MSP tenant)
  viewKey: env.NOC_VIEW_KEY || '',
  adminKey: env.NOC_ADMIN_KEY || '',
  customers: [],   // MSP mode: filled from data/settings.json (see settings.js)
  r1: {
    tenantId: env.R1_TENANT_ID || '',
    clientId: env.R1_CLIENT_ID || '',
    clientSecret: env.R1_CLIENT_SECRET || '',
    apiBase: (env.R1_API_BASE || 'https://api.ruckus.cloud').replace(/\/$/, ''),
    oauthBase: (env.R1_OAUTH_BASE || env.R1_API_BASE || 'https://api.ruckus.cloud').replace(/\/$/, '')
  }
};
