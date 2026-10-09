'use strict';
// Client-experience analytics from R1's own analytics service (EXPERIMENTAL: undocumented API; R1 may change it).
// Runs the same GraphQL operations R1's Dashboard / Health pages run and normalises the answers. Network-wide only.
// Every "…SuccessAndAttemptCount" value R1 returns is a [successes, attempts] pair.
const Q = require('./analytics-queries.json');

const STAGES = [['assoc', 'Association'], ['auth', 'Authentication'], ['eap', 'EAP'], ['radius', 'RADIUS'], ['dhcp', 'DHCP']];
const pair = (v) => { const p = Array.isArray(v) && Array.isArray(v[0]) ? v[0] : Array.isArray(v) ? v : null; return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? { ok: p[0], att: p[1] } : null; };
const series = (ts) => (ts && ts.time ? ts.time.map((t, i) => { const p = pair(ts.data[i]); return { t: Date.parse(t), ok: p ? p.ok : 0, att: p ? p.att : 0 }; }) : []);

async function fetchAnalytics(gql, now = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString(); const end = iso(now); const path = [{ type: 'network', name: 'Network' }];
  const jobs = {
    health: () => gql(Q.queries.HealthSummary, { filter: {}, start: iso(now - 24 * 3600e3), end, path, granularity: 'all' }),
    drill: () => gql(Q.queries.ConnectionDrilldown, { filter: {}, start: iso(now - 24 * 3600e3), end, path, granularity: 'all' }),
    ts15: () => gql(Q.queries.timeseriesKPI, { start: iso(now - 24 * 3600e3), end, granularity: 'PT15M', filter: {}, enableSwitchFirmwareFilter: false }),
    daily: () => gql(Q.queries.timeseriesKPI, { start: iso(now - 7 * 86400e3), end, granularity: 'P1D', filter: {}, enableSwitchFirmwareFilter: false }),
    clients: () => gql(Q.queries.NetworkHistoryWidget, { start: iso(now - 24 * 3600e3), end, granularity: 'PT15M', severity: [{ gt: 0, lte: 1 }], code: Q.codes, path, filter: {} })
  };
  const keys = Object.keys(jobs); const res = await Promise.allSettled(keys.map((k) => jobs[k]())); const errors = {}; const R = {};
  res.forEach((r, i) => { if (r.status === 'fulfilled') R[keys[i]] = r.value; else errors[keys[i]] = r.reason.message; });
  if (!Object.keys(R).length) throw new Error(Object.values(errors)[0] || 'analytics unavailable');
  const out = { at: now, errors, conn: null, ttcMs: null, stages: [], trend15: [], daily: [], clients: [] };
  try { out.conn = pair(R.health.network.timeSeries.connectionSuccessAndAttemptCount); const t = R.health.network.avgTTC.incidentCharts.ttc; out.ttcMs = Array.isArray(t) ? t[0] : t; } catch { /* part missing */ }
  try { const d = R.drill.network.connectionDrilldown; out.stages = STAGES.map(([id, label]) => { const p = pair(d[`${id}SuccessAndAttemptCount`]); return p ? { id, label, ok: p.ok, att: p.att } : null; }).filter(Boolean); } catch { /* part missing */ }
  try { out.trend15 = series(R.ts15.network.timeSeries); } catch { /* part missing */ }
  try { out.daily = series(R.daily.network.timeSeries); } catch { /* part missing */ }
  try { const h = R.clients.network.hierarchyNode.timeSeries; out.clients = h.time.map((t, i) => ({ t: Date.parse(t), added: h.newClientCount[i] || 0, impacted: h.impactedClientCount[i] || 0, connected: h.connectedClientCount[i] || 0 })); } catch { /* part missing */ }
  if (!out.conn && out.stages.length) { const a = out.stages.reduce((n, s) => n + s.att, 0); if (a) out.conn = { ok: out.stages.reduce((n, s) => n + s.ok, 0), att: a }; }
  return out;
}
module.exports = { fetchAnalytics, STAGES };
