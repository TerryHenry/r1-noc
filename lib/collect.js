'use strict';
// Poll R1 (or the demo generator), normalise into a Snapshot, record history.
// "Heavy" sources (switch ports, Wi-Fi calling profiles) are only fetched when a widget on
// some screen needs them, and are cached longer than the main poll.
const cfg = require('./config');
const history = require('./history');
const r1 = require('./r1');
const N = require('./normalize');

const ALARM_FIELDS = ['id', 'severity', 'startTime', 'clearTime', 'entityType', 'entityId', 'serialNumber', 'name', 'message'];
const PORT_FIELDS = ['id', 'switchName', 'switchSerial', 'switchMac', 'venueId', 'portIdentifier', 'name', 'status', 'adminStatus', 'poeUsed', 'poeTotal', 'signalIn', 'signalOut', 'inErr', 'outErr', 'crcErr', 'portSpeed', 'errorDisableStatus', 'spanningTreeStatus', 'neighborName', 'neighborMacAddress', 'mediaType', 'unTaggedVlan', 'switchPortProfileName', 'lagName'];
const TTL = { ports: 180e3, wfcProfiles: 600e3, networks: 300e3, dpsk: 300e3, guests: 300e3, vlanPools: 600e3, identityGroups: 600e3 };

const empty = () => ({ at: 0, venues: [], aps: [], switches: [], clients: [], alarms: [], ports: [], wfcProfiles: [], networks: [], dpskPools: [], dpsk: [], guests: [], vlanPools: [], identityGroups: [], errors: {}, source: cfg.demo ? 'demo' : 'r1' });
let snapshot = empty();
let needs = new Set();       // 'ports' | 'wfcProfiles'
const slow = {};             // name -> { at, rows, error }

const setNeeds = (set) => { needs = new Set(set); };

async function slowSource(name, fetcher) {
  if (!needs.has(name)) return null;
  const c = slow[name];
  if (c && Date.now() - c.at < TTL[name]) return c;
  try { slow[name] = { at: Date.now(), rows: await fetcher(), error: null }; }
  catch (e) { slow[name] = { at: c ? c.at : Date.now(), rows: c ? c.rows : [], error: e.message }; }
  return slow[name];
}

async function fetchPorts() {
  try { return await r1.queryAll('/venues/switches/switchPorts/query', { fields: PORT_FIELDS }, { pageSize: 1000, maxPages: 60 }); }
  catch (e) {
    if (!/HTTP 4\d\d/.test(e.message)) throw e;
    return r1.queryAll('/venues/switches/switchPorts/query', {}, { pageSize: 1000, maxPages: 60 }); // retry without `fields`
  }
}

// DPSK pagination is 0-indexed ({page, pageSize}); a pool's passphrases are queried per pool.
async function pagedZero(path, body, { pageSize = 500, maxPages = 40 } = {}) {
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
async function pagedSpring(path, body, { size = 200, maxPages = 40 } = {}) {
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await r1.post(`${path}${path.includes('?') ? '&' : '?'}page=${page}&size=${size}`, body);
    rows.push(...((res && res.content) || []));
    if (!res || res.last !== false || !(res.content || []).length) break;
  }
  return rows;
}
async function fetchDpsk() {
  const pools = await pagedZero('/dpskServices/query', {}, { pageSize: 200 });
  const out = [];
  for (const pool of pools.slice(0, 30)) {
    const rows = await pagedZero(`/dpskServices/${pool.id}/passphrases/query`, { maxDevicesPerPassphrase: 25 }, { pageSize: 500, maxPages: 20 });
    out.push({ pool, rows });
  }
  return out;
}

async function pollR1() {
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
  const dev = new Map([...S.aps, ...S.switches].map((d) => [d.id, d]));
  S.alarms = alarms.map((a) => N.alarm(a, dev)).filter((a) => !a.cleared);

  const [portsC, wfcC] = await Promise.all([slowSource('ports', fetchPorts), slowSource('wfcProfiles', () => r1.queryAll('/wifiCallingServiceProfiles/query', {}, { pageSize: 200 }))]);
  const bySerial = new Map(switches.map((s) => [s.serialNumber, S.switches.find((x) => x.id === s.serialNumber)]));
  const byMac = new Map(switches.map((s) => [s.switchMac, S.switches.find((x) => x.id === s.serialNumber)]));
  const [netC, dpskC, guestC, vpC, idC] = await Promise.all([
    slowSource('networks', () => r1.queryAll('/wifiNetworks/query', {}, { pageSize: 500 })),
    slowSource('dpsk', fetchDpsk),
    slowSource('guests', () => r1.queryAll('/guestUsers/query', {}, { pageSize: 500 })),
    slowSource('vlanPools', () => r1.queryAll('/vlanPoolProfiles/query', {}, { pageSize: 200 })),
    slowSource('identityGroups', () => pagedSpring('/identityGroups/query', {}))
  ]);
  const netNames = new Map();
  if (netC) { S.networks = netC.rows.map(N.network); S.networks.forEach((n) => netNames.set(n.id, n.name)); if (netC.error) errors.networks = netC.error; }
  else if (slow.networks) S.networks = slow.networks.rows.map(N.network);
  if (dpskC) { S.dpskPools = dpskC.rows.map((x) => N.dpskPool(x.pool)); S.dpsk = dpskC.rows.flatMap((x) => { const pl = N.dpskPool(x.pool); return x.rows.map((r) => N.dpskPass(r, pl)); }); if (dpskC.error) errors.dpsk = dpskC.error; }
  if (guestC) { S.guests = guestC.rows.map((g) => N.guest(g, netNames)); if (guestC.error) errors.guests = guestC.error; }
  if (vpC) { S.vlanPools = vpC.rows.map((v) => N.vlanPool(v, netNames)); if (vpC.error) errors.vlanPools = vpC.error; }
  if (idC) { S.identityGroups = idC.rows.map(N.identityGroup); if (idC.error) errors.identityGroups = idC.error; }

  if (portsC) { S.ports = portsC.rows.map((p) => N.port(p, byMac, bySerial)); if (portsC.error) errors.ports = portsC.error; }
  if (wfcC) { S.wfcProfiles = wfcC.rows.map(N.wfcProfile); if (wfcC.error) errors.wfcProfiles = wfcC.error; }

  S.diag = diagnostics({ aps, switches, clients, alarms, venues, ports: portsC ? portsC.rows : [], wfcProfiles: wfcC ? wfcC.rows : [], networks: netC ? netC.rows : [], guests: guestC ? guestC.rows : [], vlanPools: vpC ? vpC.rows : [], identityGroups: idC ? idC.rows : [], dpskPools: dpskC ? dpskC.rows.map((x) => x.pool) : [], dpskPass: dpskC ? dpskC.rows.flatMap((x) => x.rows) : [] });
  S.at = Date.now();
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
    firstNetwork: first(raw.networks || []), firstGuest: first(raw.guests || []), guestStatus: tally(raw.guests || [], (g) => g.guestStatus), firstVlanPool: first(raw.vlanPools || []), firstIdentityGroup: first(raw.identityGroups || []), firstDpskPool: first(raw.dpskPools || []), firstDpskPass: first(raw.dpskPass || []), dpskStatus: tally(raw.dpskPass || [], (p) => p.status)
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
  put('wfc_bytes', S.clients.reduce((n, c) => n + c.wfcBytes, 0));
  if (S.ports.length) { put('ports_up', S.ports.filter((p) => p.state === 'Up').length); put('ports_total', S.ports.length); put('ports_err', S.ports.filter((p) => p.errors > 0).length); }
  for (const v of S.venues) one(S.clients.filter((c) => c.venueId === v.id), S.aps.filter((a) => a.venueId === v.id), S.switches.filter((x) => x.venueId === v.id), S.alarms.filter((a) => a.venueId === v.id), v.id);
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
    const S = cfg.demo ? require('./demo').tick() : await pollR1();
    snapshot = S;
    if (S.at && !(['venues', 'aps', 'switches', 'clients', 'alarms'].every((k) => S.errors[k]))) history.record(S.at, metricsOf(S, tick++ % 5 === 0));
    onUpdate && onUpdate(S);
  } catch (e) {
    snapshot = { ...snapshot, errors: { poll: e.message } };
    onUpdate && onUpdate(snapshot);
  } finally { busy = false; }
}

module.exports = { poll, get: () => snapshot, metricsOf, setNeeds };
