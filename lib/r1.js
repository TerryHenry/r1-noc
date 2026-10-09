'use strict';
// RUCKUS One REST client: client_credentials token + viewmodel query helpers.
// Query shapes are the ones confirmed live in the sibling RuckusNetworkMap project.
const cfg = require('./config').r1;

let cached = null; // { token, expiresAt }

async function getToken(force = false) {
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) {
    throw new Error('R1 credentials not configured (set R1_TENANT_ID / R1_CLIENT_ID / R1_CLIENT_SECRET)');
  }
  if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
  const res = await fetch(`${cfg.oauthBase}/oauth2/token/${cfg.tenantId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`R1 token request failed (HTTP ${res.status}) — check tenant/client/secret/region`);
  cached = { token: j.access_token, expiresAt: Date.now() + Math.max((Number(j.expires_in) || 3600) * 1000 - 60000, 15000) };
  return cached.token;
}

async function post(path, body, retry = true) {
  const token = await getToken();
  const res = await fetch(cfg.apiBase + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.status === 401 && retry) { await getToken(true); return post(path, body, false); }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}${json && json.message ? `: ${json.message}` : ''}`);
  return json;
}

// Viewmodel paging is 1-indexed; stop on a short page or when totalCount reached.
async function queryAll(path, body = {}, { pageSize = 500, maxPages = 40 } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await post(path, { ...body, page, pageSize });
    const data = (res && res.data) || [];
    rows.push(...data);
    const total = res && typeof res.totalCount === 'number' ? res.totalCount : null;
    if (data.length < pageSize || (total !== null && rows.length >= total)) break;
  }
  return rows;
}

// R1's analytics GraphQL service (the one behind R1's own Client Experience / health reports). Undocumented, but it accepts
// API-application tokens. Throws with R1's error code on failure.
async function gql(query, variables, retry = true) {
  const token = await getToken();
  const res = await fetch(`${cfg.apiBase}/api/a4rc/api/rsa-data-api/graphql/analytics`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-rks-tenantid': cfg.tenantId, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (res.status === 401 && retry) { await getToken(true); return gql(query, variables, false); }
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok || !j || j.errors) { const e = j && j.errors && j.errors[0]; throw new Error(`analytics HTTP ${res.status}${e ? `: ${e.message}${e.extensions && e.extensions.code ? ` (${e.extensions.code})` : ''}` : ''}`); }
  return j.data;
}

// Used by the settings GUI: forget the token and prove the credentials work.
async function test() {
  cached = null;
  await getToken(true);
  const res = await post('/venues/query', { page: 1, pageSize: 200, sortField: 'name', sortOrder: 'ASC' });
  const v = (res && res.data) || [];
  return { venues: typeof res.totalCount === 'number' ? res.totalCount : v.length, sample: v.slice(0, 3).map((x) => x.name) };
}
module.exports = { queryAll, post, gql, test, reset: () => { cached = null; } };
