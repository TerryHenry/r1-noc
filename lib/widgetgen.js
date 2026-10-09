'use strict';
// Declarative widget generator. Instead of hand-writing hundreds of near-identical widgets, we describe
//   entities (clients, APs, switches, ports, alarms, DPSK, guests, networks, identity groups),
//   their dimensions (SSID, OS, VLAN, model…) and measures (count, traffic, PoE W, avg signal…)
// and expand them into donut / bar / table widgets, plus KPI scorecards and over-time trends.
// Every field referenced here is a normalised field from lib/normalize.js.
const history = require('./history');
const { bandName } = require('./normalize');

// ---------------- formatting ----------------
const nfmt = new Intl.NumberFormat();
const f = {
  num: (v) => nfmt.format(Math.round(v)),
  bytes: (b) => { if (!b) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1000 && i < 4) { b /= 1000; i++; } return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`; },
  db: (v) => `${Math.round(v * 10) / 10} dB`,
  mbps: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} Gbps` : v >= 100 ? `${Math.round(v)} Mbps` : `${Math.round(v * 10) / 10} Mbps`),
  hours: (h) => (h >= 48 ? `${Math.round(h / 24)} d` : h >= 1 ? `${Math.round(h * 10) / 10} h` : `${Math.max(1, Math.round(h * 60))} min`),
  ms: (v) => (v >= 1000 ? `${Math.round(v / 100) / 10} s` : `${Math.round(v)} ms`),
  dbmTx: (v) => `${Math.round(v * 10) / 10} dBm`,
  watts: (w) => `${w >= 100 ? Math.round(w) : Math.round(w * 10) / 10} W`,
  dbm: (v) => `${Math.round(v)} dBm`,
  pct: (v) => `${Math.round(v * 10) / 10}%`,
  dur: (sec) => { if (sec == null) return '—'; const d = Math.floor(sec / 86400); return d >= 1 ? `${d}d` : sec >= 3600 ? `${Math.floor(sec / 3600)}h` : `${Math.max(1, Math.floor(sec / 60))}m`; },
  ago: (t) => { if (!t) return ''; const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; },
  until: (t) => { if (!t) return 'never'; const s = (t - Date.now()) / 1000; return s < 0 ? 'expired' : s < 5400 ? `${Math.max(1, Math.round(s / 60))}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; }
};
const DAY = 86400e3;
const up = (d) => d.status === 'Operational' || d.status === 'Degraded';

// ---------------- helpers ----------------
const inV = (rows, v) => (v ? rows.filter((r) => r.venueId === v) : rows);
const clampN = (n, d) => Math.max(1, Math.min(50, Number(n) || d));
const venueTitle = (S, v, base) => (v ? `${base} — ${(S.venues.find((x) => x.id === v) || {}).name || v}` : base);
const uniq = (rows, g) => new Set(rows.map(g).filter(Boolean)).size;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const bucket = (v, edges, labels) => { for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i]; return labels[labels.length - 1]; };

// ---------------- entities ----------------
const M = {
  count:   { id: 'count', label: 'count', agg: 'sum', val: () => 1, fmt: f.num },
  traffic: { id: 'traffic', label: 'traffic', agg: 'sum', val: (r) => r.bytes, fmt: f.bytes },
  rssi:    { id: 'rssi', label: 'avg signal', agg: 'avg', val: (r) => r.rssi, fmt: f.dbm, asc: true, noDonut: true },
  clients: { id: 'clients', label: 'clients', agg: 'sum', val: (r) => r.clients, fmt: f.num },
  ports:   { id: 'ports', label: 'ports', agg: 'sum', val: (r) => r.ports, fmt: f.num },
  poe:     { id: 'poe', label: 'PoE draw', agg: 'sum', val: (r) => r.poeUsedW, fmt: f.watts },
  cpu:     { id: 'cpu', label: 'avg CPU', agg: 'avg', val: (r) => r.cpu, fmt: f.pct, noDonut: true },
  mem:     { id: 'mem', label: 'avg memory', agg: 'avg', val: (r) => r.memory, fmt: f.pct, noDonut: true },
  portMbps: { id: 'portMbps', label: 'traffic', agg: 'sum', val: (r) => r.mbps, fmt: f.mbps },
  portPoe: { id: 'portPoe', label: 'PoE draw', agg: 'sum', val: (r) => r.poeUsedW, fmt: f.watts },
  errors:  { id: 'errors', label: 'errors', agg: 'sum', val: (r) => r.errors, fmt: f.num },
  util:    { id: 'util', label: 'avg utilization', agg: 'avg', val: (r) => r.utilPct, fmt: f.pct, noDonut: true },
  devices: { id: 'devices', label: 'devices', agg: 'sum', val: (r) => r.devices, fmt: f.num },
  online:  { id: 'online', label: 'devices online', agg: 'sum', val: (r) => r.online, fmt: f.num },
  identities: { id: 'identities', label: 'identities', agg: 'sum', val: (r) => r.identities, fmt: f.num },
  netClients: { id: 'netClients', label: 'clients', agg: 'sum', val: (r) => r.clients, fmt: f.num },
  snr:     { id: 'snr', label: 'avg SNR', agg: 'avg', val: (r) => r.snr, fmt: f.db, noDonut: true, only: 'rf' },
  noise:   { id: 'noise', label: 'avg noise floor', agg: 'avg', val: (r) => r.noiseFloor, fmt: f.dbm, noDonut: true, only: 'rf' },
  rssiMin: { id: 'rssiMin', label: 'weakest signal', agg: 'min', val: (r) => r.rssi, fmt: f.dbm, asc: true, noDonut: true, only: 'rf' },
  rssiMax: { id: 'rssiMax', label: 'strongest signal', agg: 'max', val: (r) => r.rssi, fmt: f.dbm, noDonut: true, only: 'rf' },
  connected: { id: 'connected', label: 'avg time connected', agg: 'avg', val: (r) => (r.connectedAt ? (Date.now() - r.connectedAt) / 3600e3 : null), fmt: f.hours, noDonut: true, only: 'rf' },
  mbps:    { id: 'mbps', label: 'throughput', agg: 'sum', val: (r) => r.mbps, fmt: f.mbps },
  mbpsAvg: { id: 'mbpsAvg', label: 'avg throughput per client', agg: 'avg', val: (r) => r.mbps, fmt: f.mbps, noDonut: true, only: 'rf' },
  txPower: { id: 'txPower', label: 'avg TX power', agg: 'avg', val: (r) => r.txPower, fmt: f.dbmTx, noDonut: true },
  netAps:  { id: 'netAps', label: 'APs', agg: 'sum', val: (r) => r.aps, fmt: f.num }
};

const rssiBucket = (r) => (r.rssi == null ? null : bucket(r.rssi, [-80, -70, -60], ['Poor (< -80)', 'Fair (-80…-70)', 'Good (-70…-60)', 'Excellent (> -60)']));
const snrBucket = (r) => (r.snr == null ? null : bucket(r.snr, [15, 25, 35], ['Poor (< 15 dB)', 'Fair (15–25)', 'Good (25–35)', 'Excellent (> 35)']));
const expBucket = (t) => (t == null ? 'No expiry' : bucket(t - Date.now(), [0, DAY, 7 * DAY, 30 * DAY, 90 * DAY], ['Expired', '< 1 day', '1–7 days', '7–30 days', '30–90 days', '90+ days']));

const ENT = {
  clients: { label: 'Clients', single: 'Client', plural: 'clients', venue: true, rows: (S) => S.clients, table: [M.count, M.mbps, M.traffic, M.rssi, M.snr], measures: [M.count, M.traffic, M.mbps, M.rssi, M.snr, M.rssiMin, M.connected], dims: [
    ['ssid', 'SSID', (r) => r.ssid], ['os', 'OS', (r) => r.os], ['band', 'band', (r) => r.band], ['channel', 'channel', (r) => (r.channel == null ? null : `Ch ${r.channel}`)],
    ['vendor', 'manufacturer', (r) => r.vendor], ['model', 'device model', (r) => r.model], ['devType', 'device type', (r) => r.devType], ['ap', 'AP', (r) => r.ap],
    ['venue', 'venue', (r, c) => c.vname.get(r.venueId) || r.venueId], ['signal', 'signal quality', rssiBucket], ['snr', 'SNR quality', snrBucket],
    ['security', 'security method', (r) => r.security], ['radioType', 'radio mode', (r) => r.radioType], ['health', 'connection health', (r) => r.health],
    ['identityGroup', 'identity group', (r) => r.identityGroup || null], ['vlan', 'VLAN', (r) => r.vlan || null],
    ['apGroup', 'AP group', (r) => r.apGroup || 'Unassigned'], ['venueGroup', 'venue / AP group', (r, c) => `${c.vname.get(r.venueId) || r.venueId} / ${r.apGroup || 'Unassigned'}`],
    ['venueGroupBand', 'venue / AP group / band', (r, c) => `${c.vname.get(r.venueId) || r.venueId} / ${r.apGroup || 'Unassigned'} / ${r.band || '?'}`],
    ['venueGroupChannel', 'venue / AP group / channel', (r, c) => `${c.vname.get(r.venueId) || r.venueId} / ${r.apGroup || 'Unassigned'} / ${r.channel == null ? '?' : 'Ch ' + r.channel}`], ['wfcCarrier', 'Wi-Fi calling carrier', (r) => (r.wfc ? r.wfcCarrier || 'Unknown carrier' : null)] ] },
  aps: { label: 'APs', single: 'AP', plural: 'APs', venue: true, rows: (S) => S.aps, table: [M.count, M.clients], measures: [M.count, M.clients], dims: [
    ['model', 'model', (r) => r.model], ['firmware', 'firmware', (r) => r.firmware], ['status', 'status', (r) => r.status], ['health', 'health', (r) => r.health],
    ['venue', 'venue', (r, c) => c.vname.get(r.venueId) || r.venueId], ['mesh', 'mesh role', (r) => r.meshRole],
    ['load', 'client load', (r) => bucket(r.clients, [1, 6, 16, 31], ['0 clients', '1–5', '6–15', '16–30', '31+'])] ] },
  radios: { label: 'AP radios', single: 'Radio', plural: 'radios', venue: true, rows: (S) => S.radios, table: [M.count, M.txPower], measures: [M.count, M.txPower], dims: [
    ['band', 'band', (r) => r.band], ['channel', 'channel', (r) => (r.channel == null ? null : `Ch ${r.channel}`)], ['width', 'channel width', (r) => r.width || null],
    ['bandChannel', 'band / channel', (r) => (r.channel == null ? null : `${r.band} · Ch ${r.channel}`)], ['bandChannelWidth', 'band / channel / width', (r) => (r.channel == null ? null : `${r.band} · Ch ${r.channel}${r.width ? ' · ' + r.width : ''}`)],
    ['venue', 'venue', (r, c) => c.vname.get(r.venueId) || r.venueId], ['apGroup', 'AP group', (r) => r.apGroup || 'Unassigned'], ['venueGroup', 'venue / AP group', (r, c) => `${c.vname.get(r.venueId) || r.venueId} / ${r.apGroup || 'Unassigned'}`],
    ['venueGroupChannel', 'venue / AP group / channel', (r, c) => `${c.vname.get(r.venueId) || r.venueId} / ${r.apGroup || 'Unassigned'} / ${r.channel == null ? '?' : 'Ch ' + r.channel}`],
    ['txBucket', 'TX power', (r) => (r.txPower == null ? null : bucket(r.txPower, [10, 16, 21], ['< 10 dBm', '10–15 dBm', '16–20 dBm', '21+ dBm']))] ] },
  switches: { label: 'Switches', single: 'Switch', plural: 'switches', venue: true, rows: (S) => S.switches, table: [M.count, M.ports, M.poe, M.cpu], measures: [M.count, M.ports, M.poe, M.cpu, M.mem], dims: [
    ['name', 'switch', (r) => r.name], ['model', 'model', (r) => r.model], ['firmware', 'firmware', (r) => r.firmware], ['status', 'status', (r) => r.status], ['venue', 'venue', (r, c) => c.vname.get(r.venueId) || r.venueId],
    ['family', 'family', (r) => r.family], ['type', 'role', (r) => r.switchType], ['stack', 'stack / standalone', (r) => r.stack],
    ['uptime', 'uptime', (r) => (r.uptimeSec == null ? null : bucket(r.uptimeSec, [DAY / 1000, 7 * DAY / 1000, 30 * DAY / 1000, 90 * DAY / 1000], ['< 1 day', '1–7 days', '7–30 days', '30–90 days', '90+ days']))] ] },
  ports: { label: 'Ports', single: 'Port', plural: 'ports', venue: true, needs: ['ports'], rows: (S) => S.ports, table: [M.count, M.portMbps, M.portPoe, M.errors], measures: [M.count, M.portMbps, M.portPoe, M.errors, M.util], dims: [
    ['model', 'switch model', (r) => r.model || null], ['modelSpeed', 'switch model / port speed', (r) => (r.state === 'Up' && r.model ? `${r.model} · ${r.speed || '?'}` : null)],
    ['state', 'state', (r) => r.state], ['speed', 'link speed', (r) => (r.state === 'Up' ? r.speed || 'Unknown' : null)], ['switch', 'switch', (r) => r.switchName], ['venue', 'venue', (r, c) => c.vname.get(r.venueId) || r.venueId],
    ['neighbor', 'LLDP neighbor presence', (r) => r.hasNeighbor], ['media', 'media type', (r) => r.media], ['vlan', 'untagged VLAN', (r) => (r.vlan ? `VLAN ${r.vlan}` : null)], ['profile', 'port profile', (r) => r.profile || null], ['lag', 'LAG membership', (r) => r.lag] ] },
  alarms: { label: 'Alarms', single: 'Alarm', plural: 'alarms', venue: true, rows: (S) => S.alarms, table: [M.count], measures: [M.count], dims: [
    ['severity', 'severity', (r) => r.severity], ['entity', 'device type', (r) => r.entityType], ['venue', 'venue', (r, c) => r.venue || c.vname.get(r.venueId) || null], ['device', 'device', (r) => r.device],
    ['kind', 'alarm type', (r) => r.kind || null], ['age', 'age', (r) => (r.time ? bucket(Date.now() - r.time, [3600e3, 6 * 3600e3, DAY, 7 * DAY], ['< 1 hour', '1–6 hours', '6–24 hours', '1–7 days', '7+ days']) : null)] ] },
  dpsk: { label: 'DPSK users', single: 'DPSK user', plural: 'DPSK users', needs: ['dpsk'], rows: (S) => S.dpsk.filter((p) => p.active), table: [M.count, M.devices, M.online], measures: [M.count, M.devices, M.online], dims: [
    ['pool', 'pool', (r) => r.pool], ['vlan', 'VLAN', (r) => r.vlan || 'No VLAN'], ['expiry', 'time to expiry', (r) => expBucket(r.expiresAt)], ['limit', 'device limit', (r) => (r.deviceLimit ? `${r.deviceLimit} device${r.deviceLimit > 1 ? 's' : ''}` : null)],
    ['seen', 'recent activity', (r) => (r.seenRecently ? 'Seen in last 24h' : 'Not seen in 24h')], ['devs', 'devices used', (r) => bucket(r.devices, [1, 2, 4], ['0 devices', '1 device', '2–3 devices', '4+ devices'])] ] },
  guests: { label: 'Guest users', single: 'Guest', plural: 'guest users', needs: ['guests', 'networks'], rows: (S) => S.guests.filter((g) => !g.expired), table: [M.count, M.devices], measures: [M.count, M.devices], dims: [
    ['type', 'guest type', (r) => r.type], ['status', 'status', (r) => r.status], ['network', 'network', (r) => r.network || 'Unknown network'], ['expiry', 'time to expiry', (r) => expBucket(r.expiry)], ['social', 'login method', (r) => (r.social ? 'Social login' : 'Guest pass')] ] },
  networks: { label: 'Wi-Fi networks', single: 'Network', plural: 'networks', needs: ['networks'], rows: (S) => S.networks, table: [M.count, M.netClients, M.netAps], measures: [M.count, M.netClients, M.netAps], dims: [
    ['type', 'type', (r) => r.type], ['security', 'security', (r) => r.security], ['captive', 'captive portal', (r) => r.captive || 'None'], ['vlan', 'VLAN', (r) => r.vlan || 'No VLAN'], ['name', 'SSID', (r) => r.ssid] ] },
  identities: { label: 'Identity groups', single: 'Identity group', plural: 'identity groups', needs: ['identityGroups'], rows: (S) => S.identityGroups, table: [M.count, M.identities], measures: [M.count, M.identities], dims: [
    ['name', 'group', (r) => r.name], ['kind', 'credential type', (r) => r.dpsk || r.macReg || 'Other'], ['cleanup', 'auto-cleanup', (r) => (r.autoCleanup ? 'Auto-cleanup on' : 'Off')] ] }
};
const RF_DIMS = new Set(['band', 'ssid', 'ap', 'venue', 'apGroup', 'venueGroup', 'venueGroupBand', 'venueGroupChannel', 'channel', 'os', 'vendor', 'radioType']);   // where the signal-quality measures make sense

// ---------------- aggregation ----------------
function aggregate(rows, dim, measure, ctx) {
  const m = new Map();
  for (const r of rows) {
    const k = dim(r, ctx); if (k === null || k === undefined) continue;
    const key = k === '' ? 'Unknown' : k;
    const v = measure.val(r); if (v === null || v === undefined || Number.isNaN(v)) continue;
    const e = m.get(key) || { s: 0, n: 0, lo: Infinity, hi: -Infinity }; e.s += v; e.n++; if (v < e.lo) e.lo = v; if (v > e.hi) e.hi = v; m.set(key, e);
  }
  const out = [...m].map(([label, e]) => ({ label, value: measure.agg === 'avg' ? e.s / e.n : measure.agg === 'min' ? e.lo : measure.agg === 'max' ? e.hi : e.s }));
  out.sort((a, b) => (measure.asc ? a.value - b.value : b.value - a.value));
  return out;
}
const withText = (items, fmt) => items.map((i) => ({ ...i, value: Math.round(i.value * 100) / 100, text: fmt(i.value) }));
const topNOther = (items, n) => { if (items.length <= n) return items; const head = items.slice(0, n); const rest = items.slice(n).reduce((s, i) => s + i.value, 0); return rest ? [...head, { label: `Other (${items.length - n})`, value: rest }] : head; };

function titleOf(ent, dim, m) { return m.id === 'count' ? `${ent.label} by ${dim[1]}` : `${ent.single} ${m.label} by ${dim[1]}`; }

function buildCompute(ent, dim, measure, form) {
  return (S, venue, params) => {
    const ctx = { vname: new Map(S.venues.map((v) => [v.id, v.name])) };
    let rows = ent.rows(S); if (ent.venue && venue) rows = rows.filter((r) => r.venueId === venue);
    rows = byMatch(rows, params._match);
    const title = ent.venue ? venueTitle(S, venue, titleOf(ent, dim, measure)) : titleOf(ent, dim, measure);
    if (form === 'table') {
      const cols = ent.table; const first = aggregate(rows, dim[2], cols[0], ctx);
      const per = cols.map((c) => new Map(aggregate(rows, dim[2], c, ctx).map((i) => [i.label, i.value])));
      return { kind: 'table', title: `${ent.label} by ${dim[1]}`, columns: [cap(dim[1]), ...cols.map((c) => cap(c.label))], rows: first.slice(0, clampN(params.n, 10)).map((i) => ({ cells: [i.label, ...cols.map((c, ci) => (per[ci].has(i.label) ? c.fmt(per[ci].get(i.label)) : '—'))] })) };
    }
    let items = aggregate(rows, dim[2], measure, ctx);
    if (params.hideUnknown) items = items.filter((i) => !/^unknown/i.test(i.label));
    if (form === 'donut') {
      const top = topNOther(items, clampN(params.n, 6)); const total = items.reduce((s, i) => s + i.value, 0);
      return { kind: 'donut', title, items: withText(top, measure.fmt), centerLabel: measure.id === 'count' ? ent.plural : measure.label, center: Math.round(total), centerText: measure.fmt(total) };
    }
    return { kind: 'bar', title, items: withText(items.slice(0, clampN(params.n, 8)), measure.fmt), max: measure.fmt === f.pct ? 100 : undefined };
  };
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// Optional per-widget text filter: keep rows whose AP group name contains it (case-insensitive). Mirrors Data Studio's "apGroupName ILIKE %text%".
function byMatch(rows, text) { const t = String(text || '').trim().toLowerCase(); return t && rows.length && 'apGroup' in rows[0] ? rows.filter((r) => String(r.apGroup || '').toLowerCase().includes(t)) : rows; }

// ---------------- entity × dim × measure × form ----------------
function entityWidgets() {
  const out = [];
  for (const [eid, ent] of Object.entries(ENT)) {
    for (const dim of ent.dims) {
      const base = { group: ent.label, sub: `By ${dim[1]}`, needs: ent.needs || [], match: ent.rows.length > 0 && ['clients', 'aps', 'radios'].includes(eid), params: [{ name: 'n', label: 'Show top', default: 8 }, { name: 'hideUnknown', label: 'Hide Unknown (1 = yes)', default: 0 }] };
      for (const m of ent.measures) {
        if (m.only === 'rf' && !RF_DIMS.has(dim[0])) continue;
        if (!m.noDonut) out.push({ ...base, type: `g.${eid}.${dim[0]}.${m.id}.donut`, title: `${titleOf(ent, dim, m)} (donut)`, w: 3, h: 4, compute: buildCompute(ent, dim, m, 'donut') });
        out.push({ ...base, type: `g.${eid}.${dim[0]}.${m.id}.bar`, title: `${titleOf(ent, dim, m)} (bars)`, w: 4, h: 4, compute: buildCompute(ent, dim, m, 'bar') });
      }
      out.push({ ...base, type: `g.${eid}.${dim[0]}.table`, title: `${ent.label} by ${dim[1]} (table)`, w: 6, h: 4, compute: buildCompute(ent, dim, ent.measures[0], 'table') });
    }
  }
  return out;
}

// ---------------- KPI scorecards ----------------
const KPI = [];
const kpi = (group, id, title, fn, needs = []) => KPI.push({ group, id, title, fn, needs });
const tone = (bad, warn) => (bad ? 'bad' : warn ? 'warn' : 'ok');

// Clients
kpi('Clients', 'total', 'Connected clients', (h) => ({ value: h.clients.length || h.aps.reduce((n, a) => n + a.clients, 0) }));
for (const [id, label, re] of [['b24', '2.4 GHz clients', /2\.4/], ['b5', '5 GHz clients', /^5/], ['b6', '6 GHz clients', /^6/]]) kpi('Clients', id, label, (h) => ({ value: h.clients.filter((c) => re.test(c.band)).length }));
kpi('Clients', 'pct5', 'Clients on 5/6 GHz', (h) => { const n = h.clients.length; const v = h.clients.filter((c) => /^[56]/.test(c.band)).length; return { value: n ? Math.round(v / n * 100) : '—', suffix: n ? '%' : '' }; });
kpi('Clients', 'rssi', 'Average client signal', (h) => { const a = avg(h.clients.filter((c) => c.rssi != null).map((c) => c.rssi)); return { value: a == null ? '—' : Math.round(a), suffix: a == null ? '' : 'dBm', tone: a != null && a < -72 ? 'warn' : undefined }; });
kpi('Clients', 'snr', 'Average client SNR', (h) => { const a = avg(h.clients.filter((c) => c.snr != null).map((c) => c.snr)); return { value: a == null ? '—' : Math.round(a), suffix: a == null ? '' : 'dB' }; });
kpi('Clients', 'poor', 'Clients with poor signal', (h) => { const n = h.clients.filter((c) => c.rssi != null && c.rssi < -80).length; return { value: n, suffix: 'below -80 dBm', tone: n ? 'warn' : 'ok' }; });
kpi('Clients', 'poorPct', 'Poor-signal share', (h) => { const s = h.clients.filter((c) => c.rssi != null); const n = s.filter((c) => c.rssi < -80).length; return { value: s.length ? Math.round(n / s.length * 1000) / 10 : '—', suffix: s.length ? '%' : '', tone: s.length && n / s.length > 0.15 ? 'warn' : 'ok' }; });
kpi('Clients', 'traffic', 'Client traffic (live sessions)', (h) => ({ value: f.bytes(h.clients.reduce((n, c) => n + c.bytes, 0)) }));
kpi('Clients', 'perClient', 'Average traffic per client', (h) => ({ value: h.clients.length ? f.bytes(h.clients.reduce((n, c) => n + c.bytes, 0) / h.clients.length) : '—' }));
kpi('Clients', 'ssids', 'SSIDs in use', (h) => ({ value: uniq(h.clients, (c) => c.ssid) }));
kpi('Clients', 'vendors', 'Distinct manufacturers', (h) => ({ value: uniq(h.clients, (c) => c.vendor && !/^Private|^Unknown/.test(c.vendor) && c.vendor) }));
kpi('Clients', 'models', 'Distinct device models', (h) => ({ value: uniq(h.clients, (c) => c.model) }));
kpi('Clients', 'random', 'Clients using private MACs', (h) => { const n = h.clients.filter((c) => /^Private/.test(c.vendor)).length; return { value: h.clients.length ? Math.round(n / h.clients.length * 100) : '—', suffix: h.clients.length ? '%' : '' }; });
for (const os of ['iOS', 'Android', 'Windows', 'macOS']) kpi('Clients', `os_${os}`, `${os} clients`, (h) => ({ value: h.clients.filter((c) => c.os === os).length }));
kpi('Clients', 'perAp', 'Average clients per AP', (h) => { const a = h.aps.filter((x) => x.status === 'Operational'); return { value: a.length ? Math.round(a.reduce((n, x) => n + x.clients, 0) / a.length * 10) / 10 : '—' }; });
kpi('Clients', 'maxAp', 'Most clients on one AP', (h) => { const t = h.aps.slice().sort((a, b) => b.clients - a.clients)[0]; return { value: t ? t.clients : '—', suffix: t ? t.name : '', tone: t && t.clients > 40 ? 'warn' : undefined }; });
// Throughput & traffic (measured from counter deltas between polls) and RF quality
const sumHist = (key, ms) => { const now = Date.now(); return history.range(key, now - ms, now).reduce((n, r) => n + r[1], 0); };
const hasThr = (h) => h.clients.some((c) => c.mbps != null);
kpi('Throughput', 'now', 'Client throughput now', (h) => (hasThr(h) ? { value: Math.round(h.clients.reduce((n, c) => n + (c.mbps || 0), 0) * 10) / 10, suffix: 'Mbps' } : { value: '—', suffix: 'measuring… (needs 2 polls)' }));
kpi('Throughput', 'down', 'Downlink throughput now (to clients)', (h) => (hasThr(h) ? { value: Math.round(h.clients.reduce((n, c) => n + (c.mbpsDown || 0), 0) * 10) / 10, suffix: 'Mbps' } : { value: '—', suffix: 'measuring…' }));
kpi('Throughput', 'up', 'Uplink throughput now (from clients)', (h) => (hasThr(h) ? { value: Math.round(h.clients.reduce((n, c) => n + (c.mbpsUp || 0), 0) * 10) / 10, suffix: 'Mbps' } : { value: '—', suffix: 'measuring…' }));
kpi('Throughput', 'perClient', 'Average throughput per active client', (h) => { const a = h.clients.filter((c) => c.mbps != null); return a.length ? { value: Math.round((a.reduce((n, c) => n + c.mbps, 0) / a.length) * 100) / 100, suffix: 'Mbps' } : { value: '—', suffix: 'measuring…' }; });
kpi('Throughput', 'peak', 'Peak client throughput (24 h)', (h, S, v) => { const now = Date.now(); const r = history.range(`thr_mbps@${v || '*'}`, now - DAY, now); return r.length ? { value: Math.round(Math.max(...r.map((x) => x[1])) * 10) / 10, suffix: 'Mbps' } : { value: '—', suffix: 'no history yet' }; });
kpi('Throughput', 'traffic24', 'Total traffic, last 24 h', (h, S, v) => ({ value: f.bytes(sumHist(`traffic_bytes@${v || '*'}`, DAY)) }));
kpi('Throughput', 'down24', 'Downlink traffic, last 24 h', (h) => ({ value: f.bytes(sumHist('traffic_down_bytes@*', DAY)) }));
kpi('Throughput', 'up24', 'Uplink traffic, last 24 h', (h) => ({ value: f.bytes(sumHist('traffic_up_bytes@*', DAY)) }));
kpi('Throughput', 'traffic7d', 'Total traffic, last 7 days', (h) => ({ value: f.bytes(sumHist('traffic_bytes@*', 7 * DAY)) }));
kpi('RF', 'noise', 'Average noise floor', (h) => { const a = avg(h.clients.filter((c) => c.noiseFloor != null).map((c) => c.noiseFloor)); return { value: a == null ? '—' : Math.round(a), suffix: a == null ? '' : 'dBm' }; });
for (const [id, label, re] of [['24', '2.4 GHz', /2\.4/], ['5', '5 GHz', /^5/], ['6', '6 GHz', /^6/]]) {
  kpi('RF', `rssi${id}`, `Average signal, ${label}`, (h) => { const a = avg(h.clients.filter((c) => re.test(c.band) && c.rssi != null).map((c) => c.rssi)); return { value: a == null ? '—' : Math.round(a), suffix: a == null ? '' : 'dBm' }; });
  kpi('RF', `snr${id}`, `Average SNR, ${label}`, (h) => { const a = avg(h.clients.filter((c) => re.test(c.band) && c.snr != null).map((c) => c.snr)); return { value: a == null ? '—' : Math.round(a * 10) / 10, suffix: a == null ? '' : 'dB' }; });
}
kpi('RF', 'connected', 'Average time clients have been connected', (h) => { const a = avg(h.clients.filter((c) => c.connectedAt).map((c) => (Date.now() - c.connectedAt) / 3600e3)); return { value: a == null ? '—' : f.hours(a) }; });
kpi('RF', 'radios', 'AP radios reporting', (h, S) => ({ value: S.radios.length }));
kpi('RF', 'channels', 'Distinct channels in use', (h, S) => ({ value: new Set(S.radios.filter((r) => r.channel != null).map((r) => `${r.band}|${r.channel}`)).size }));
kpi('RF', 'tx', 'Average AP TX power', (h, S) => { const a = avg(S.radios.filter((r) => r.txPower != null).map((r) => r.txPower)); return { value: a == null ? '—' : Math.round(a * 10) / 10, suffix: a == null ? '' : 'dBm' }; });
// AP load — what the API CAN tell us about congestion (airtime itself is Data Studio-only): clients and measured throughput per radio
kpi('Load', 'maxRadio', 'Most clients on one radio', (h, S, v) => { const r = radioLoad(S, v, ''); const m = r.sort((a, b) => b.clients - a.clients)[0]; return m ? { value: m.clients, suffix: `${m.apName} · ${m.band}` } : { value: '—' }; });
kpi('Load', 'over20', 'Radios with 20+ clients', (h, S, v) => { const n = radioLoad(S, v, '').filter((r) => r.clients >= 20).length; return { value: n, tone: n ? 'warn' : 'ok' }; });
kpi('Load', 'perRadio', 'Average clients per active radio', (h, S, v) => { const a = radioLoad(S, v, '').filter((r) => r.clients > 0); return { value: a.length ? Math.round((a.reduce((n, r) => n + r.clients, 0) / a.length) * 10) / 10 : '—' }; });
kpi('Load', 'dense', 'Most radios sharing one channel (same venue)', (h, S, v) => { const m = new Map(); for (const r of inV(S.radios, v)) if (r.channel != null) { const k = `${r.venueId}|${r.band}|${r.channel}`; m.set(k, (m.get(k) || 0) + 1); } const best = [...m].sort((a, b) => b[1] - a[1])[0]; return best ? { value: best[1], suffix: 'radios on one channel' } : { value: '—' }; });
// APs
kpi('APs', 'total', 'Total APs', (h) => ({ value: h.aps.length }));
kpi('APs', 'online', 'APs online', (h) => { const n = h.aps.filter((a) => a.status === 'Operational' || a.status === 'Degraded').length; return { value: n, suffix: `/ ${h.aps.length}`, tone: tone(h.aps.length && n / h.aps.length < 0.9, n < h.aps.length) }; });
kpi('APs', 'offline', 'APs offline', (h) => { const n = h.aps.filter((a) => a.status === 'Disconnected').length; return { value: n, tone: n ? 'bad' : 'ok' }; });
kpi('APs', 'degraded', 'APs degraded', (h) => { const n = h.aps.filter((a) => a.status === 'Degraded').length; return { value: n, tone: n ? 'warn' : 'ok' }; });
kpi('APs', 'init', 'APs initializing', (h) => ({ value: h.aps.filter((a) => a.status === 'Initializing').length }));
kpi('APs', 'availPct', 'AP availability', (h) => { const n = h.aps.filter((a) => a.status === 'Operational' || a.status === 'Degraded').length; return { value: h.aps.length ? Math.round(n / h.aps.length * 1000) / 10 : '—', suffix: h.aps.length ? '%' : '', tone: h.aps.length && n / h.aps.length < 0.95 ? 'warn' : 'ok' }; });
kpi('APs', 'excellent', 'APs with excellent health', (h) => { const n = h.aps.filter((a) => a.health === 'EXCELLENT').length; return { value: h.aps.length ? Math.round(n / h.aps.length * 100) : '—', suffix: h.aps.length ? '%' : '' }; });
kpi('APs', 'poorHealth', 'APs with poor health', (h) => { const n = h.aps.filter((a) => a.health === 'POOR').length; return { value: n, tone: n ? 'warn' : 'ok' }; });
kpi('APs', 'empty', 'APs with no clients', (h) => ({ value: h.aps.filter((a) => a.status === 'Operational' && a.clients === 0).length }));
kpi('APs', 'models', 'AP models in use', (h) => ({ value: uniq(h.aps, (a) => a.model) }));
kpi('APs', 'fw', 'AP firmware versions in use', (h) => { const n = uniq(h.aps, (a) => a.firmware); return { value: n, tone: n > 2 ? 'warn' : undefined }; });
kpi('APs', 'mesh', 'Mesh APs', (h) => ({ value: h.aps.filter((a) => /mesh/i.test(a.meshRole)).length }));
// Switches
kpi('Switches', 'total', 'Total switches', (h) => ({ value: h.switches.length }));
kpi('Switches', 'online', 'Switches online', (h) => { const n = h.switches.filter((a) => a.status === 'Operational' || a.status === 'Degraded').length; return { value: n, suffix: `/ ${h.switches.length}`, tone: n < h.switches.length ? 'bad' : 'ok' }; });
kpi('Switches', 'offline', 'Switches offline', (h) => { const n = h.switches.filter((a) => a.status === 'Disconnected').length; return { value: n, tone: n ? 'bad' : 'ok' }; });
kpi('Switches', 'ports', 'Total switch ports', (h) => ({ value: h.switches.reduce((n, s) => n + s.ports, 0) }));
kpi('Switches', 'cpuAvg', 'Average switch CPU', (h) => { const a = avg(h.switches.filter((s) => s.cpu != null).map((s) => s.cpu)); return { value: a == null ? '—' : Math.round(a), suffix: a == null ? '' : '%' }; });
kpi('Switches', 'cpuMax', 'Highest switch CPU', (h) => { const m = Math.max(0, ...h.switches.filter((s) => s.cpu != null).map((s) => s.cpu)); return { value: h.switches.length ? Math.round(m) : '—', suffix: '%', tone: m > 80 ? 'bad' : m > 60 ? 'warn' : 'ok' }; });
kpi('Switches', 'memAvg', 'Average switch memory', (h) => { const a = avg(h.switches.filter((s) => s.memory != null).map((s) => s.memory)); return { value: a == null ? '—' : Math.round(a), suffix: a == null ? '' : '%' }; });
kpi('Switches', 'memMax', 'Highest switch memory', (h) => { const m = Math.max(0, ...h.switches.filter((s) => s.memory != null).map((s) => s.memory)); return { value: h.switches.length ? Math.round(m) : '—', suffix: '%', tone: m > 85 ? 'bad' : m > 70 ? 'warn' : 'ok' }; });
kpi('Switches', 'poeW', 'PoE power allocated', (h) => ({ value: f.watts(h.switches.reduce((n, s) => n + (s.poeUsedW || 0), 0)) }));
kpi('Switches', 'poeCap', 'PoE capacity', (h) => ({ value: f.watts(h.switches.reduce((n, s) => n + (s.poeTotalW || 0), 0)) }));
kpi('Switches', 'poePct', 'PoE budget used', (h) => { const u = h.switches.reduce((n, s) => n + (s.poeUsedW || 0), 0); const t = h.switches.reduce((n, s) => n + (s.poeTotalW || 0), 0); return { value: t ? Math.round(u / t * 1000) / 10 : '—', suffix: t ? '%' : '', tone: t && u / t > 0.85 ? 'warn' : 'ok' }; });
kpi('Switches', 'stacks', 'Switch stacks', (h) => ({ value: h.switches.filter((s) => s.stack === 'Stack').length }));
kpi('Switches', 'alerts', 'Switches with alerts', (h) => { const n = h.switches.filter((s) => s.alerts > 0 || s.warning).length; return { value: n, tone: n ? 'warn' : 'ok' }; });
kpi('Switches', 'clients', 'Wired clients on switches', (h) => ({ value: h.switches.reduce((n, s) => n + s.clients, 0) }));
kpi('Switches', 'models', 'Switch models in use', (h) => ({ value: uniq(h.switches, (s) => s.model) }));
kpi('Switches', 'fw', 'Switch firmware versions in use', (h) => { const n = uniq(h.switches, (s) => s.firmware); return { value: n, tone: n > 2 ? 'warn' : undefined }; });
kpi('Switches', 'minUp', 'Shortest switch uptime', (h) => { const a = h.switches.filter((s) => s.uptimeSec != null).map((s) => s.uptimeSec); return { value: a.length ? f.dur(Math.min(...a)) : '—' }; });
kpi('Switches', 'maxUp', 'Longest switch uptime', (h) => { const a = h.switches.filter((s) => s.uptimeSec != null).map((s) => s.uptimeSec); return { value: a.length ? f.dur(Math.max(...a)) : '—' }; });
// Ports
const P = ['ports'];
kpi('Ports', 'total', 'Total ports (reported)', (h) => ({ value: h.ports.length || '—' }), P);
kpi('Ports', 'up', 'Ports up', (h) => ({ value: h.ports.filter((p) => p.state === 'Up').length }), P);
kpi('Ports', 'down', 'Ports down', (h) => ({ value: h.ports.filter((p) => p.state === 'Down').length }), P);
kpi('Ports', 'disabled', 'Ports admin-disabled', (h) => ({ value: h.ports.filter((p) => p.state === 'Disabled').length }), P);
kpi('Ports', 'upPct', 'Port utilization (up ÷ total)', (h) => { const n = h.ports.filter((p) => p.state === 'Up').length; return { value: h.ports.length ? Math.round(n / h.ports.length * 100) : '—', suffix: h.ports.length ? '%' : '' }; }, P);
kpi('Ports', 'withErr', 'Ports with errors (count)', (h) => { const n = h.ports.filter((p) => p.errors > 0).length; return { value: n, tone: n ? 'warn' : 'ok' }; }, P);
kpi('Ports', 'crc', 'CRC errors (total)', (h) => { const n = h.ports.reduce((a, p) => a + p.crc, 0); return { value: n, tone: n ? 'warn' : 'ok' }; }, P);
kpi('Ports', 'errDis', 'Err-disabled ports', (h) => { const n = h.ports.filter((p) => p.errDisabled).length; return { value: n, tone: n ? 'bad' : 'ok' }; }, P);
kpi('Ports', 'stp', 'STP-blocking ports', (h) => { const n = h.ports.filter((p) => p.blocking).length; return { value: n, tone: n ? 'warn' : 'ok' }; }, P);
kpi('Ports', 'poePorts', 'Ports delivering PoE', (h) => ({ value: h.ports.filter((p) => p.poeUsedW > 0).length }), P);
kpi('Ports', 'poeW', 'PoE draw (port total)', (h) => ({ value: f.watts(h.ports.reduce((n, p) => n + (p.poeUsedW || 0), 0)) }), P);
kpi('Ports', 'neighbors', 'Ports with an LLDP neighbor', (h) => ({ value: h.ports.filter((p) => p.hasNeighbor === 'Has LLDP neighbor').length }), P);
kpi('Ports', 'thr', 'Wired traffic now (all switch ports)', (h) => { const r = h.ports.filter((p) => p.mbps != null); return r.length ? { value: Math.round(r.reduce((n, p) => n + p.mbps, 0) * 10) / 10, suffix: 'Mbps' } : { value: '—', suffix: 'measuring… (port counters need two fetches)' }; }, P);
kpi('Ports', 'util', 'Average port utilization (up)', (h) => { const a = avg(h.ports.filter((p) => p.state === 'Up').map((p) => p.utilPct)); return { value: a == null ? '—' : Math.round(a * 10) / 10, suffix: a == null ? '' : '%' }; }, P);
// Alarms
kpi('Alarms', 'total', 'Active alarms', (h) => ({ value: h.alarms.length, tone: h.alarms.some((a) => a.severity === 'Critical') ? 'bad' : h.alarms.length ? 'warn' : 'ok' }));
for (const sev of ['Critical', 'Major', 'Minor']) kpi('Alarms', sev, `${sev} alarms`, (h) => { const n = h.alarms.filter((a) => a.severity === sev).length; return { value: n, tone: n ? (sev === 'Minor' ? 'warn' : 'bad') : 'ok' }; });
kpi('Alarms', 'lowSev', 'Warning / info alarms', (h) => ({ value: h.alarms.filter((a) => a.severity === 'Warning' || a.severity === 'Info').length }));
kpi('Alarms', 'devices', 'Devices with alarms', (h) => ({ value: uniq(h.alarms, (a) => a.device) }));
kpi('Alarms', 'hour', 'Alarms raised in last hour', (h) => ({ value: h.alarms.filter((a) => a.time && Date.now() - a.time < 3600e3).length }));
kpi('Alarms', 'newest', 'Newest alarm age', (h) => { const t = Math.max(0, ...h.alarms.map((a) => a.time || 0)); return { value: t ? f.ago(t) : '—' }; });
kpi('Alarms', 'oldest', 'Oldest alarm age', (h) => { const a = h.alarms.map((x) => x.time).filter(Boolean); return { value: a.length ? f.ago(Math.min(...a)) : '—', tone: a.length && Date.now() - Math.min(...a) > 7 * DAY ? 'warn' : undefined }; });
// Venues & networks
kpi('Venues', 'count', 'Venues', (h, S) => ({ value: S.venues.length }));
kpi('Venues', 'withDown', 'Venues with offline devices', (h, S) => ({ value: S.venues.filter((v) => [...S.aps, ...S.switches].some((d) => d.venueId === v.id && d.status === 'Disconnected')).length, tone: 'warn' }));
kpi('Networks', 'count', 'Wi-Fi network count', (h, S) => ({ value: S.networks.length || '—' }), ['networks']);
kpi('Networks', 'captive', 'Networks with a captive portal', (h, S) => ({ value: S.networks.filter((n) => n.captive && n.captive !== 'None').length }), ['networks']);
kpi('Networks', 'clients', 'Clients across all networks', (h, S) => ({ value: S.networks.reduce((n, x) => n + x.clients, 0) }), ['networks']);
kpi('Networks', 'vlans', 'VLANs in use (all sources)', (h, S) => { const s = new Set(); S.clients.forEach((c) => c.vlan && s.add(c.vlan)); S.ports.forEach((p) => p.vlan && s.add(`VLAN ${p.vlan}`)); S.networks.forEach((n) => n.vlan && s.add(n.vlan)); S.dpsk.forEach((d) => d.vlan && s.add(d.vlan)); return { value: s.size }; }, ['networks', 'ports', 'dpsk']);
kpi('Networks', 'vlanPools', 'VLAN pool count', (h, S) => ({ value: S.vlanPools.length }), ['vlanPools']);
// DPSK
const D = ['dpsk'];
kpi('DPSK', 'active', 'Active DPSK users', (h, S) => ({ value: S.dpsk.filter((p) => p.active).length }), D);
kpi('DPSK', 'pools', 'DPSK pool count', (h, S) => ({ value: S.dpskPools.length }), D);
kpi('DPSK', 'devices', 'Devices on active DPSK users', (h, S) => ({ value: S.dpsk.filter((p) => p.active).reduce((n, p) => n + p.devices, 0) }), D);
kpi('DPSK', 'online', 'DPSK users seen in last 24h', (h, S) => ({ value: S.dpsk.filter((p) => p.active && p.seenRecently).length }), D);
kpi('DPSK', 'idle', 'Active DPSK users not seen in 24h', (h, S) => ({ value: S.dpsk.filter((p) => p.active && !p.seenRecently).length }), D);
kpi('DPSK', 'expiring', 'DPSK users expiring within 7 days', (h, S) => { const n = S.dpsk.filter((p) => p.active && p.expiresAt && p.expiresAt - Date.now() < 7 * DAY).length; return { value: n, tone: n ? 'warn' : 'ok' }; }, D);
kpi('DPSK', 'revoked', 'Revoked DPSK users', (h, S) => ({ value: S.dpsk.filter((p) => p.status === 'Revoked').length }), D);
kpi('DPSK', 'expired', 'Expired DPSK users', (h, S) => ({ value: S.dpsk.filter((p) => p.status === 'Expired').length }), D);
kpi('DPSK', 'new', 'DPSK users created in last 24h', (h, S) => ({ value: S.dpsk.filter((p) => p.created && Date.now() - p.created < DAY).length }), D);
kpi('DPSK', 'avgDev', 'Average devices per DPSK user', (h, S) => { const a = S.dpsk.filter((p) => p.active); return { value: a.length ? Math.round(a.reduce((n, p) => n + p.devices, 0) / a.length * 10) / 10 : '—' }; }, D);
kpi('DPSK', 'atLimit', 'DPSK users at device limit', (h, S) => ({ value: S.dpsk.filter((p) => p.active && p.deviceLimit && p.devices >= p.deviceLimit).length }), D);
// Guests
const G = ['guests', 'networks'];
kpi('Guests', 'active', 'Active guest users', (h, S) => ({ value: S.guests.filter((g) => !g.expired).length }), G);
kpi('Guests', 'total', 'Guest users (all)', (h, S) => ({ value: S.guests.length }), G);
kpi('Guests', 'online', 'Guests online now', (h, S) => ({ value: S.guests.filter((g) => !g.expired && /online|connect|active/i.test(g.status) && !/offline|disconnect|inactive/i.test(g.status)).length }), G);
kpi('Guests', 'exp24', 'Guest passes expiring within 24h', (h, S) => ({ value: S.guests.filter((g) => !g.expired && g.expiry && g.expiry - Date.now() < DAY).length }), G);
kpi('Guests', 'new', 'Guests created in last 24h', (h, S) => ({ value: S.guests.filter((g) => g.created && Date.now() - g.created < DAY).length }), G);
kpi('Guests', 'social', 'Social-login guests', (h, S) => ({ value: S.guests.filter((g) => !g.expired && g.social).length }), G);
kpi('Guests', 'expired', 'Expired guest passes', (h, S) => ({ value: S.guests.filter((g) => g.expired).length }), G);
// Identity
kpi('Identity', 'groups', 'Identity group count', (h, S) => ({ value: S.identityGroups.length }), ['identityGroups']);
kpi('Identity', 'identities', 'Identities (all groups)', (h, S) => ({ value: S.identityGroups.reduce((n, g) => n + g.identities, 0) }), ['identityGroups']);

function kpiWidgets() {
  return KPI.map((k) => ({
    type: `g.kpi.${k.group.toLowerCase()}.${k.id}`, title: k.title, group: 'Scorecards', sub: k.group, needs: k.needs, match: ['Clients', 'APs', 'Throughput', 'RF', 'Load'].includes(k.group), w: 3, h: 2, params: [],
    compute: (S, venue, p) => {
      const h = { clients: byMatch(inV(S.clients, venue), p._match), aps: byMatch(inV(S.aps, venue), p._match), switches: inV(S.switches, venue), ports: inV(S.ports, venue), alarms: inV(S.alarms, venue) };
      const r = k.fn(h, S, venue);
      return { kind: 'kpi', title: ['Clients', 'APs', 'Switches', 'Ports', 'Alarms', 'Throughput', 'RF', 'Load'].includes(k.group) ? venueTitle(S, venue, k.title) : k.title, ...r };
    }
  }));
}

// ---------------- trends over time ----------------
const TREND_METRICS = [
  ['clients', 'Clients', ''], ['clients_24', '2.4 GHz clients', ''], ['clients_5', '5 GHz clients', ''], ['clients_6', '6 GHz clients', ''],
  ['aps_online', 'APs online', ''], ['aps_offline', 'APs offline', ''], ['sw_online', 'Switches online', ''], ['sw_offline', 'Switches offline', ''],
  ['alarms', 'Active alarms', ''], ['alarms_critical', 'Critical alarms', ''], ['alarms_major', 'Major alarms', ''], ['wfc_clients', 'Wi-Fi calling clients', ''],
  ['avg_rssi', 'Average client signal (dBm)', ''], ['poor_signal', 'Clients with poor signal', ''], ['poe_watts', 'PoE power allocated (W)', ''],
  ['ports_up', 'Ports up', ''], ['ports_err', 'Ports with errors', ''], ['dpsk_active', 'Active DPSK users', ''], ['dpsk_devices', 'Devices on active DPSK users', ''],
  ['guests_active', 'Active guest users', ''], ['identities', 'Identities', ''],
  ['thr_mbps', 'Client throughput (Mbps)', ''], ['thr_down_mbps', 'Downlink throughput (Mbps)', ''], ['thr_up_mbps', 'Uplink throughput (Mbps)', ''],
  ['thr_mbps_24', '2.4 GHz throughput (Mbps)', ''], ['thr_mbps_5', '5 GHz throughput (Mbps)', ''], ['thr_mbps_6', '6 GHz throughput (Mbps)', ''],
  ['avg_snr', 'Average client SNR (dB)', ''], ['avg_noise', 'Average noise floor (dBm)', ''],
  ['avg_rssi_24', 'Average signal, 2.4 GHz (dBm)', ''], ['avg_rssi_5', 'Average signal, 5 GHz (dBm)', ''], ['avg_rssi_6', 'Average signal, 6 GHz (dBm)', ''],
  ['sw_thr_mbps', 'Wired switch traffic (Mbps)', ''], ['sw_errors', 'Switch port errors per interval', ''],
  ['avg_snr_24', 'Average SNR, 2.4 GHz (dB)', ''], ['avg_snr_5', 'Average SNR, 5 GHz (dB)', ''], ['avg_snr_6', 'Average SNR, 6 GHz (dB)', '']
];
const VENUE_METRICS = new Set(['thr_mbps', 'clients', 'clients_24', 'clients_5', 'clients_6', 'aps_online', 'aps_offline', 'sw_online', 'sw_offline', 'alarms', 'alarms_critical', 'alarms_major', 'wfc_clients', 'avg_rssi', 'poor_signal', 'poe_watts']);
const TREND_DIMS = [['clients', 'ssid'], ['clients', 'os'], ['clients', 'band'], ['clients', 'vendor'], ['clients', 'security'], ['clients', 'devType'], ['clients', 'radioType'], ['clients', 'vlan'], ['clients', 'model'],
  ['aps', 'model'], ['aps', 'status'], ['aps', 'firmware'], ['switches', 'status'], ['switches', 'model'], ['alarms', 'severity'], ['ports', 'state'], ['dpsk', 'pool'], ['networks', 'name']];

function trendWidgets() {
  const out = [];
  for (const [metric, title] of TREND_METRICS) {
    out.push({ type: `g.trend.${metric}`, title: `${title} over time`, group: 'Trends', sub: 'Single metric', needs: [], w: 6, h: 4, params: [{ name: 'hours', label: 'Hours', default: 24 }],
      compute: (S, venue, p) => ({ kind: 'line', title: VENUE_METRICS.has(metric) ? venueTitle(S, venue, `${title} over time`) : `${title} over time`, hours: Number(p.hours) || 24, unit: '', points: history.series(`${metric}@${VENUE_METRICS.has(metric) && venue ? venue : '*'}`, Number(p.hours) || 24) }) });
  }
  for (const [eid, did] of TREND_DIMS) {
    const ent = ENT[eid]; const dim = ent.dims.find((d) => d[0] === did); if (!dim) continue;
    out.push({ type: `g.trend.${eid}.${did}`, title: `${ent.label} by ${dim[1]} over time`, group: 'Trends', sub: 'By category', needs: ent.needs || [], w: 6, h: 4, params: [{ name: 'hours', label: 'Hours', default: 24 }, { name: 'n', label: 'Series', default: 5 }],
      compute: (S, venue, p) => ({ kind: 'multiline', title: `${ent.label} by ${dim[1]} over time`, hours: Number(p.hours) || 24, series: history.topSeries(`d.${eid}.${did}.`, '@*', Number(p.hours) || 24, clampN(p.n, 5)) }) });
  }
  return out;
}

// Category-count samples for the multi-series trends (top 8 values each, global).
function dimMetrics(S) {
  const m = {}; const ctx = { vname: new Map(S.venues.map((v) => [v.id, v.name])) };
  for (const [eid, did] of TREND_DIMS) {
    const ent = ENT[eid]; const dim = ent.dims.find((d) => d[0] === did); if (!dim) continue;
    const rows = ent.rows(S); if (!rows.length) continue;
    for (const i of aggregate(rows, dim[2], M.count, ctx).slice(0, 8)) m[`d.${eid}.${did}.${i.label}@*`] = i.value;
  }
  return m;
}

// ---------------- hand-shaped access & identity widgets (lists/tables across sources) ----------------
function accessWidgets() {
  const rowsOf = (S) => S.dpsk;
  const W = [];
  W.push({ type: 'a.dpsk.status', title: 'DPSK users by status', group: 'DPSK', sub: 'Status', needs: ['dpsk'], w: 3, h: 4, params: [], compute: (S) => {
    const t = {}; for (const p of rowsOf(S)) t[p.status] = (t[p.status] || 0) + 1;
    return { kind: 'donut', title: 'DPSK users by status', items: Object.entries(t).map(([label, value]) => ({ label, value, tone: { Active: 'ok', Expired: 'warn', Revoked: 'bad' }[label] })).sort((a, b) => b.value - a.value), centerLabel: 'passphrases', center: rowsOf(S).length };
  } });
  W.push({ type: 'a.dpsk.expiring', title: 'DPSK users expiring soon', group: 'DPSK', sub: 'Lists', needs: ['dpsk'], w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 8 }, { name: 'days', label: 'Within days', default: 14 }], compute: (S, v, p) => {
    const lim = (Number(p.days) || 14) * DAY;
    return { kind: 'list', title: `DPSK users expiring within ${Number(p.days) || 14} days`, empty: 'Nothing expiring soon', rows: S.dpsk.filter((x) => x.active && x.expiresAt && x.expiresAt - Date.now() < lim).sort((a, b) => a.expiresAt - b.expiresAt).slice(0, clampN(p.n, 8))
      .map((x) => ({ tone: x.expiresAt - Date.now() < DAY ? 'bad' : 'warn', badge: 'Expiring', primary: x.user || '(no username)', secondary: `${x.pool}${x.vlan ? ' · ' + x.vlan : ''}`, meta: f.until(x.expiresAt) })) };
  } });
  W.push({ type: 'a.dpsk.recent', title: 'Newest DPSK users', group: 'DPSK', sub: 'Lists', needs: ['dpsk'], w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 8 }], compute: (S, v, p) => ({
    kind: 'list', title: 'Newest DPSK users', empty: 'No DPSK users yet', rows: S.dpsk.filter((x) => x.created).sort((a, b) => b.created - a.created).slice(0, clampN(p.n, 8)).map((x) => ({ tone: x.active ? 'info' : 'warn', badge: x.status, primary: x.user || '(no username)', secondary: `${x.pool}${x.vlan ? ' · ' + x.vlan : ''} · ${x.devices}/${x.deviceLimit || '∞'} devices`, meta: f.ago(x.created) })) }) });
  W.push({ type: 'a.dpsk.pools', title: 'DPSK pools', group: 'DPSK', sub: 'Tables', needs: ['dpsk'], w: 8, h: 4, params: [], compute: (S) => ({
    kind: 'table', title: 'DPSK pools', columns: ['Pool', 'Active users', 'Devices', 'Seen 24h', 'Expiring 7d', 'Networks'], rows: S.dpskPools.map((pl) => {
      const u = S.dpsk.filter((x) => x.poolId === pl.id && x.active);
      return { cells: [pl.name, u.length, u.reduce((n, x) => n + x.devices, 0), u.filter((x) => x.seenRecently).length, u.filter((x) => x.expiresAt && x.expiresAt - Date.now() < 7 * DAY).length, pl.networks] };
    }) }) });
  W.push({ type: 'a.guests.recent', title: 'Newest guest users', group: 'Guests', sub: 'Lists', needs: ['guests', 'networks'], w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 8 }], compute: (S, v, p) => ({
    kind: 'list', title: 'Newest guest users', empty: 'No guest users', rows: S.guests.filter((g) => g.created).sort((a, b) => b.created - a.created).slice(0, clampN(p.n, 8)).map((g) => ({ tone: g.expired ? 'warn' : 'info', badge: g.expired ? 'Expired' : g.type || 'Guest', primary: g.name || '(unnamed)', secondary: [g.network, g.status].filter(Boolean).join(' · '), meta: f.ago(g.created) })) }) });
  W.push({ type: 'a.guests.expiring', title: 'Guest passes expiring soon', group: 'Guests', sub: 'Lists', needs: ['guests', 'networks'], w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 8 }], compute: (S, v, p) => ({
    kind: 'list', title: 'Guest passes expiring soon', empty: 'No passes expiring soon', rows: S.guests.filter((g) => !g.expired && g.expiry).sort((a, b) => a.expiry - b.expiry).slice(0, clampN(p.n, 8)).map((g) => ({ tone: g.expiry - Date.now() < DAY ? 'warn' : 'info', badge: 'Expires', primary: g.name || '(unnamed)', secondary: [g.network, g.type].filter(Boolean).join(' · '), meta: f.until(g.expiry) })) }) });
  W.push({ type: 'a.networks.table', title: 'Wi-Fi networks', group: 'Networks', sub: 'Tables', needs: ['networks'], w: 8, h: 5, params: [{ name: 'n', label: 'Rows', default: 12 }], compute: (S, v, p) => ({
    kind: 'table', title: 'Wi-Fi networks', columns: ['SSID', 'Type', 'Security', 'VLAN', 'Clients', 'APs'], rows: S.networks.slice().sort((a, b) => b.clients - a.clients).slice(0, clampN(p.n, 12)).map((n) => ({ cells: [n.ssid, n.type, n.security, n.vlan || '—', n.clients, n.aps] })) }) });
  W.push({ type: 'a.vlan.overview', title: 'VLAN overview (clients, ports, networks, DPSK)', group: 'VLANs', sub: 'Tables', needs: ['networks', 'ports', 'dpsk'], w: 8, h: 5, params: [{ name: 'n', label: 'Rows', default: 12 }], compute: (S, v, p) => {
    const m = new Map(); const row = (k) => { if (!m.has(k)) m.set(k, { vlan: k, clients: 0, ports: 0, networks: 0, dpsk: 0 }); return m.get(k); };
    S.clients.forEach((c) => c.vlan && row(c.vlan).clients++); S.ports.forEach((x) => x.vlan && row(`VLAN ${x.vlan}`).ports++);
    S.networks.forEach((n) => n.vlan && row(n.vlan).networks++); S.dpsk.filter((d) => d.active).forEach((d) => d.vlan && row(d.vlan).dpsk++);
    const num = (s) => Number(String(s).replace(/\D/g, '')) || 0;
    return { kind: 'table', title: 'VLAN overview', columns: ['VLAN', 'Wi-Fi clients', 'Switch ports', 'Networks', 'DPSK users'], rows: [...m.values()].sort((a, b) => b.clients + b.dpsk + b.ports - (a.clients + a.dpsk + a.ports) || num(a.vlan) - num(b.vlan)).slice(0, clampN(p.n, 12)).map((r) => ({ cells: [r.vlan, r.clients, r.ports, r.networks, r.dpsk] })) };
  } });
  W.push({ type: 'a.vlan.pools', title: 'VLAN pools', group: 'VLANs', sub: 'Tables', needs: ['vlanPools', 'networks'], w: 8, h: 4, params: [], compute: (S) => ({
    kind: 'table', title: 'VLAN pools', columns: ['Pool', 'VLAN members', 'Networks'], rows: S.vlanPools.map((x) => ({ cells: [x.name, x.members || '—', x.networkNames || x.networks] })) }) });
  W.push({ type: 'a.identity.groups', title: 'Identity groups', group: 'Identity', sub: 'Tables', needs: ['identityGroups'], w: 8, h: 4, params: [], compute: (S) => ({
    kind: 'table', title: 'Identity groups', columns: ['Group', 'Identities', 'Networks', 'Credential'], rows: S.identityGroups.slice().sort((a, b) => b.identities - a.identities).map((g) => ({ cells: [g.name, g.identities, g.networks, g.dpsk || g.macReg || '—'] })) }) });
  return W;
}

// Generated widgets that duplicate an earlier hand-built one. They are not generated any more; the map lets a
// saved layout that referenced the old generated id keep working (it resolves to the hand-built twin).
const ALIASES = {
  'g.kpi.rf.snr': 'g.kpi.clients.snr', 'g.kpi.clients.total': 'kpi.clients', 'g.kpi.aps.online': 'kpi.aps', 'g.kpi.switches.online': 'kpi.switches', 'g.kpi.alarms.total': 'kpi.alarms',
  'g.kpi.switches.ports': 'kpi.ports', 'g.kpi.switches.poeW': 'kpi.poe_draw', 'g.kpi.ports.up': 'kpi.ports_up',
  'g.trend.clients': 'trend.clients', 'g.trend.aps_online': 'trend.aps', 'g.trend.alarms': 'trend.alarms', 'g.trend.wfc_clients': 'trend.wfc',
  'g.aps.status.count.donut': 'donut.ap_status', 'g.switches.status.count.donut': 'donut.sw_status', 'g.clients.ssid.count.donut': 'donut.clients_ssid',
  'g.clients.os.count.donut': 'donut.clients_os', 'g.clients.band.count.donut': 'donut.clients_band', 'g.clients.vendor.count.donut': 'donut.clients_vendor',
  'g.clients.devType.count.donut': 'donut.clients_devtype', 'g.aps.model.count.donut': 'donut.ap_models', 'g.switches.model.count.donut': 'donut.sw_models',
  'g.aps.firmware.count.donut': 'donut.ap_fw', 'g.switches.firmware.count.donut': 'donut.sw_fw', 'g.clients.wfcCarrier.count.donut': 'donut.wfc_carriers',
  'g.aps.health.count.donut': 'donut.ap_health', 'g.ports.state.count.donut': 'donut.port_status', 'g.ports.speed.count.donut': 'donut.port_speed',
  'g.clients.signal.count.donut': 'donut.client_signal',
  'g.clients.venue.count.bar': 'bar.venue_clients', 'g.clients.vendor.count.bar': 'bar.clients_vendor', 'g.clients.model.count.bar': 'bar.clients_models', 'g.clients.channel.count.bar': 'bar.channels'
};
// ---------------- history: compare / hourly profile / peak-avg-change scorecards ----------------
const HIST = [   // [metric, label, formatter]
  ['clients', 'Clients', f.num], ['clients_5', '5 GHz clients', f.num], ['clients_24', '2.4 GHz clients', f.num], ['clients_6', '6 GHz clients', f.num], ['thr_mbps', 'Client throughput', f.mbps], ['avg_snr', 'Average client SNR', f.db], ['wfc_clients', 'Wi-Fi calling clients', f.num],
  ['aps_online', 'APs online', f.num], ['aps_offline', 'APs offline', f.num], ['sw_online', 'Switches online', f.num], ['alarms', 'Active alarms', f.num],
  ['poor_signal', 'Poor-signal clients', f.num], ['avg_rssi', 'Average client signal', f.dbm], ['poe_watts', 'PoE power allocated', f.watts],
  ['dpsk_active', 'Active DPSK users', f.num], ['guests_active', 'Active guest users', f.num], ['ports_up', 'Ports up', f.num]
];
const keyOf = (metric, venue) => `${metric}@${VENUE_METRICS.has(metric) && venue ? venue : '*'}`;
const near = (rows, t, tol = 20 * 60e3) => { let best = null; for (const r of rows) { const d = Math.abs(r[0] - t); if (d <= tol && (!best || d < best[0])) best = [d, r[1]]; } return best ? best[1] : null; };
const stats = (rows) => (rows.length ? { peak: Math.max(...rows.map((r) => r[1])), low: Math.min(...rows.map((r) => r[1])), avg: rows.reduce((n, r) => n + r[1], 0) / rows.length } : null);

function historyWidgets() {
  const out = [];
  for (const [metric, label, fmt] of HIST) {
    const vt = (S, venue, t) => (VENUE_METRICS.has(metric) ? venueTitle(S, venue, t) : t);
    for (const [vsId, vsLabel, shift] of [['yesterday', 'yesterday', DAY], ['lastweek', 'last week', 7 * DAY]]) {
      out.push({ type: `g.cmp.${metric}.${vsId}`, title: `${label}: now vs ${vsLabel}`, group: 'History', sub: 'Compare to the past', needs: [], w: 6, h: 4, params: [{ name: 'hours', label: 'Hours shown', default: 12 }],
        compute: (S, venue, p) => {
          const hrs = Math.max(1, Math.min(72, Number(p.hours) || 12)); const now = Date.now(); const key = keyOf(metric, venue);
          const cur = history.series(key, hrs, 160, now);
          const past = history.range(key, now - shift - hrs * 3600e3, now - shift).map(([t, v]) => [t + shift, v]);   // shifted forward so the curves overlay
          return { kind: 'multiline', title: vt(S, venue, `${label}: now vs ${vsLabel}`), hours: hrs, series: [{ label: 'Now', points: cur }, { label: cap(vsLabel), points: past }].filter((x) => x.points.length) };
        } });
    }
    out.push({ type: `g.hourly.${metric}`, title: `${label} by hour of day`, group: 'History', sub: 'Hourly profile', needs: [], w: 6, h: 4, params: [{ name: 'days', label: 'Days averaged', default: 7 }],
      compute: (S, venue, p) => {
        const days = Math.max(1, Math.min(30, Number(p.days) || 7)); const now = Date.now();
        const rows = history.range(keyOf(metric, venue), now - days * DAY, now); const b = Array.from({ length: 24 }, () => ({ s: 0, n: 0, peak: -Infinity }));
        for (const [t, v] of rows) { const h = new Date(t).getHours(); b[h].s += v; b[h].n++; b[h].peak = Math.max(b[h].peak, v); }
        return { kind: 'columns', title: vt(S, venue, `${label} by hour of day (${days}-day average, peak marked)`), items: b.map((x, h) => ({ label: String(h).padStart(2, '0'), value: x.n ? Math.round((x.s / x.n) * 10) / 10 : 0, peak: x.n ? Math.round(x.peak * 10) / 10 : 0 })), hasData: rows.length > 0 };
      } });
    const k = (id, title, fn) => out.push({ type: `g.hist.${metric}.${id}`, title: `${label}: ${title}`, group: 'History', sub: 'Scorecards', needs: [], w: 3, h: 2, params: [], compute: (S, venue) => ({ kind: 'kpi', title: vt(S, venue, `${label} — ${title}`), ...fn(venue) }) });
    const win = (venue, ms) => { const now = Date.now(); return history.range(keyOf(metric, venue), now - ms, now); };
    k('peak24', 'peak (24 h)', (v) => { const st = stats(win(v, DAY)); return st ? { value: fmt(st.peak) } : { value: '—', suffix: 'no history yet' }; });
    k('avg24', 'average (24 h)', (v) => { const st = stats(win(v, DAY)); return st ? { value: fmt(st.avg) } : { value: '—', suffix: 'no history yet' }; });
    k('low24', 'low (24 h)', (v) => { const st = stats(win(v, DAY)); return st ? { value: fmt(st.low) } : { value: '—', suffix: 'no history yet' }; });
    k('peakweek', 'peak (7 days)', (v) => { const st = stats(win(v, 7 * DAY)); return st ? { value: fmt(st.peak) } : { value: '—', suffix: 'no history yet' }; });
    for (const [id, nm, shift] of [['vsyday', 'vs same time yesterday', DAY], ['vsweek', 'vs same time last week', 7 * DAY]]) {
      k(id, nm.replace('vs same time', 'change vs'), (v) => {
        const key = keyOf(metric, v); const now = Date.now(); const cur = near(history.range(key, now - 30 * 60e3, now), now, 30 * 60e3); const then = near(history.range(key, now - shift - 30 * 60e3, now - shift + 30 * 60e3), now - shift, 30 * 60e3);
        if (cur == null || then == null) return { value: '—', suffix: 'needs more history' };
        if (then === 0) return { value: cur === 0 ? 0 : 100, suffix: `% ${nm}` };
        const pctChg = ((cur - then) / Math.abs(then)) * 100; return { value: Math.round(pctChg * 10) / 10, suffix: `% ${nm}` };
      });
    }
  }
  return out;
}

// ---------------- gauges & RF tables (the Data Studio "Wireless performance / Student experience / RF coverage" boards) ----------------
const BANDS = [['', 'all bands', null], ['24', '2.4 GHz', /2\.4/], ['5', '5 GHz', /^5/], ['6', '6 GHz', /^6/]];
function gaugeWidgets() {
  const out = []; const mk = (id, title, min, max, zones, fn, opts = {}) => out.push({ type: `g.gauge.${id}`, title, group: 'Gauges', sub: opts.sub || 'Dial', needs: [], match: Boolean(opts.match), w: 3, h: 3, params: [],
    compute: (S, venue, p) => { const v = fn({ clients: byMatch(inV(S.clients, venue), p._match), aps: byMatch(inV(S.aps, venue), p._match), switches: inV(S.switches, venue), S }); return { kind: 'gauge', title: venueTitle(S, venue, title), value: v == null ? null : Math.round(v * 10) / 10, min, max, zones, unit: opts.unit || '', text: v == null ? '—' : `${Math.round(v * 10) / 10}${opts.unit || ''}` }; } });
  const rssiZ = [{ to: -75, tone: 'bad' }, { to: -65, tone: 'warn' }, { to: -30, tone: 'ok' }]; const snrZ = [{ to: 15, tone: 'bad' }, { to: 25, tone: 'warn' }, { to: 50, tone: 'ok' }];
  for (const [id, label, re] of BANDS) {
    mk(`rssi_${id || 'all'}`, `Average signal — ${label}`, -90, -30, rssiZ, (x) => avg(x.clients.filter((c) => c.rssi != null && (!re || re.test(c.band))).map((c) => c.rssi)), { unit: ' dBm', match: true, sub: 'Signal quality' });
    mk(`snr_${id || 'all'}`, `Average SNR — ${label}`, 0, 50, snrZ, (x) => avg(x.clients.filter((c) => c.snr != null && (!re || re.test(c.band))).map((c) => c.snr)), { unit: ' dB', match: true, sub: 'Signal quality' });
  }
  mk('poor_pct', 'Clients with poor signal', 0, 100, [{ to: 10, tone: 'ok' }, { to: 25, tone: 'warn' }, { to: 100, tone: 'bad' }], (x) => { const c = x.clients.filter((y) => y.rssi != null); return c.length ? (c.filter((y) => y.rssi < -80).length / c.length) * 100 : null; }, { unit: '%', match: true, sub: 'Signal quality' });
  mk('ap_avail', 'AP availability', 0, 100, [{ to: 90, tone: 'bad' }, { to: 98, tone: 'warn' }, { to: 100, tone: 'ok' }], (x) => (x.aps.length ? (x.aps.filter(up).length / x.aps.length) * 100 : null), { unit: '%', match: true, sub: 'Health' });
  mk('poe', 'PoE budget used', 0, 100, [{ to: 75, tone: 'ok' }, { to: 90, tone: 'warn' }, { to: 100, tone: 'bad' }], (x) => { const t = x.switches.reduce((n, s) => n + (s.poeTotalW || 0), 0); return t ? (x.switches.reduce((n, s) => n + (s.poeUsedW || 0), 0) / t) * 100 : null; }, { unit: '%', sub: 'Health' });
  mk('cpu', 'Highest switch CPU', 0, 100, [{ to: 60, tone: 'ok' }, { to: 80, tone: 'warn' }, { to: 100, tone: 'bad' }], (x) => { const a = x.switches.filter((s) => s.cpu != null).map((s) => s.cpu); return a.length ? Math.max(...a) : null; }, { unit: '%', sub: 'Health' });
  mk('mem', 'Highest switch memory', 0, 100, [{ to: 70, tone: 'ok' }, { to: 85, tone: 'warn' }, { to: 100, tone: 'bad' }], (x) => { const a = x.switches.filter((s) => s.memory != null).map((s) => s.memory); return a.length ? Math.max(...a) : null; }, { unit: '%', sub: 'Health' });
  const tagged = new Set(['g.gauge.poor_pct', 'g.gauge.ap_avail', 'g.gauge.poe', 'g.gauge.cpu', 'g.gauge.mem']);
  for (const w of out) if (tagged.has(w.type)) w.title = `${w.title} (gauge)`;   // catalog/picker only; compute() still returns the plain heading
  return out;
}

// One row per AP radio with the clients on it (clients are matched to a radio by their AP + band).
function radioLoad(S, venue, match) {
  const per = new Map();
  for (const c of byMatch(inV(S.clients, venue), match)) { const k = `${c.apSerial}|${bandName(c.band)}`; if (!per.has(k)) per.set(k, []); per.get(k).push(c); }
  return byMatch(inV(S.radios, venue), match).map((r) => {
    const cs = per.get(`${r.apId}|${r.band}`) || []; const th = cs.filter((c) => c.mbps != null); const sn = cs.filter((c) => c.snr != null); const sg = cs.filter((c) => c.rssi != null);
    return { apName: r.apName, apGroup: r.apGroup, venueId: r.venueId, band: r.band, channel: r.channel, width: r.width, txPower: r.txPower, clients: cs.length, mbps: th.length ? th.reduce((n, c) => n + c.mbps, 0) : null, snr: sn.length ? avg(sn.map((c) => c.snr)) : null, poor: sg.length ? (sg.filter((c) => c.rssi < -80).length / sg.length) * 100 : null };
  });
}
function loadWidgets() {
  const mk = (type, title, w, h, params, compute) => ({ type, title, group: 'AP load', sub: 'Congestion (not airtime)', needs: [], match: true, w, h, params, compute });
  const num = (v, d = 1) => (v == null ? '—' : String(Math.round(v * 10 ** d) / 10 ** d));
  const sortBy = (rows, mode) => rows.sort((a, b) => (Number(mode) === 2 ? (b.mbps || 0) - (a.mbps || 0) || b.clients - a.clients : b.clients - a.clients || (b.mbps || 0) - (a.mbps || 0)));
  return [
    mk('a.load.radios', 'Busiest radios (clients and throughput)', 12, 5, [{ name: 'n', label: 'Rows', default: 12 }, { name: 'sort', label: 'Sort by (1 = clients, 2 = throughput)', default: 1 }], (S, venue, p) => ({
      kind: 'table', title: venueTitle(S, venue, 'Busiest radios') + (p._match ? ` — AP group contains “${p._match}”` : ''), columns: ['AP', 'AP group', 'Radio', 'Clients', 'Throughput', 'Avg SNR', 'Poor signal', 'TX power'],
      rows: sortBy(radioLoad(S, venue, p._match), p.sort).slice(0, clampN(p.n, 12)).map((r) => ({ tone: r.clients >= 20 ? 'warn' : r.clients ? 'ok' : 'muted', cells: [r.apName, r.apGroup || '—', `${r.band}${r.channel != null ? ` · Ch ${r.channel}` : ''}${r.width ? ` · ${r.width}` : ''}`, r.clients, r.mbps == null ? '—' : f.mbps(r.mbps), r.snr == null ? '—' : f.db(r.snr), r.poor == null ? '—' : f.pct(r.poor), r.txPower == null ? '—' : f.dbmTx(r.txPower)] })) })),
    mk('a.load.channels', 'Channel load (radios, clients, throughput per channel)', 6, 4, [{ name: 'n', label: 'Rows', default: 10 }], (S, venue, p) => {
      const m = new Map(); for (const r of radioLoad(S, venue, p._match)) { if (r.channel == null) continue; const k = `${r.band} · Ch ${r.channel}`; const e = m.get(k) || { radios: 0, clients: 0, mbps: 0, any: false }; e.radios++; e.clients += r.clients; if (r.mbps != null) { e.mbps += r.mbps; e.any = true; } m.set(k, e); }
      return { kind: 'table', title: venueTitle(S, venue, 'Channel load'), columns: ['Channel', 'Radios', 'Clients', 'Throughput', 'Clients / radio'], rows: [...m].sort((a, b) => b[1].clients - a[1].clients || b[1].radios - a[1].radios).slice(0, clampN(p.n, 10)).map(([k, e]) => ({ cells: [k, e.radios, e.clients, e.any ? f.mbps(e.mbps) : '—', num(e.clients / e.radios)] })) }; }),
    mk('a.load.aps', 'AP load (clients per band, throughput, signal)', 6, 4, [{ name: 'n', label: 'Rows', default: 10 }, { name: 'sort', label: 'Sort by (1 = clients, 2 = throughput)', default: 1 }], (S, venue, p) => {
      const m = new Map(); for (const r of radioLoad(S, venue, p._match)) { const e = m.get(r.apName) || { group: r.apGroup, c24: 0, c5: 0, c6: 0, clients: 0, mbps: null, snr: [] }; e.clients += r.clients; if (r.band === '2.4 GHz') e.c24 += r.clients; else if (r.band === '5 GHz') e.c5 += r.clients; else if (r.band === '6 GHz') e.c6 += r.clients; if (r.mbps != null) e.mbps = (e.mbps || 0) + r.mbps; if (r.snr != null) e.snr.push(r.snr); m.set(r.apName, e); }
      const rows = [...m].map(([name, e]) => ({ name, ...e })).sort((a, b) => (Number(p.sort) === 2 ? (b.mbps || 0) - (a.mbps || 0) : b.clients - a.clients));
      return { kind: 'table', title: venueTitle(S, venue, 'AP load'), columns: ['AP', 'Clients', '2.4', '5', '6', 'Throughput', 'Avg SNR'], rows: rows.slice(0, clampN(p.n, 10)).map((e) => ({ tone: e.clients >= 30 ? 'warn' : 'ok', cells: [e.name, e.clients, e.c24, e.c5, e.c6, e.mbps == null ? '—' : f.mbps(e.mbps), e.snr.length ? f.db(avg(e.snr)) : '—'] })) }; })
  ];
}

function rfWidgets() {
  const rssiOf = (a) => (a.length ? avg(a) : null);
  const rows = (S, venue, p) => byMatch(inV(S.clients, venue), p._match);
  const num = (v, d = 1) => (v == null ? '—' : String(Math.round(v * 10 ** d) / 10 ** d));
  return [
    { type: 'a.rf.quality', title: 'RF quality by venue / AP group / band', group: 'RF', sub: 'Tables', needs: [], match: true, w: 12, h: 5, params: [{ name: 'n', label: 'Rows', default: 12 }], compute: (S, venue, p) => {
      const m = new Map(); const vn = new Map(S.venues.map((v) => [v.id, v.name]));
      for (const c of rows(S, venue, p)) { const k = `${vn.get(c.venueId) || c.venueId}\u0001${c.apGroup || 'Unassigned'}\u0001${c.band || '?'}`; if (!m.has(k)) m.set(k, []); m.get(k).push(c); }
      const out = [...m].map(([k, cs]) => { const [v, g, b] = k.split('\u0001'); const r = cs.filter((x) => x.rssi != null).map((x) => x.rssi), sn = cs.filter((x) => x.snr != null).map((x) => x.snr), nf = cs.filter((x) => x.noiseFloor != null).map((x) => x.noiseFloor);
        return { n: cs.length, cells: [v, g, b, cs.length, num(rssiOf(r)), r.length ? Math.min(...r) : '—', r.length ? Math.max(...r) : '—', num(rssiOf(sn)), sn.length ? Math.min(...sn) : '—', sn.length ? Math.max(...sn) : '—', num(rssiOf(nf), 0)] }; }).sort((a, b) => b.n - a.n).slice(0, clampN(p.n, 12));
      return { kind: 'table', title: venueTitle(S, venue, 'RF quality by venue / AP group / band') + (p._match ? ` — AP group contains “${p._match}”` : ''), columns: ['Venue', 'AP group', 'Band', 'Clients', 'Avg RSS', 'Min RSS', 'Max RSS', 'Avg SNR', 'Min SNR', 'Max SNR', 'Noise'], rows: out };
    } },
    { type: 'a.rf.coverage', title: 'Coverage by band (use “AP group contains”)', group: 'RF', sub: 'Tables', needs: [], match: true, w: 6, h: 3, params: [], compute: (S, venue, p) => ({
      kind: 'table', title: `Coverage — ${p._match ? `AP groups containing “${p._match}”` : 'all AP groups'}`, columns: ['Band', 'Clients', 'Rate', 'Avg RSS', 'Avg SNR', 'Noise'],
      rows: BANDS.filter((b) => b[2]).map(([id, label, re]) => { const cs = rows(S, venue, p).filter((c) => re.test(c.band)); const r = cs.filter((x) => x.rssi != null).map((x) => x.rssi), sn = cs.filter((x) => x.snr != null).map((x) => x.snr), nf = cs.filter((x) => x.noiseFloor != null).map((x) => x.noiseFloor), th = cs.filter((x) => x.mbps != null);
        return { tone: r.length && avg(r) < -75 ? 'bad' : r.length && avg(r) < -65 ? 'warn' : cs.length ? 'ok' : 'muted', cells: [label, cs.length, th.length ? f.mbps(th.reduce((n, x) => n + x.mbps, 0)) : '—', r.length ? `${num(avg(r))} dBm` : '—', sn.length ? `${num(avg(sn))} dB` : '—', nf.length ? `${num(avg(nf), 0)} dBm` : '—'] }; }) }) }
  ];
}

// ---------------- RUCKUS One look-alikes: the tiles of R1's Dashboard, Wireless/WLAN reports and Wired report ----------------
const statusTone = { Operational: 'ok', Degraded: 'warn', Initializing: 'info', Disconnected: 'bad', Unknown: 'muted' };
function r1Widgets() {
  const mk = (type, title, sub, w, h, needs, compute) => ({ type, title, group: 'RUCKUS One style', sub, needs, w, h, params: [], compute });
  return [
    mk('r1.alarms', 'Alarms (ring by severity)', 'Dashboard', 3, 4, [], (S, v) => { const a = inV(S.alarms, v); const t = {}; for (const x of a) t[x.severity] = (t[x.severity] || 0) + 1;
      const tone = { Critical: 'bad', Major: 'warn', Minor: 'info', Warning: 'info', Info: 'muted' }; const order = ['Critical', 'Major', 'Minor', 'Warning', 'Info'];
      return { kind: 'donut', title: venueTitle(S, v, 'Alarms'), items: order.filter((k) => t[k]).map((k) => ({ label: k, value: t[k], tone: tone[k] })), centerLabel: a.length === 1 ? 'alarm' : 'alarms', center: a.length }; }),
    mk('r1.client_experience', 'Client Experience', 'Dashboard', 3, 4, ['analytics'], (S, v) => {
      const cl = inV(S.clients, v), aps = inV(S.aps, v); const onl = aps.filter(up).length; const pctOn = aps.length ? (onl / aps.length) * 100 : null;
      const sg = cl.filter((c) => c.rssi != null); const poor = sg.length ? (sg.filter((c) => c.rssi < -80).length / sg.length) * 100 : null; const snr = avg(cl.filter((c) => c.snr != null).map((c) => c.snr)); const rs = avg(sg.map((c) => c.rssi));
      const thr = cl.some((c) => c.mbps != null) ? cl.reduce((n, c) => n + (c.mbps || 0), 0) : null;
      const A = S.analytics; const cp = A && A.conn && A.conn.att ? (A.conn.ok / A.conn.att) * 100 : null;
      return { kind: 'table', title: venueTitle(S, v, 'Client Experience'), columns: ['Measure', 'Value'], rows: [
        ...(A ? [{ tone: cp == null ? 'muted' : cp >= 95 ? 'ok' : cp >= 85 ? 'warn' : 'bad', cells: ['Connection success (24 h)', cp == null ? '—' : `${f.pct(cp)}  (${nfmt.format(A.conn.ok)} / ${nfmt.format(A.conn.att)})`] }, { tone: A.ttcMs == null ? 'muted' : A.ttcMs < 2000 ? 'ok' : A.ttcMs < 5000 ? 'warn' : 'bad', cells: ['Time to connect (avg)', A.ttcMs == null ? '—' : f.ms(A.ttcMs)] }] : []),
        { tone: thr == null ? 'muted' : 'ok', cells: ['Client throughput', thr == null ? 'measuring…' : f.mbps(thr)] },
        { tone: pctOn == null ? 'muted' : pctOn >= 98 ? 'ok' : pctOn >= 90 ? 'warn' : 'bad', cells: ['Online APs', pctOn == null ? '—' : `${onl} / ${aps.length}  (${Math.round(pctOn)}%)`] },
        { tone: poor == null ? 'muted' : poor < 10 ? 'ok' : poor < 25 ? 'warn' : 'bad', cells: ['Poor-signal clients', poor == null ? '—' : f.pct(poor)] },
        { tone: snr == null ? 'muted' : snr >= 25 ? 'ok' : snr >= 15 ? 'warn' : 'bad', cells: ['Average SNR', snr == null ? '—' : f.db(snr)] },
        { tone: rs == null ? 'muted' : rs >= -65 ? 'ok' : rs >= -75 ? 'warn' : 'bad', cells: ['Average signal', rs == null ? '—' : f.dbm(rs)] }] }; }),
    mk('r1.venues', 'Venues (ring by status)', 'Dashboard', 3, 4, [], (S, v) => {
      const t = { Operational: 0, 'In setup phase': 0, 'Requires attention': 0 };
      for (const ven of S.venues.filter((x) => !v || x.id === v)) { const devs = [...S.aps, ...S.switches].filter((d) => d.venueId === ven.id); if (devs.some((d) => d.status === 'Disconnected')) t['Requires attention']++; else if (devs.some((d) => d.status === 'Initializing')) t['In setup phase']++; else t.Operational++; }
      const tone = { Operational: 'ok', 'In setup phase': 'info', 'Requires attention': 'bad' }; const total = Object.values(t).reduce((a, b) => a + b, 0);
      return { kind: 'donut', title: 'Venues', items: Object.entries(t).filter(([, n]) => n).map(([label, value]) => ({ label, value, tone: tone[label] })), centerLabel: total === 1 ? 'venue' : 'venues', center: total }; }),
    mk('r1.devices', 'Devices (bars by status)', 'Dashboard', 3, 4, [], (S, v) => {
      const seg = (rows) => ['Operational', 'Degraded', 'Initializing', 'Disconnected'].map((k) => ({ label: k === 'Disconnected' ? 'Offline' : k, value: rows.filter((d) => d.status === k).length, tone: statusTone[k] })).filter((x) => x.value);
      return { kind: 'stack', title: venueTitle(S, v, 'Devices'), rows: [{ label: 'Wi-Fi access points', segments: seg(inV(S.aps, v)) }, { label: 'Switches', segments: seg(inV(S.switches, v)) }] }; }),
    mk('r1.clients', 'Clients (Wi-Fi and wired)', 'Dashboard', 3, 4, [], (S, v) => {
      const cl = inV(S.clients, v); const sg = cl.filter((c) => c.rssi != null); const total = cl.length || inV(S.aps, v).reduce((n, a) => n + a.clients, 0);
      const good = sg.filter((c) => c.rssi >= -70).length, fair = sg.filter((c) => c.rssi < -70 && c.rssi >= -80).length, poor = sg.filter((c) => c.rssi < -80).length;
      return { kind: 'stack', title: venueTitle(S, v, 'Clients'), rows: [{ label: `Wi-Fi clients  ·  ${nfmt.format(total)}`, segments: [{ label: 'Good signal', value: good, tone: 'ok' }, { label: 'Fair', value: fair, tone: 'warn' }, { label: 'Poor', value: poor, tone: 'bad' }].filter((x) => x.value) },
        { label: `Switch (wired) clients  ·  ${nfmt.format(inV(S.switches, v).reduce((n, s) => n + s.clients, 0))}`, segments: [{ label: 'Wired', value: inV(S.switches, v).reduce((n, s) => n + s.clients, 0), tone: 'info' }].filter((x) => x.value) }] }; }),
    mk('r1.insights', 'Did you know? (insights)', 'Dashboard', 3, 4, [], (S, v) => {
      const cl = inV(S.clients, v), rows = []; const top = (arr, g) => { const m = new Map(); for (const x of arr) { const k = g(x); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1])[0]; };
      const ssid = top(cl, (c) => c.ssid), apn = top(cl, (c) => c.ap), os = top(cl, (c) => c.os && c.os !== 'Unknown' && c.os), ven = S.venues.map((x) => [x.name, S.clients.filter((c) => c.venueId === x.id).length]).sort((a, b) => b[1] - a[1])[0];
      const hi = cl.length ? Math.round((cl.filter((c) => /^[56]/.test(c.band)).length / cl.length) * 100) : null; const ch = top(S.radios.filter((r) => r.channel != null), (r) => `${r.band} · Ch ${r.channel}`);
      const add = (t, d) => rows.push({ tone: 'info', badge: 'Insight', primary: t, secondary: d || '', meta: '' });
      if (ssid) add(`Busiest WLAN: ${ssid[0]}`, `${ssid[1]} connected clients`); if (apn) add(`Busiest AP: ${apn[0]}`, `${apn[1]} clients`); if (!v && ven && ven[1]) add(`Busiest venue: ${ven[0]}`, `${ven[1]} clients`);
      if (os) add(`Most common client OS: ${os[0]}`, `${os[1]} devices`); if (hi != null) add(`${hi}% of clients are on 5 / 6 GHz`, 'the rest are still on 2.4 GHz'); if (ch) add(`Most-used radio channel: ${ch[0]}`, `${ch[1]} radios`);
      return { kind: 'list', title: 'Did you know?', empty: 'Not enough data yet', rows }; }),
    mk('r1.traffic_trend', 'Traffic trend (downlink / uplink)', 'Wi-Fi report', 6, 4, [], (S, v) => {
      const hrs = 24; const sv = (k) => ({ label: k[0], points: history.series(`${k[1]}@*`, hrs) });
      return { kind: 'multiline', title: 'Traffic Trend — measured throughput (Mbps)', hours: hrs, series: [sv(['Downlink to clients', 'thr_down_mbps']), sv(['Uplink from clients', 'thr_up_mbps'])].filter((x) => x.points.length) }; }),
    mk('r1.wired_overview', 'Switch overview (status, availability, traffic)', 'Switch report', 4, 4, ['ports'], (S, v) => {
      const sw = inV(S.switches, v); const on = sw.filter(up).length; const rx = S.ports.reduce((n, p) => n + (p.mbps || 0), 0); const ever = history.range(`sw_offline@${v || '*'}`, Date.now() - DAY, Date.now()); const everOff = ever.some((r) => r[1] > 0);
      return { kind: 'table', title: venueTitle(S, v, 'Overview'), columns: ['Measure', 'Value'], rows: [
        { tone: on < sw.length ? 'bad' : 'ok', cells: ['Current switch status', `${on} online · ${sw.length - on} offline · ${sw.length} total`] },
        { tone: 'ok', cells: ['Switch availability (24 h)', ever.length ? (everOff ? 'Some switches were offline' : 'All stayed online') : 'collecting history…'] },
        { tone: 'ok', cells: ['Total wired traffic now', S.ports.some((p) => p.mbps != null) ? f.mbps(rx) : 'measuring…'] },
        { tone: 'ok', cells: ['PoE allocated', f.watts(sw.reduce((n, s) => n + (s.poeUsedW || 0), 0))] }] }; })
  ];
}

// ---------------- client-experience analytics (R1's own analytics service — EXPERIMENTAL, network-wide) ----------------
function analyticsWidgets() {
  const note = (S) => (S.errors && S.errors.analytics ? `unavailable: ${S.errors.analytics}`.slice(0, 80) : 'loading…');
  const pctOf = (o, a) => (a ? (o / a) * 100 : null); const R = (v) => Math.round(v * 10) / 10;
  const mk = (type, title, w, h, params, compute) => ({ type, title, group: 'Client experience', sub: 'Analytics (experimental)', needs: ['analytics'], w, h, params, compute });
  const kpiW = (id, title, fn) => mk(`kpi.exp.${id}`, title, 3, 2, [], (S) => ({ kind: 'kpi', title, ...(S.analytics ? fn(S.analytics) : { value: '—', suffix: note(S) }) }));
  const stage = (A, id) => A.stages.find((x) => x.id === id);
  const STAGE_LIST = [['assoc', 'Association'], ['auth', 'Authentication'], ['eap', 'EAP'], ['radius', 'RADIUS'], ['dhcp', 'DHCP']];
  const topOf = (S, k) => (S.analytics && S.analytics.top ? S.analytics.top[k] : []);
  const failItems = (S, dim) => { const tot = new Map(); const A = S.analytics; if (A && A.fails) for (const [id, label] of STAGE_LIST) for (const x of (A.fails[id] && A.fails[id][dim]) || []) { const e = tot.get(x.name) || { n: 0, by: [] }; e.n += x.n; e.by.push(`${label} ${nfmt.format(x.n)}`); tot.set(x.name, e); } return [...tot].map(([name, e]) => ({ label: name, value: e.n, text: nfmt.format(e.n), sub: e.by.join(' · ') })).sort((a, b) => b.value - a.value).slice(0, 10); };
  const out = [
    kpiW('conn_pct', 'Connection success (24 h)', (A) => (A.conn ? { value: R(pctOf(A.conn.ok, A.conn.att)), suffix: `% · ${nfmt.format(A.conn.ok)} of ${nfmt.format(A.conn.att)}` } : { value: '—' })),
    kpiW('attempts', 'Connection attempts (24 h)', (A) => (A.conn ? { value: A.conn.att } : { value: '—' })),
    kpiW('failed', 'Failed connection attempts (24 h)', (A) => (A.conn ? { value: A.conn.att - A.conn.ok } : { value: '—' })),
    kpiW('ttc', 'Average time to connect', (A) => (A.ttcMs == null ? { value: '—' } : { value: R(A.ttcMs / 1000), suffix: 's' })),
    ...[['assoc', 'Association'], ['auth', 'Authentication'], ['eap', 'EAP'], ['radius', 'RADIUS'], ['dhcp', 'DHCP']].map(([id, label]) => kpiW(`stage_${id}`, `${label} success (24 h)`, (A) => { const x = stage(A, id); return x && x.att ? { value: R(pctOf(x.ok, x.att)), suffix: `% · ${nfmt.format(x.ok)} of ${nfmt.format(x.att)}` } : { value: '—', suffix: 'no attempts' }; })),
    mk('exp.stages', 'Connection success by stage', 6, 4, [], (S) => ({ kind: 'table', title: 'Connection success by stage (24 h)', columns: ['Stage', 'Attempts', 'Succeeded', 'Failed', 'Success rate'],
      rows: (S.analytics ? S.analytics.stages : []).map((x) => { const r = pctOf(x.ok, x.att); return { tone: r == null ? 'muted' : r >= 95 ? 'ok' : r >= 85 ? 'warn' : 'bad', cells: [x.label, nfmt.format(x.att), nfmt.format(x.ok), nfmt.format(x.att - x.ok), r == null ? '—' : f.pct(r)] }; }) })),
    mk('exp.failures_bar', 'Connection failures by stage (bars)', 4, 4, [], (S) => ({ kind: 'bar', title: 'Connection failures by stage (24 h)', items: (S.analytics ? S.analytics.stages : []).map((x) => ({ label: x.label, value: x.att - x.ok, text: nfmt.format(x.att - x.ok), sub: x.att ? `${f.pct(100 - pctOf(x.ok, x.att))} of attempts failed` : '' })).sort((a, b) => b.value - a.value) })),
    mk('exp.failures_donut', 'Connection failures by stage (donut)', 3, 4, [], (S) => { const items = (S.analytics ? S.analytics.stages : []).map((x) => ({ label: x.label, value: x.att - x.ok })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value); return { kind: 'donut', title: 'Connection failures by stage (24 h)', items, centerLabel: 'failures', center: items.reduce((n, x) => n + x.value, 0) }; }),
    mk('exp.rates_bar', 'Success rate by stage (bars)', 4, 4, [], (S) => ({ kind: 'bar', title: 'Success rate by stage (24 h)', unit: '%', max: 100, items: (S.analytics ? S.analytics.stages : []).filter((x) => x.att).map((x) => ({ label: x.label, value: R(pctOf(x.ok, x.att)), text: f.pct(pctOf(x.ok, x.att)), sub: `${nfmt.format(x.ok)} of ${nfmt.format(x.att)}` })) })),
    mk('exp.trend', 'Connection success over time (24 h)', 6, 4, [], (S) => ({ kind: 'line', title: 'Connection success rate, last 24 h (%)', hours: 24, unit: '%', points: (S.analytics ? S.analytics.trend15 : []).filter((x) => x.att > 0).map((x) => [x.t, R(pctOf(x.ok, x.att))]) })),
    mk('exp.attempts_trend', 'Connection attempts over time (24 h)', 6, 4, [], (S) => ({ kind: 'multiline', title: 'Connection attempts and failures, last 24 h', hours: 24, series: S.analytics ? [{ label: 'Attempts', points: S.analytics.trend15.map((x) => [x.t, x.att]) }, { label: 'Failed', points: S.analytics.trend15.map((x) => [x.t, x.att - x.ok]) }] : [] })),
    mk('exp.daily', 'Daily connection success (7 days)', 6, 4, [], (S) => ({ kind: 'line', title: 'Connection success rate by day, last 7 days (%)', hours: 168, unit: '%', points: (S.analytics ? S.analytics.daily : []).filter((x) => x.att > 0).map((x) => [x.t, R(pctOf(x.ok, x.att))]) })),
    mk('exp.clients', 'Connected and new clients (24 h)', 6, 4, [], (S) => ({ kind: 'multiline', title: 'Connected and newly connecting clients, last 24 h', hours: 24, series: S.analytics ? [{ label: 'Connected', points: S.analytics.clients.map((x) => [x.t, x.connected]) }, { label: 'New connections', points: S.analytics.clients.map((x) => [x.t, x.added]) }].filter((x) => x.points.length) : [] })),

    // ---- who/what: top lists from the same analytics service (24 h, network-wide)
    mk('exp.top_apps', 'Top applications by traffic', 4, 4, [], (S) => ({ kind: 'bar', title: 'Top applications by traffic (24 h)', items: topOf(S, 'apps').map((x) => ({ label: x.name, value: x.bytes, text: f.bytes(x.bytes) })) })),
    mk('exp.top_apps_clients', 'Top applications by clients', 4, 4, [], (S) => ({ kind: 'bar', title: 'Top applications by clients (24 h)', items: topOf(S, 'appClients').map((x) => ({ label: x.name, value: x.clients, text: nfmt.format(x.clients) })) })),
    mk('exp.top_categories', 'Application categories by traffic', 3, 4, [], (S) => { const items = (S.analytics && S.analytics.top ? S.analytics.top.categories.usage : []).map((x) => ({ label: x.name, value: x.bytes })); return { kind: 'donut', title: 'Application categories (24 h)', items, centerLabel: 'total', center: f.bytes(items.reduce((n, x) => n + x.value, 0)) }; }),
    mk('exp.top_ssids', 'Top SSIDs by traffic', 4, 4, [], (S) => ({ kind: 'bar', title: 'Top SSIDs by traffic (24 h)', items: topOf(S, 'ssids').map((x) => ({ label: x.name, value: x.bytes, text: f.bytes(x.bytes), sub: `${nfmt.format(x.clients)} clients` })) })),
    mk('exp.top_aps', 'Top APs by traffic (24 h)', 4, 4, [], (S) => ({ kind: 'bar', title: 'Top APs by traffic (24 h)', items: topOf(S, 'aps').map((x) => ({ label: x.name, value: x.bytes, text: f.bytes(x.bytes) })) })),
    mk('exp.top_clients', 'Top clients by traffic (24 h, analytics)', 4, 4, [], (S) => ({ kind: 'bar', title: 'Top clients by traffic (24 h)', items: topOf(S, 'clients').map((x) => ({ label: x.name, value: x.bytes, text: f.bytes(x.bytes) })) })),
    ...[['ssid', 'SSIDs'], ['ap', 'APs'], ['maker', 'client makers']].map(([dim, label]) => mk(`exp.fail_${dim}`, `Top ${label} by connection failures`, 4, 4, [], (S) => ({ kind: 'bar', title: `Connection failures by ${dim === 'maker' ? 'client maker' : dim === 'ap' ? 'AP' : 'SSID'} (24 h)`, items: failItems(S, dim) }))),
    mk('exp.fail_table', 'Connection failures: who and where', 12, 5, [], (S) => ({ kind: 'table', title: 'Connection failures by stage — top offenders (24 h)', columns: ['Stage', 'Failed', 'Top SSID', 'Top AP', 'Top client maker'],
      rows: STAGE_LIST.map(([id, label]) => { const F = S.analytics && S.analytics.fails ? S.analytics.fails[id] : null; const x = S.analytics && S.analytics.stages.find((s) => s.id === id); const top = (a) => (a && a[0] ? `${a[0].name} (${nfmt.format(a[0].n)})` : '—'); return { tone: x && x.att - x.ok > 0 ? 'warn' : 'muted', cells: [label, x ? nfmt.format(x.att - x.ok) : '—', top(F && F.ssid), top(F && F.ap), top(F && F.maker)] }; }) }))
  ];
  return out;
}

function all() { return [...entityWidgets(), ...kpiWidgets(), ...trendWidgets(), ...accessWidgets(), ...gaugeWidgets(), ...rfWidgets(), ...loadWidgets(), ...r1Widgets(), ...analyticsWidgets(), ...historyWidgets()].filter((w) => !ALIASES[w.type]); }
module.exports = { all, dimMetrics, TREND_DIMS, ALIASES };
