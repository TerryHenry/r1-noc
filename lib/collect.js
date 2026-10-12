'use strict';
// Poll R1 (or the demo generator), normalise into a Snapshot, record history.
// "Heavy" sources (switch ports, Wi-Fi calling profiles) are only fetched when a widget on
// some screen needs them, and are cached longer than the main poll.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const history = require('./history');
const r1 = require('./r1');
const analytics = require('./analytics');
const N = require('./normalize');

const ALARM_FIELDS = ['id', 'severity', 'startTime', 'clearTime', 'entityType', 'entityId', 'serialNumber', 'name', 'message'];
const PORT_FIELDS = ['id', 'switchName', 'switchSerial', 'switchMac', 'venueId', 'portIdentifier', 'name', 'status', 'adminStatus', 'poeUsed', 'poeTotal', 'signalIn', 'signalOut', 'inErr', 'outErr', 'crcErr', 'portSpeed', 'errorDisableStatus', 'spanningTreeStatus', 'neighborName', 'neighborMacAddress', 'rx', 'tx', 'switchModel', 'mediaType', 'unTaggedVlan', 'switchPortProfileName', 'lagName'];
const TTL = { switchEvents: 120e3, analytics: 300e3, apGroups: 300e3, ports: 180e3, wfcProfiles: 600e3, networks: 300e3, dpsk: 300e3, guests: 300e3, vlanPools: 600e3, identityGroups: 600e3 };

const empty = () => ({ at: 0, switchEvents: [], portEvents: [], venues: [], aps: [], switches: [], clients: [], alarms: [], ports: [], radios: [], analytics: null, traffic: { dt: 0, bytes: 0, down: 0, up: 0 }, wfcProfiles: [], networks: [], dpskPools: [], dpsk: [], guests: [], vlanPools: [], identityGroups: [], errors: {}, source: cfg.demo ? 'demo' : 'r1' });
let snapshot = empty();
let needs = new Set();       // 'ports' | 'wfcProfiles'

// Everything stateful is per tenant (MSP mode polls one tenant per customer): the R1 client, slow-source caches, and the
// counter baselines used to turn cumulative bytes into rates.
const makeCtx = (client, id = '') => ({ client, id, slow: {}, prevPorts: new Map(), prevPortsAt: 0, clientTrack: new Map(), prevAt: 0, portState: null, portEvents: null });
const defaultCtx = makeCtx(r1);
const custCtx = new Map();   // customer id -> { sig, ctx }
function ctxFor(c) {
  const sig = c.via === 'msp' ? `msp|${mspSig()}` : [c.tenantId, c.clientId, c.clientSecret, c.apiBase, c.oauthBase].join('|'); const have = custCtx.get(c.id);
  if (have && have.sig === sig) return have.ctx;
  const ctx = makeCtx(c.via === 'msp' ? mspClient().as(c.id) : r1.createClient(c), c.id); custCtx.set(c.id, { sig, ctx }); return ctx;
}

// ---- MSP account: ONE API key (created in the MSP's own account) + delegated access to every customer it manages ----
const mspState = { client: null, sig: '', customers: [], entitlements: [], at: 0, error: '' };
const mspSig = () => [cfg.msp.tenantId, cfg.msp.clientId, cfg.msp.clientSecret, cfg.msp.apiBase, cfg.msp.oauthBase].join('|');
function mspClient() {
  if (!mspState.client || mspState.sig !== mspSig()) { mspState.client = r1.createClient(cfg.msp); mspState.sig = mspSig(); mspState.customers = []; mspState.entitlements = []; mspState.at = 0; }
  return mspState.client;
}
const asDays = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.floor((t - Date.now()) / 86400e3) : null; };
const customerMeta = (r) => ({ id: r.id, name: r.name || r.id, status: r.status || '', accountType: r.accountType || '', tier: r.displayTier || r.accountTier || '', expires: r.expirationDate || '', expiresInDays: asDays(r.expirationDate),
  licenses: { wifi: Number(r.wifiLicenses) || 0, switch: Number(r.switchLicenses) || 0, edge: Number(r.edgeLicenses) || 0, apSw: Number(r.apSwLicenses) || 0 }, city: r.city || '', state: r.state || '' });
const entMeta = (e) => ({ type: e.licenseType || '', sku: e.sku || '', desc: e.licenseDesc || '', quantity: Number(e.quantity) || 0, status: e.status || '', trial: Boolean(e.isTrial), usage: e.usageType || '', expires: e.expirationDate || '', expiresInDays: asDays(e.expirationDate) });
async function mspDiscover(force = false) {
  if (!cfg.msp.enabled) return [];
  const cl = mspClient(); if (!force && mspState.at && Date.now() - mspState.at < 600e3) return mspState.customers;
  try {
    const rows = await cl.listCustomers(); mspState.customers = rows.map(customerMeta);
    mspState.entitlements = (await cl.entitlements().catch(() => [])).map(entMeta); mspState.at = Date.now(); mspState.error = '';
  } catch (e) { mspState.error = e.message; mspState.at = Date.now() - 540e3; if (!mspState.customers.length) throw e; }   // keep the last list; retry in a minute
  return mspState.customers;
}
const mspInfo = () => ({ enabled: cfg.msp.enabled, error: mspState.error, at: mspState.at, entitlements: mspState.entitlements, customers: mspState.customers.map((c) => ({ ...c, excluded: cfg.msp.exclude.includes(c.id) })) });
async function mspRefresh() { mspState.at = 0; await mspDiscover(true); return mspInfo(); }

const setNeeds = (set) => { needs = new Set(set); };

async function slowSource(ctx, name, fetcher) {
  const slow = ctx.slow;
  if (!needs.has(name) && name !== 'apGroups') return null;   // AP groups are cheap and feed many widgets: always on
  const c = slow[name];
  if (c && Date.now() - c.at < TTL[name]) return { ...c, fresh: false };
  try { slow[name] = { at: Date.now(), rows: await fetcher(), error: null, fresh: true }; }
  catch (e) { slow[name] = { at: c ? c.at : Date.now(), rows: c ? c.rows : [], error: e.message }; }
  return slow[name];
}

// Switch-port counters (rx/tx/errors) are cumulative since reboot. Like client throughput, the rate is the difference between
// two fetches ÷ elapsed time. It is stamped onto the raw rows (_mbps, _errDelta) so every poll that reuses the cached rows sees it.
function stampPortRates(rows, ctx = defaultCtx) {
  const { prevPorts } = ctx; const now = Date.now(); const dt = ctx.prevPortsAt ? (now - ctx.prevPortsAt) / 1000 : 0; const next = new Map();
  for (const r of rows) {
    const key = `${r.switchSerial || r.switchMac}|${r.portIdentifier || r.name || r.id}`; const rx = parseFloat(r.rx) || 0, tx = parseFloat(r.tx) || 0, er = (parseFloat(r.inErr) || 0) + (parseFloat(r.outErr) || 0) + (parseFloat(r.crcErr) || 0);
    next.set(key, { rx, tx, er }); const p = prevPorts.get(key);
    if (p && dt > 0 && dt < 3600 && rx >= p.rx && tx >= p.tx) { r._mbps = ((rx - p.rx + (tx - p.tx)) * 8) / dt / 1e6; r._errDelta = Math.max(0, er - p.er); }
  }
  prevPorts.clear(); next.forEach((v, k) => prevPorts.set(k, v)); ctx.prevPortsAt = now; return rows;
}
async function fetchPorts(ctx) {
  return stampPortRates(await fetchPortsRaw(ctx), ctx);
}
async function fetchPortsRaw(ctx) {
  const r1 = ctx.client;
  try { return await r1.queryAll('/venues/switches/switchPorts/query', { fields: PORT_FIELDS }, { pageSize: 1000, maxPages: 60 }); }
  catch (e) {
    if (!/HTTP 4\d\d/.test(e.message)) throw e;
    return r1.queryAll('/venues/switches/switchPorts/query', {}, { pageSize: 1000, maxPages: 60 }); // retry without `fields`
  }
}

// DPSK pagination is 0-indexed ({page, pageSize}); a pool's passphrases are queried per pool.
async function pagedZero(ctx, path, body, { pageSize = 500, maxPages = 40 } = {}) {
  const r1 = ctx.client;
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await r1.post(path, { ...body, page, pageSize });
    const data = (res && (res.data || res.content)) || [];
    rows.push(...data);
    const total = res && typeof res.totalCount === 'number' ? res.totalCount : null;
    if (data.length < pageSize || (total !== null && rows.length >= total)) break;
  }
  return rows;
}
// Spring-style ({page,size} query params → {content,last}) used by persona / identity endpoints.
async function pagedSpring(ctx, path, body, { size = 200, maxPages = 40 } = {}) {
  const r1 = ctx.client;
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await r1.post(`${path}${path.includes('?') ? '&' : '?'}page=${page}&size=${size}`, body);
    rows.push(...((res && res.content) || []));
    if (!res || res.last !== false || !(res.content || []).length) break;
  }
  return rows;
}
async function fetchDpsk(ctx) {
  const pools = await pagedZero(ctx, '/dpskServices/query', {}, { pageSize: 200 });
  const out = [];
  for (const pool of pools.slice(0, 30)) {
    const rows = await pagedZero(ctx, `/dpskServices/${pool.id}/passphrases/query`, { maxDevicesPerPassphrase: 25 }, { pageSize: 500, maxPages: 20 });
    out.push({ pool, rows });
  }
  return out;
}


// ---- switch-port change log, derived from consecutive port fetches (state up/down, spanning-tree state, error-disable). ----
// Ports are fetched every few minutes, so this is a sampled view: a flap faster than the fetch interval can be missed. The log is kept
// for 7 days in data/port-events[-<customer>].json so it survives restarts; the first fetch after a start only sets the baseline.
const PORT_EVENT_KEEP = 7 * 86400e3, PORT_EVENT_MAX = 2000;
const evFile = (ctx) => path.join(cfg.DATA_DIR, ctx.id ? `port-events-${ctx.id.replace(/[^\w-]/g, '_')}.json` : 'port-events.json');
function detectPortChanges(ctx, ports, now) {
  if (!ctx.portEvents) { try { ctx.portEvents = JSON.parse(fs.readFileSync(evFile(ctx), 'utf8')); } catch { ctx.portEvents = []; } }
  const prev = ctx.portState, next = new Map(); let added = 0;
  for (const p of ports) {
    if (!p.portName) continue;
    const key = `${p.venueId}|${p.switchName}|${p.portName}`; const cur = { state: p.state, stp: p.stp || '', ed: p.errDisabled || '' }; next.set(key, cur);
    const old = prev && prev.get(key); if (!old) continue;
    const push = (kind, from, to) => { ctx.portEvents.push({ t: now, kind, venueId: p.venueId, switchName: p.switchName, port: p.portName, from, to }); added++; };
    if (old.state !== cur.state && old.state !== 'Unknown' && cur.state !== 'Unknown') push(cur.state === 'Up' ? 'up' : cur.state === 'Down' ? 'down' : cur.state === 'Disabled' ? 'disabled' : 'enabled', old.state, cur.state);
    if (old.stp !== cur.stp && old.stp && cur.stp) push('stp', old.stp, cur.stp);
    if (!old.ed && cur.ed) push('errdisable', '', cur.ed); else if (old.ed && !cur.ed) push('errdisable-clear', old.ed, '');
  }
  ctx.portState = next;
  const cut = now - PORT_EVENT_KEEP; if (ctx.portEvents.length > PORT_EVENT_MAX || (ctx.portEvents[0] && ctx.portEvents[0].t < cut)) ctx.portEvents = ctx.portEvents.filter((e) => e.t >= cut).slice(-PORT_EVENT_MAX);
  if (added) { try { fs.mkdirSync(cfg.DATA_DIR, { recursive: true }); fs.writeFileSync(evFile(ctx) + '.tmp', JSON.stringify(ctx.portEvents)); fs.renameSync(evFile(ctx) + '.tmp', evFile(ctx)); } catch { /* disk issue: keep in memory */ } }
}

// R1's event log for switches (the last 7 days, newest first, at most five pages).
async function fetchSwitchEvents(ctx) {
  const rows = []; const cut = Date.now() - 7 * 86400e3;
  for (let page = 1; page <= 5; page++) {
    const res = await ctx.client.post('/events/query', { page, pageSize: 200, sortField: 'event_datetime', sortOrder: 'desc', fields: ['severity', 'entity_type', 'event_datetime', 'message', 'id', 'entity_id'], filters: { entity_type: ['SWITCH'] } });
    const data = (res && res.data) || []; rows.push(...data);
    if (data.length < 200 || (data.length && Date.parse(data[data.length - 1].event_datetime) < cut)) break;
  }
  return rows.filter((r) => Date.parse(r.event_datetime) >= cut);
}

// Client throughput from counter deltas. Each client row carries cumulative session bytes. For every client (keyed by MAC) we
// keep a baseline: the bytes and time at the last moment the counter CHANGED. When it changes again, rate = Δbytes ÷ time since
// that baseline. That matters because R1 may refresh client counters less often than we poll: unchanged polls are not "0 Mbps",
// they carry the last known rate for a while (STALE_MS) and only then count as idle. Counter resets (roam / reconnect) and
// first sightings simply restart the baseline. Up/down split is used only when R1 supplies it; the total never depends on it.
const STALE_MS = 6 * 60e3, MAX_DT_MS = 10 * 60e3, FORGET_MS = 15 * 60e3;
function applyThroughput(S, ctx = defaultCtx) {
  const { clientTrack } = ctx; const now = Date.now(); const pollDt = ctx.prevAt ? (now - ctx.prevAt) / 1000 : 0;
  const stats = { clients: S.clients.length, noMac: 0, noCounters: 0, newlySeen: 0, changed: 0, carried: 0, idle: 0, reset: 0 };
  for (const c of S.clients) {
    if (!c.mac) { stats.noMac++; continue; }
    if (!c.bytes) stats.noCounters++;
    let r = clientTrack.get(c.mac);
    if (!r) { clientTrack.set(c.mac, { bytes: c.bytes, down: c.bytesDown, up: c.bytesUp, t: now, lastChange: now, seen: now, rate: null }); stats.newlySeen++; continue; }
    r.seen = now;
    if (c.bytes < r.bytes) { Object.assign(r, { bytes: c.bytes, down: c.bytesDown, up: c.bytesUp, t: now, lastChange: now, rate: null }); stats.reset++; continue; }
    if (c.bytes > r.bytes) {
      const dt = Math.min(now - r.t, MAX_DT_MS) / 1000; const d = c.bytes - r.bytes; const dd = c.bytesDown - r.down, du = c.bytesUp - r.up;
      const split = dd >= 0 && du >= 0 && dd + du > 0;
      if (dt > 0) r.rate = { total: (d * 8) / dt / 1e6, down: split ? ((d * dd) / (dd + du) * 8) / dt / 1e6 : null, up: split ? ((d * du) / (dd + du) * 8) / dt / 1e6 : null };
      Object.assign(r, { bytes: c.bytes, down: c.bytesDown, up: c.bytesUp, t: now, lastChange: now }); stats.changed++;
    } else if (r.rate && now - r.lastChange < STALE_MS) stats.carried++;                     // unchanged, but counters may simply not have refreshed yet
    else { if (r.rate) r.rate = { total: 0, down: r.rate.down == null ? null : 0, up: r.rate.up == null ? null : 0 }; stats.idle++; }   // unchanged for a while → idle
    if (r.rate) { c.mbps = r.rate.total; c.mbpsDown = r.rate.down; c.mbpsUp = r.rate.up; }
  }
  for (const [k, r] of clientTrack) if (now - r.seen > FORGET_MS) clientTrack.delete(k);
  // Volume moved during this poll interval = Σ rate × interval (smooth, and independent of how often R1 refreshes counters).
  const tr = { dt: 0, bytes: 0, down: 0, up: 0, stats };
  if (pollDt > 0 && pollDt < cfg.pollSeconds * 5) {
    tr.dt = pollDt;
    for (const c of S.clients) if (c.mbps != null) { tr.bytes += (c.mbps * 1e6 / 8) * pollDt; tr.down += ((c.mbpsDown || 0) * 1e6 / 8) * pollDt; tr.up += ((c.mbpsUp || 0) * 1e6 / 8) * pollDt; }
  }
  S.traffic = tr; ctx.prevAt = now;
}

async function pollTenant(ctx) {
  const r1 = ctx.client; const slow = ctx.slow;
  const S = empty();
  const errors = S.errors;
  const run = async (name, fn) => { try { return await fn(); } catch (e) { errors[name] = e.message; return []; } };

  const [venues, aps, switches, clients, alarms] = await Promise.all([
    run('venues', () => r1.queryAll('/venues/query', { sortField: 'name', sortOrder: 'ASC' }, { pageSize: 200 })),
    run('aps', () => r1.queryAll('/venues/aps/query')),
    run('switches', () => r1.queryAll('/venues/switches/query')),
    run('clients', () => r1.queryAll('/venues/aps/clients/query')),
    run('alarms', async () => (await r1.post('/alarms/query', { fields: ALARM_FIELDS, sortField: 'startTime', sortOrder: 'desc', page: 1, pageSize: 300, filters: {} })).data || [])
  ]);

  const names = new Map(venues.map((v) => [v.id, v.name]));
  S.venues = venues.map((v) => ({ id: v.id, name: v.name }));
  S.aps = aps.map((a) => N.ap(a, names));
  S.switches = switches.map((s) => N.sw(s, names));
  S.clients = clients.map(N.client);
  const agC = await slowSource(ctx, 'apGroups', () => r1.queryAll('/venues/apGroups/query', {}, { pageSize: 500 }));
  if (agC) {
    const bySerial = new Map(); for (const g of agC.rows) for (const sn of g.apSerialNumbers || []) bySerial.set(sn, g.name);
    S.aps.forEach((a) => { a.apGroup = bySerial.get(a.id) || a.apGroup || ''; }); S.clients.forEach((c) => { c.apGroup = bySerial.get(c.apSerial) || ''; });
    if (agC.error) errors.apGroups = agC.error;
  }
  S.radios = N.radioRows(S.aps);
  applyThroughput(S, ctx);
  const dev = new Map([...S.aps, ...S.switches].map((d) => [d.id, d]));
  S.alarms = alarms.map((a) => N.alarm(a, dev)).filter((a) => !a.cleared);

  const [portsC, wfcC] = await Promise.all([slowSource(ctx, 'ports', () => fetchPorts(ctx)), slowSource(ctx, 'wfcProfiles', () => r1.queryAll('/wifiCallingServiceProfiles/query', {}, { pageSize: 200 }))]);
  const bySerial = new Map(switches.map((s) => [s.serialNumber, S.switches.find((x) => x.id === s.serialNumber)]));
  const byMac = new Map(switches.map((s) => [s.switchMac, S.switches.find((x) => x.id === s.serialNumber)]));
  const [netC, dpskC, guestC, vpC, idC] = await Promise.all([
    slowSource(ctx, 'networks', () => r1.queryAll('/wifiNetworks/query', {}, { pageSize: 500 })),
    slowSource(ctx, 'dpsk', () => fetchDpsk(ctx)),
    slowSource(ctx, 'guests', () => r1.queryAll('/guestUsers/query', {}, { pageSize: 500 })),
    slowSource(ctx, 'vlanPools', () => r1.queryAll('/vlanPoolProfiles/query', {}, { pageSize: 200 })),
    slowSource(ctx, 'identityGroups', () => pagedSpring(ctx, '/identityGroups/query', {}))
  ]);
  const netNames = new Map();
  if (netC) { S.networks = netC.rows.map(N.network); S.networks.forEach((n) => netNames.set(n.id, n.name)); if (netC.error) errors.networks = netC.error; }
  else if (slow.networks) S.networks = slow.networks.rows.map(N.network);
  if (dpskC) { S.dpskPools = dpskC.rows.map((x) => N.dpskPool(x.pool)); S.dpsk = dpskC.rows.flatMap((x) => { const pl = N.dpskPool(x.pool); return x.rows.map((r) => N.dpskPass(r, pl)); }); if (dpskC.error) errors.dpsk = dpskC.error; }
  if (guestC) { S.guests = guestC.rows.map((g) => N.guest(g, netNames)); if (guestC.error) errors.guests = guestC.error; }
  if (vpC) { S.vlanPools = vpC.rows.map((v) => N.vlanPool(v, netNames)); if (vpC.error) errors.vlanPools = vpC.error; }
  if (idC) { S.identityGroups = idC.rows.map(N.identityGroup); if (idC.error) errors.identityGroups = idC.error; }

  // R1's own connection-experience analytics (experimental, undocumented): only fetched while a widget or rule needs it
  const anC = await slowSource(ctx, 'analytics', () => analytics.fetchAnalytics(r1.gql, Date.now(), S.venues.map((v) => v.name)));
  if (anC) { S.analytics = anC.rows && anC.rows.at ? anC.rows : null; if (anC.error) errors.analytics = anC.error; else if (S.analytics && Object.keys(S.analytics.errors || {}).length) errors.analytics = `partial: ${Object.entries(S.analytics.errors).map(([k, v]) => `${k} — ${v}`).join('; ')}`; }
  S.portsFresh = Boolean(portsC && portsC.fresh);
  if (portsC) { S.ports = portsC.rows.map((p) => N.port(p, byMac, bySerial)); if (portsC.error) errors.ports = portsC.error; }
  if (portsC && portsC.fresh && !portsC.error) detectPortChanges(ctx, S.ports, Date.now());
  const evC = await slowSource(ctx, 'switchEvents', () => fetchSwitchEvents(ctx));
  if (evC) { const bySer = new Map(S.switches.map((x) => [x.id, x])); S.switchEvents = evC.rows.map((e) => N.switchEvent(e, bySer)); if (evC.error) errors.switchEvents = evC.error; }
  S.portEvents = (ctx.portEvents || []).map((e) => ({ ...e }));
  if (wfcC) { S.wfcProfiles = wfcC.rows.map(N.wfcProfile); if (wfcC.error) errors.wfcProfiles = wfcC.error; }

  S.diag = diagnostics({ aps, switches, clients, alarms, venues, apGroups: agC ? agC.rows : [], traffic: S.traffic, ports: portsC ? portsC.rows : [], wfcProfiles: wfcC ? wfcC.rows : [], networks: netC ? netC.rows : [], guests: guestC ? guestC.rows : [], vlanPools: vpC ? vpC.rows : [], identityGroups: idC ? idC.rows : [], dpskPools: dpskC ? dpskC.rows.map((x) => x.pool) : [], dpskPass: dpskC ? dpskC.rows.flatMap((x) => x.rows) : [] });
  S.at = Date.now();
  return S;
}

// ---- MSP mode: one tenant per customer, merged into a single snapshot whose rows carry customerId/customer ----
const TAG_KEYS = ['switchEvents', 'portEvents', 'venues', 'aps', 'switches', 'clients', 'alarms', 'ports', 'radios', 'networks', 'dpskPools', 'dpsk', 'guests', 'vlanPools', 'identityGroups', 'wfcProfiles'];
const CORE = ['venues', 'aps', 'switches', 'clients', 'alarms'];
function mergeSnapshots(parts) {
  const S = empty(); S.customers = []; S.analyticsBy = {}; S.trafficBy = {}; S.diagBy = {}; S.source = 'r1';
  S.traffic = { dt: 0, bytes: 0, down: 0, up: 0, stats: null };
  for (const { c, S: P } of parts) {
    const tag = { customerId: c.id, customer: c.name };
    for (const k of TAG_KEYS) if (P[k] && P[k].length) S[k].push(...P[k].map((r) => Object.assign(r, tag)));
    const failed = CORE.every((k) => P.errors[k]);
    for (const [k, e] of Object.entries(P.errors || {})) S.errors[`${k}@${c.id}`] = `${c.name}: ${e}`;
    S.customers.push({ id: c.id, name: c.name, meta: c.meta || null, ok: !failed, error: failed ? (P.errors.venues || P.errors.poll || 'no data') : '', at: P.at || 0, venues: P.venues.length, aps: P.aps.length, switches: P.switches.length, clients: P.clients.length });
    if (P.analytics) S.analyticsBy[c.id] = P.analytics;
    S.trafficBy[c.id] = P.traffic; S.diagBy[c.id] = P.diag;
    S.traffic.bytes += P.traffic.bytes || 0; S.traffic.down += P.traffic.down || 0; S.traffic.up += P.traffic.up || 0; S.traffic.dt = Math.max(S.traffic.dt, P.traffic.dt || 0);
    S.portsFresh = S.portsFresh || Boolean(P.portsFresh); S.at = Math.max(S.at, P.at || 0);
  }
  // roll up: the plain key (which drives the red "R1 unreachable" banner) is set only when EVERY customer failed
  for (const k of [...CORE, 'ports', 'analytics', 'networks', 'dpsk', 'guests', 'vlanPools', 'identityGroups', 'wfcProfiles', 'apGroups']) {
    const bad = Object.entries(S.errors).filter(([e]) => e.startsWith(k + '@')); if (bad.length && bad.length === parts.length) S.errors[k] = bad[0][1];   // a plain key means "every customer failed"; partial failures stay as key@customer
  }
  S.analytics = analytics.mergeAnalytics(parts.map(({ c, S: P }) => ({ id: c.id, name: c.name, A: P.analytics })));
  S.diag = { customers: S.diagBy };
  return S;
}
async function mapLimit(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }
async function pollAll() {
  if (!cfg.mode || cfg.mode === 'single') return pollTenant(defaultCtx);            // one RUCKUS One account
  const manual = cfg.mode === 'customers' ? (cfg.customers || []).filter((c) => c.enabled) : [];
  let viaMsp = [], mspErr = '';
  if (cfg.msp.enabled) {
    try { viaMsp = (await mspDiscover()).filter((c) => !cfg.msp.exclude.includes(c.id) && (!c.status || /^active$/i.test(c.status))).map((c) => ({ id: c.id, name: c.name, enabled: true, via: 'msp', meta: c })); } catch (e) { mspErr = e.message; }
  }
  const list = [...viaMsp, ...manual];
  if (!list.length) throw new Error(cfg.msp.enabled ? `MSP account: ${mspErr || 'no active customers found'}` : 'MSP mode: no customers enabled');
  const parts = await mapLimit(list, 3, async (c) => { try { return { c, S: await pollTenant(ctxFor(c)) }; } catch (e) { const S = empty(); S.errors.poll = e.message; return { c, S }; } });
  const S = mergeSnapshots(parts);
  if (cfg.msp.enabled) { S.msp = { entitlements: mspState.entitlements, error: mspErr || mspState.error, discovered: mspState.customers.length, at: mspState.at }; if (mspErr || mspState.error) S.errors.msp = mspErr || mspState.error; }
  return S;
}

// Compact "what does R1 actually send us" report, shown by the editor's Diagnostics button.
function diagnostics(raw) {
  const tally = (rows, f) => { const m = {}; for (const r of rows) { const k = String(f(r)); m[k] = (m[k] || 0) + 1; } return m; };
  const first = (rows) => (rows[0] ? Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, v && typeof v === 'object' ? (Array.isArray(v) ? `[array ${v.length}]` : `{${Object.keys(v).join(',')}}`) : v])) : null);
  const wf = raw.clients.filter((c) => c.wifiCallingEnabled || c.wifiCallingStatus);
  return {
    counts: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.length])),
    apStatusFields: { deviceStatus: tally(raw.aps, (a) => a.deviceStatus), connectionStatus: tally(raw.aps, (a) => a.connectionStatus), status: tally(raw.aps, (a) => a.status), state: tally(raw.aps, (a) => a.state) },
    switchStatusFields: { deviceStatus: tally(raw.switches, (s) => s.deviceStatus), status: tally(raw.switches, (s) => s.status) },
    switchPoe: raw.switches.slice(0, 5).map((s) => ({ poeTotal: s.poeTotal, poeFree: s.poeFree, poeUtilization: s.poeUtilization, cpu: s.cpu, memory: s.memory, uptime: s.uptime })),
    portStatus: { status: tally(raw.ports, (p) => p.status), adminStatus: tally(raw.ports, (p) => p.adminStatus), errorDisableStatus: tally(raw.ports, (p) => p.errorDisableStatus), spanningTreeStatus: tally(raw.ports, (p) => p.spanningTreeStatus), portSpeed: tally(raw.ports, (p) => p.portSpeed) },
    wifiCalling: { clientsWithField: wf.length, carriers: tally(wf, (c) => (c.wifiCallingStatus || {}).carrierName), sample: wf[0] ? { wifiCallingEnabled: wf[0].wifiCallingEnabled, wifiCallingStatus: wf[0].wifiCallingStatus } : null },
    firstAp: first(raw.aps), firstSwitch: first(raw.switches), firstPort: first(raw.ports), firstClient: first(raw.clients), firstAlarm: first(raw.alarms), firstWfcProfile: first(raw.wifiCallingProfiles || raw.wfcProfiles),
    firstNetwork: first(raw.networks || []), throughputEngine: raw.traffic ? raw.traffic.stats : null, apRadioSample: (raw.aps[0] && raw.aps[0].radioStatuses && raw.aps[0].radioStatuses[0]) || null, apGroupsSample: first(raw.apGroups || []), clientTrafficSample: raw.clients[0] ? { trafficStatus: raw.clients[0].trafficStatus, signalStatus: raw.clients[0].signalStatus, connectedTime: raw.clients[0].connectedTime, macAddress: raw.clients[0].macAddress ? 'present' : 'MISSING' } : null, firstGuest: first(raw.guests || []), guestStatus: tally(raw.guests || [], (g) => g.guestStatus), firstVlanPool: first(raw.vlanPools || []), firstIdentityGroup: first(raw.identityGroups || []), firstDpskPool: first(raw.dpskPools || []), firstDpskPass: first(raw.dpskPass || []), dpskStatus: tally(raw.dpskPass || [], (p) => p.status)
  };
}

// Sample the headline numbers (global + per venue) for trend widgets.
const gen = require('./widgetgen');
function metricsOf(S, withDims = false) {
  const m = {};
  const put = (k, v, venue = '*') => { if (Number.isFinite(v)) m[`${k}@${venue}`] = v; };
  const up = (d) => d.status === 'Operational' || d.status === 'Degraded';
  const sig = S.clients.filter((c) => c.rssi != null);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const one = (clients, aps, switches, alarms, venue) => {
    put('clients', clients.length || aps.reduce((n, a) => n + a.clients, 0), venue);
    put('clients_24', clients.filter((c) => /2\.4/.test(c.band)).length, venue);
    put('clients_5', clients.filter((c) => /^5/.test(c.band)).length, venue);
    put('clients_6', clients.filter((c) => /^6/.test(c.band)).length, venue);
    put('aps_total', aps.length, venue); put('aps_online', aps.filter(up).length, venue);
    put('aps_offline', aps.filter((a) => a.status === 'Disconnected').length, venue);
    put('sw_total', switches.length, venue); put('sw_online', switches.filter(up).length, venue);
    put('sw_offline', switches.filter((x) => x.status === 'Disconnected').length, venue);
    put('alarms', alarms.length, venue);
    put('alarms_critical', alarms.filter((a) => a.severity === 'Critical').length, venue);
    put('alarms_major', alarms.filter((a) => a.severity === 'Major').length, venue);
    put('wfc_clients', clients.filter((c) => c.wfc).length, venue);
    const sg = clients.filter((c) => c.rssi != null);
    put('avg_rssi', avg(sg.map((c) => c.rssi)), venue);
    put('poor_signal', sg.filter((c) => c.rssi < -80).length, venue);
    const poe = switches.reduce((n, x) => n + (x.poeUsedW || 0), 0); if (poe) put('poe_watts', poe, venue);
  };
  one(S.clients, S.aps, S.switches, S.alarms, '*');
  if (S.traffic && S.traffic.dt > 0) {   // measured throughput + per-poll traffic volume (global and per venue)
    const t = S.traffic;
    put('thr_mbps', (t.bytes * 8) / t.dt / 1e6); put('thr_down_mbps', (t.down * 8) / t.dt / 1e6); put('thr_up_mbps', (t.up * 8) / t.dt / 1e6);
    put('traffic_bytes', t.bytes); put('traffic_down_bytes', t.down); put('traffic_up_bytes', t.up);
    for (const v of S.venues) { const cs = S.clients.filter((c) => c.venueId === v.id && c.mbps != null); put('thr_mbps', cs.reduce((n, c) => n + c.mbps, 0), v.id); put('traffic_bytes', cs.reduce((n, c) => n + (c.mbps * t.dt * 1e6) / 8, 0), v.id); }
    for (const [id, re] of [['24', /2\.4/], ['5', /^5/], ['6', /^6/]]) put(`thr_mbps_${id}`, S.clients.filter((c) => c.mbps != null && re.test(c.band)).reduce((n, c) => n + c.mbps, 0));
  }
  { const sg = S.clients.filter((c) => c.snr != null); if (sg.length) put('avg_snr', avg(sg.map((c) => c.snr))); const nf = S.clients.filter((c) => c.noiseFloor != null); if (nf.length) put('avg_noise', avg(nf.map((c) => c.noiseFloor))); }
  for (const [id, re] of [['24', /2\.4/], ['5', /^5/], ['6', /^6/]]) { const b = S.clients.filter((c) => re.test(c.band) && c.rssi != null); if (b.length) { put(`avg_rssi_${id}`, avg(b.map((c) => c.rssi))); put(`avg_snr_${id}`, avg(b.filter((c) => c.snr != null).map((c) => c.snr))); } }
  put('wfc_bytes', S.clients.reduce((n, c) => n + c.wfcBytes, 0));
  if (S.portsFresh) { const ps = S.ports.filter((x) => x.mbps != null); if (ps.length) { put('sw_thr_mbps', ps.reduce((n, x) => n + x.mbps, 0)); put('sw_errors', S.ports.reduce((n, x) => n + (x.errDelta || 0), 0)); } }
  if (S.ports.length) { put('ports_up', S.ports.filter((p) => p.state === 'Up').length); put('ports_total', S.ports.length); put('ports_err', S.ports.filter((p) => p.errors > 0).length); }
  for (const v of S.venues) one(S.clients.filter((c) => c.venueId === v.id), S.aps.filter((a) => a.venueId === v.id), S.switches.filter((x) => x.venueId === v.id), S.alarms.filter((a) => a.venueId === v.id), v.id);
  for (const c of S.customers || []) {   // MSP mode: the same headline series per customer, keyed @c:<id>
    const mine = (rows) => rows.filter((r) => r.customerId === c.id); one(mine(S.clients), mine(S.aps), mine(S.switches), mine(S.alarms), `c:${c.id}`);
    const t = (S.trafficBy || {})[c.id]; if (t && t.dt > 0) put('thr_mbps', (t.bytes * 8) / t.dt / 1e6, `c:${c.id}`);
  }
  if (S.dpsk.length) { put('dpsk_active', S.dpsk.filter((p) => p.active).length); put('dpsk_devices', S.dpsk.filter((p) => p.active).reduce((n, p) => n + p.devices, 0)); }
  if (S.guests.length) put('guests_active', S.guests.filter((g) => !g.expired).length);
  if (S.identityGroups.length) put('identities', S.identityGroups.reduce((n, g) => n + g.identities, 0));
  if (withDims) Object.assign(m, gen.dimMetrics(S));   // category-over-time series, recorded less often
  return m;
}

let busy = false;
let tick = 0;
async function poll(onUpdate) {
  if (busy) return;
  busy = true;
  try {
    const S = cfg.demo ? require('./demo').tick() : await pollAll();
    snapshot = S;
    if (S.at && !(['venues', 'aps', 'switches', 'clients', 'alarms'].every((k) => S.errors[k]))) history.record(S.at, metricsOf(S, tick++ % 5 === 0));
    onUpdate && onUpdate(S);
  } catch (e) {
    snapshot = { ...snapshot, errors: { poll: e.message } };
    onUpdate && onUpdate(snapshot);
  } finally { busy = false; }
}

module.exports = { poll, get: () => snapshot, metricsOf, setNeeds, _applyThroughput: applyThroughput, _stampPortRates: stampPortRates, _mergeSnapshots: mergeSnapshots, _detectPortChanges: detectPortChanges, _makeCtx: makeCtx, mspInfo, mspRefresh };
