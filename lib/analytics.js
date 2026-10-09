'use strict';
// Client-experience analytics from R1's own analytics service (EXPERIMENTAL: undocumented API; R1 may change it).
// Runs the same GraphQL operations R1's Dashboard / Health pages run and normalises the answers. Network-wide only.
// Every "…SuccessAndAttemptCount" value R1 returns is a [successes, attempts] pair.
const Q = require('./analytics-queries.json');

const STAGES = [['assoc', 'Association'], ['auth', 'Authentication'], ['eap', 'EAP'], ['radius', 'RADIUS'], ['dhcp', 'DHCP']];
// Incident codes -> readable title + category. Unknown codes fall back to the raw code (category from its prefix).
const INCIDENT_CODES = {
  'ttc': ['Slow time to connect', 'Connection'], 'radius-failure': ['RADIUS failures', 'Connection'], 'eap-failure': ['EAP failures', 'Connection'], 'dhcp-failure': ['DHCP failures', 'Connection'],
  'auth-failure': ['Authentication failures', 'Connection'], 'assoc-failure': ['Association failures', 'Connection'],
  'p-cov-clientrssi-low': ['Low client signal (RSS)', 'Wi-Fi'], 'p-load-sz-cpu-load': ['High controller CPU load', 'Infrastructure'], 'p-switch-memory-high': ['Switch memory high', 'Switching'],
  'p-channeldist-suboptimal-plan-50g-outdoor': ['Suboptimal 5 GHz channel plan (outdoor)', 'Wi-Fi'], 'p-channeldist-suboptimal-plan-50g-indoor': ['Suboptimal 5 GHz channel plan (indoor)', 'Wi-Fi'],
  'i-net-time-future': ['Time set in the future', 'Infrastructure'], 'i-net-time-past': ['Time set in the past', 'Infrastructure'], 'i-net-sz-net-latency': ['High controller network latency', 'Infrastructure'],
  'i-apserv-high-num-reboots': ['High number of AP reboots', 'Infrastructure'], 'i-apserv-continuous-reboots': ['APs rebooting continuously', 'Infrastructure'], 'i-apserv-downtime-high': ['High AP downtime', 'Infrastructure'],
  'i-switch-vlan-mismatch': ['VLAN mismatch between switches', 'Switching'], 'i-switch-poe-pd': ['PoE powered-device problem', 'Switching'], 'i-apinfra-poe-low': ['AP underpowered (PoE)', 'Infrastructure'], 'i-apinfra-wanthroughput-low': ['Low AP WAN throughput', 'Infrastructure'],
  's-switch-tcp-syn-ddos': ['TCP SYN flood (DDoS)', 'Switching'], 'i-switch-loop-detection': ['Switch loop detected', 'Switching'], 'i-switch-lldp-status': ['LLDP status problem', 'Switching'], 'i-switch-port-flap': ['Switch port flapping', 'Switching'],
  'p-switch-port-congestion': ['Switch port congestion', 'Switching'], 'p-switch-uplink-port-congestion': ['Switch uplink congestion', 'Switching']
};
// R1's incident windows end at the last hour it was still seen; one that ended within the last 3 h is treated as ongoing.
const isOpen = (inc, now = Date.now()) => now - inc.end < 3 * 3600e3;
const AIRTIME = /^p-airtime-/;
const codeInfo = (code) => { const k = INCIDENT_CODES[code]; if (k) return { title: k[0], category: k[1] }; if (AIRTIME.test(code)) { const m = /p-airtime-(b|rx|tx)-(\d+)\(?(\d*)\)?g-high/.exec(code); const band = m ? { 24: '2.4 GHz', 50: '5 GHz', 6: '6 GHz' }[m[2]] || '' : ''; return { title: `High airtime${m ? ` (${{ b: 'busy', rx: 'receive', tx: 'transmit' }[m[1]]})` : ''}${band ? ` — ${band}` : ''}`, category: 'Wi-Fi' }; } return { title: code, category: /switch/.test(code) ? 'Switching' : /^i-|^p-load/.test(code) ? 'Infrastructure' : 'Other' }; };
// R1 scores incidents 0..1; these cut-offs approximate its P1-P4 bands.
const sevLabel = (v) => (v >= 0.8 ? 'Critical' : v >= 0.6 ? 'High' : v >= 0.3 ? 'Medium' : 'Low');
const pair = (v) => { const p = Array.isArray(v) && Array.isArray(v[0]) ? v[0] : Array.isArray(v) ? v : null; return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? { ok: p[0], att: p[1] } : null; };
const series = (ts) => (ts && ts.time ? ts.time.map((t, i) => { const p = pair(ts.data[i]); return { t: Date.parse(t), ok: p ? p.ok : 0, att: p ? p.att : 0 }; }) : []);

async function fetchAnalytics(gql, now = Date.now(), venueNames = []) {
  const iso = (ms) => new Date(ms).toISOString(); const end = iso(now); const path = [{ type: 'network', name: 'Network' }];
  const jobs = {
    health: () => gql(Q.queries.HealthSummary, { filter: {}, start: iso(now - 24 * 3600e3), end, path, granularity: 'all' }),
    drill: () => gql(Q.queries.ConnectionDrilldown, { filter: {}, start: iso(now - 24 * 3600e3), end, path, granularity: 'all' }),
    ts15: () => gql(Q.queries.timeseriesKPI, { start: iso(now - 24 * 3600e3), end, granularity: 'PT15M', filter: {}, enableSwitchFirmwareFilter: false }),
    daily: () => gql(Q.queries.timeseriesKPI, { start: iso(now - 7 * 86400e3), end, granularity: 'P1D', filter: {}, enableSwitchFirmwareFilter: false }),
    clients: () => gql(Q.queries.NetworkHistoryWidget, { start: iso(now - 24 * 3600e3), end, granularity: 'PT15M', severity: [{ gt: 0, lte: 1 }], code: Q.codes, path, filter: {} })
  };
  for (const [id] of STAGES) jobs[`fail_${id}`] = () => gql(Q.queries.FailuresByStage, { start: iso(now - 24 * 3600e3), end, path, stage: id });
  const vn = [...new Set(venueNames)].filter(Boolean).slice(0, 40);   // per-venue ("zone") connection KPIs: one aliased query
  if (vn.length) {
    const KPI = 'connectionSuccess assocSuccess authSuccess eapSuccess radiusSuccess dhcpSuccess timeToConnect onlineAPCount roamingSuccess clientRss apUpTime';
    const decl = vn.map((_, i) => `,$p${i}:[HierarchyNodeInput]`).join(''); const body = vn.map((_, i) => `v${i}: KPI(start:$start,end:$end,path:$p${i}){ ${KPI} }`).join(' ');
    const variables = { start: iso(now - 24 * 3600e3), end }; vn.forEach((n, i) => { variables[`p${i}`] = [{ type: 'network', name: 'Network' }, { type: 'zone', name: n }]; });
    jobs.venues = () => gql(`query($start:DateTime,$end:DateTime${decl}){ network(start:$start,end:$end){ ${body} } }`, variables).then((r) => ({ vn, r }));
  }
  jobs.kpi = () => gql('query($start:DateTime,$end:DateTime,$path:[HierarchyNodeInput]){ network(start:$start,end:$end){ KPI(start:$start,end:$end,path:$path){ roamingSuccess clientRss apUpTime poeUtilization } } }', { start: iso(now - 24 * 3600e3), end, path });
  jobs.incidents = () => gql(Q.queries.Incidents, { start: iso(now - 7 * 86400e3), end, path });
  jobs.top = () => gql(Q.queries.TopTraffic, { start: iso(now - 24 * 3600e3), end, path });
  const keys = Object.keys(jobs); const res = await Promise.allSettled(keys.map((k) => jobs[k]())); const errors = {}; const R = {};
  res.forEach((r, i) => { if (r.status === 'fulfilled') R[keys[i]] = r.value; else errors[keys[i]] = r.reason.message; });
  if (!Object.keys(R).length) throw new Error(Object.values(errors)[0] || 'analytics unavailable');
  const out = { at: now, errors, conn: null, ttcMs: null, stages: [], kpi: null, byVenue: {}, incidents: null, top: null, fails: {}, trend15: [], daily: [], clients: [] };
  try { out.conn = pair(R.health.network.timeSeries.connectionSuccessAndAttemptCount); const t = R.health.network.avgTTC.incidentCharts.ttc; out.ttcMs = Array.isArray(t) ? t[0] : t; } catch { /* part missing */ }
  try { const d = R.drill.network.connectionDrilldown; out.stages = STAGES.map(([id, label]) => { const p = pair(d[`${id}SuccessAndAttemptCount`]); return p ? { id, label, ok: p.ok, att: p.att } : null; }).filter(Boolean); } catch { /* part missing */ }
  try { out.trend15 = series(R.ts15.network.timeSeries); } catch { /* part missing */ }
  try { out.daily = series(R.daily.network.timeSeries); } catch { /* part missing */ }
  try { const h = R.clients.network.hierarchyNode.timeSeries; out.clients = h.time.map((t, i) => ({ t: Date.parse(t), added: h.newClientCount[i] || 0, impacted: h.impactedClientCount[i] || 0, connected: h.connectedClientCount[i] || 0 })); } catch { /* part missing */ }
  try { const k = R.kpi.network.KPI; const pc = (v) => (typeof v === 'number' ? v * 100 : null); out.kpi = { roaming: pc(k.roamingSuccess), rss: typeof k.clientRss === 'number' ? k.clientRss : null, apUp: pc(k.apUpTime), poe: pc(k.poeUtilization) }; } catch { /* part missing */ }
  try {
    const pc = (v) => (typeof v === 'number' && Number.isFinite(v) ? v * 100 : null);
    R.venues.vn.forEach((name, i) => { const k = R.venues.r.network[`v${i}`]; if (k && (k.connectionSuccess != null || k.timeToConnect != null)) out.byVenue[name] = { conn: pc(k.connectionSuccess), assoc: pc(k.assocSuccess), auth: pc(k.authSuccess), eap: pc(k.eapSuccess), radius: pc(k.radiusSuccess), dhcp: pc(k.dhcpSuccess), ttcMs: k.timeToConnect, aps: k.onlineAPCount, roaming: pc(k.roamingSuccess), rss: typeof k.clientRss === 'number' ? k.clientRss : null, apUp: pc(k.apUpTime) }; });
  } catch { /* part missing */ }
  try {
    out.incidents = (R.incidents.network.hierarchyNode.incidents || []).map((x) => { const i = codeInfo(x.code); return { id: x.id, code: x.code, title: i.title, category: i.category, severity: x.severity, level: sevLabel(x.severity), start: Date.parse(x.startTime), end: Date.parse(x.endTime), where: x.sliceValue || '', scope: x.sliceType || '', muted: !!x.isMuted, clients: x.impactedClientCount >= 0 ? x.impactedClientCount : null, switches: x.switchCount >= 0 ? x.switchCount : null, airtime: AIRTIME.test(x.code) }; }).sort((a, b) => b.start - a.start);
  } catch { /* part missing */ }
  try {
    const h = R.top.network.hierarchyNode; const L = (v) => (Array.isArray(v) ? v : []);
    out.top = {
      apps: L(h.apps).map((x) => ({ name: x.name, bytes: x.applicationTraffic || 0 })), appClients: L(h.appClients).map((x) => ({ name: x.name, clients: x.clientCount || 0 })),
      categories: L(h.categories).map((c) => ({ usage: L(c.dataUsage).map((x) => ({ name: x.name, bytes: x.value || 0 })), clients: L(c.clientCount).map((x) => ({ name: x.name, clients: x.value || 0 })) }))[0] || { usage: [], clients: [] },
      ssids: L(h.ssids).map((x) => ({ name: x.name, bytes: x.userTraffic || 0, clients: x.clientCount || 0 })), aps: L(h.aps).map((x) => ({ name: x.apName || x.apMac, bytes: x.traffic || 0 })),
      clients: L(h.clients).map((x) => ({ name: x.hostname || x.clientMac, bytes: x.traffic || 0 }))
    };
  } catch { /* part missing */ }
  for (const [id] of STAGES) {
    try { const h = R[`fail_${id}`].network.hierarchyNode; const L = (v) => (Array.isArray(v) ? v : []).map((x) => ({ name: x.key || x.name || '—', n: x.value || 0 })).filter((x) => x.n > 0); out.fails[id] = { ssid: L(h.ssid), ap: L(h.ap), maker: L(h.maker) }; } catch { /* stage missing */ }
  }
  if (!out.conn && out.stages.length) { const a = out.stages.reduce((n, s) => n + s.att, 0); if (a) out.conn = { ok: out.stages.reduce((n, s) => n + s.ok, 0), att: a }; }
  return out;
}
module.exports = { fetchAnalytics, STAGES, codeInfo, sevLabel, isOpen, INCIDENT_CODES };
