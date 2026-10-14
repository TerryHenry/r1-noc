'use strict';
// RUCKUS One REST client: client_credentials token + viewmodel query helpers.
// Query shapes are the ones confirmed live in the sibling RuckusNetworkMap project.
const cfg = require('./config').r1;

// One client per tenant: MSP mode runs one of these for every customer (API tokens are per tenant). `conf` is read live, so
// settings changes take effect after reset().
// Delegated mode (R1 docs: "Using the APIs in Delegated Mode"): client.as(customerTenantId) is a client that reuses THIS client's token and
// sends x-rks-tenantid, so one MSP API key can read every customer it manages.
const TIMEOUT_MS = () => Math.max(1000, Number(process.env.R1_TIMEOUT_MS) || 45000);
// fetch with a deadline, so one unresponsive R1 call can't hold a whole poll (and the wall) hostage
async function fetchT(url, opts, what) {
  try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS()) }); }
  catch (e) { if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`${what} → no answer from R1 within ${Math.round(TIMEOUT_MS() / 1000)} s`); throw e; }
}
function createClient(conf, parent) {
  let cached = null; // { token, expiresAt }

  async function ownToken(force = false) {
    if (!conf.tenantId || !conf.clientId || !conf.clientSecret) throw new Error('R1 credentials not configured (tenant ID, client ID and secret)');
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    const res = await fetchT(`${conf.oauthBase}/oauth2/token/${conf.tenantId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: conf.clientId, client_secret: conf.clientSecret })
    }, 'token request');
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(`R1 token request failed (HTTP ${res.status}) — check tenant/client/secret/region`);
    cached = { token: j.access_token, expiresAt: Date.now() + Math.max((Number(j.expires_in) || 3600) * 1000 - 60000, 15000) };
    return cached.token;
  }
  const getToken = parent ? parent.getToken : ownToken;

  async function post(path, body, retry = true) {
    const token = await getToken();
    const res = await fetchT(conf.apiBase + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(conf.delegate ? { 'x-rks-tenantid': conf.delegate } : {}) },
      body: JSON.stringify(body)
    }, path);
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
    const res = await fetchT(`${conf.apiBase}/api/a4rc/api/rsa-data-api/graphql/analytics`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-rks-tenantid': conf.delegate || conf.tenantId, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) }, 'analytics');
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
  // MSP-account calls (use the MSP client itself, not a delegated one)
  const CUSTOMER_FIELDS = ['id', 'name', 'status', 'accountType', 'accountTier', 'expirationDate', 'creationDate', 'wifiLicenses', 'switchLicenses', 'edgeLicenses', 'apSwLicenses', 'alarmCount', 'tenantType', 'streetAddress', 'city', 'state'];
  const listCustomers = () => queryAll('/tenants/query', { fields: CUSTOMER_FIELDS, filters: { tenantType: ['MSP_EC'] } }, { pageSize: 100 });
  const entitlements = async () => ((await post('/entitlements/query', { page: 1, pageSize: 100 })) || {}).data || [];
  return { queryAll, post, gql, test, listCustomers, entitlements, getToken, as: (ecId) => { const c = Object.create(conf); c.delegate = String(ecId); return createClient(c, { getToken }); }, reset: () => { cached = null; } };
}
module.exports = Object.assign(createClient(cfg), { createClient });
