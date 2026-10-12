'use strict';
// Alert rules: "metric OP threshold, held for N seconds" → an alert with a severity. Alerts can take over every
// display (until acknowledged) and/or be sent to notification channels. Evaluated after every poll and every 20 s.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'rules.json');
const up = (d) => d.status === 'Operational' || d.status === 'Degraded';
const inV = (rows, v) => (v && !v.startsWith('c:') ? rows.filter((r) => r.venueId === v) : rows);
const pct = (n, d) => (d ? (n / d) * 100 : null);
const max = (a) => (a.length ? Math.max(...a) : null);
const DAY = 86400e3;

// id → { label, unit, perVenue (can be evaluated per venue), needs, fn(S, venueId) → number | null }
const METRICS = {
  alarms_critical:  { label: 'Critical alarms', unit: '', perVenue: true, fn: (S, v) => inV(S.alarms, v).filter((a) => a.severity === 'Critical').length },
  alarms_major:     { label: 'Major alarms', unit: '', perVenue: true, fn: (S, v) => inV(S.alarms, v).filter((a) => a.severity === 'Major').length },
  alarms_total:     { label: 'Active alarms', unit: '', perVenue: true, fn: (S, v) => inV(S.alarms, v).length },
  aps_offline:      { label: 'APs offline', unit: '', perVenue: true, fn: (S, v) => inV(S.aps, v).filter((a) => a.status === 'Disconnected').length },
  aps_offline_pct:  { label: 'APs offline', unit: '%', perVenue: true, fn: (S, v) => pct(inV(S.aps, v).filter((a) => a.status === 'Disconnected').length, inV(S.aps, v).length) },
  aps_avail_pct:    { label: 'AP availability', unit: '%', perVenue: true, fn: (S, v) => pct(inV(S.aps, v).filter(up).length, inV(S.aps, v).length) },
  sw_offline:       { label: 'Switches offline', unit: '', perVenue: true, fn: (S, v) => inV(S.switches, v).filter((a) => a.status === 'Disconnected').length },
  sw_cpu_max:       { label: 'Highest switch CPU', unit: '%', perVenue: true, fn: (S, v) => max(inV(S.switches, v).map((s) => s.cpu).filter((x) => x != null)) },
  sw_mem_max:       { label: 'Highest switch memory', unit: '%', perVenue: true, fn: (S, v) => max(inV(S.switches, v).map((s) => s.memory).filter((x) => x != null)) },
  poe_pct:          { label: 'PoE budget used', unit: '%', perVenue: true, fn: (S, v) => { const a = inV(S.switches, v); const t = a.reduce((n, s) => n + (s.poeTotalW || 0), 0); return t ? pct(a.reduce((n, s) => n + (s.poeUsedW || 0), 0), t) : null; } },
  clients_total:    { label: 'Connected clients', unit: '', perVenue: true, fn: (S, v) => inV(S.clients, v).length },
  clients_poor_pct: { label: 'Clients with poor signal', unit: '%', perVenue: true, fn: (S, v) => { const c = inV(S.clients, v).filter((x) => x.rssi != null); return pct(c.filter((x) => x.rssi < -80).length, c.length); } },
  ap_max_clients:   { label: 'Most clients on one AP', unit: '', perVenue: true, fn: (S, v) => max(inV(S.aps, v).map((a) => a.clients)) },
  ports_errdisabled:{ label: 'Err-disabled ports', unit: '', perVenue: true, needs: ['ports'], fn: (S, v) => (S.ports.length ? inV(S.ports, v).filter((p) => p.errDisabled).length : null) },
  ports_with_errors:{ label: 'Ports with errors', unit: '', perVenue: true, needs: ['ports'], fn: (S, v) => (S.ports.length ? inV(S.ports, v).filter((p) => p.errors > 0).length : null) },
  dpsk_expiring_7d: { label: 'DPSK users expiring within 7 days', unit: '', needs: ['dpsk'], fn: (S) => (S.dpsk.length ? S.dpsk.filter((p) => p.active && p.expiresAt && p.expiresAt - Date.now() < 7 * DAY).length : null) },
  guests_expiring_24h: { label: 'Guest passes expiring within 24 h', unit: '', needs: ['guests'], fn: (S) => (S.guests.length ? S.guests.filter((g) => !g.expired && g.expiry && g.expiry - Date.now() < DAY).length : null) },
  conn_success_pct: { label: 'Connection success (24 h)', unit: '%', needs: ['analytics'], fn: (S) => (S.analytics && S.analytics.conn && S.analytics.conn.att ? (S.analytics.conn.ok / S.analytics.conn.att) * 100 : null) },
  ttc_seconds:      { label: 'Average time to connect', unit: ' s', needs: ['analytics'], fn: (S) => (S.analytics && S.analytics.ttcMs != null ? S.analytics.ttcMs / 1000 : null) },
  incidents_open:   { label: 'Open incidents (R1 analytics)', unit: '', needs: ['analytics'], fn: (S) => (S.analytics && S.analytics.incidents ? S.analytics.incidents.filter((x) => require('./analytics').isOpen(x)).length : null) },
  incidents_high:   { label: 'Open high/critical incidents (R1 analytics)', unit: '', needs: ['analytics'], fn: (S) => (S.analytics && S.analytics.incidents ? S.analytics.incidents.filter((x) => x.severity >= 0.6 && require('./analytics').isOpen(x)).length : null) },
  msp_expiry_days:  { label: 'Days until the nearest customer account expires (MSP)', unit: ' days', fn: (S) => { const d = (S.customers || []).filter((c) => c.meta && c.meta.expiresInDays != null).map((c) => c.meta.expiresInDays); return d.length ? Math.min(...d) : null; } },
  msp_subs_expiring:{ label: 'MSP subscriptions expiring within 60 days', unit: '', fn: (S) => (S.msp && S.msp.entitlements && S.msp.entitlements.length ? S.msp.entitlements.filter((e) => e.expiresInDays != null && e.expiresInDays <= 60).length : null) },
  ports_flapping:   { label: 'Flapping switch ports (≥ 3 link changes in 30 min)', unit: '', perVenue: true, needs: ['ports'], fn: (S, v) => { if (!S.ports || !S.ports.length) return null; const cut = Date.now() - 30 * 60e3; const m = new Map(); for (const e of inV(S.portEvents || [], v)) if (e.t >= cut && (e.kind === 'up' || e.kind === 'down')) { const k = `${e.venueId}|${e.switchName}|${e.port}`; m.set(k, (m.get(k) || 0) + 1); } return [...m.values()].filter((n) => n >= 3).length; } },
  stp_changes_1h:   { label: 'Spanning-tree state changes in the last hour', unit: '', perVenue: true, needs: ['ports'], fn: (S, v) => (S.ports && S.ports.length ? inV(S.portEvents || [], v).filter((e) => e.kind === 'stp' && e.t >= Date.now() - 3600e3).length : null) },
  sw_loops_open:    { label: 'Switch loop incidents ongoing (R1 analytics)', unit: '', needs: ['analytics'], fn: (S) => (S.analytics && S.analytics.incidents ? S.analytics.incidents.filter((x) => x.code === 'i-switch-loop-detection' && require('./analytics').isOpen(x)).length : null) },
  sw_incidents_open:{ label: 'Open switching incidents (R1 analytics)', unit: '', needs: ['analytics'], fn: (S) => (S.analytics && S.analytics.incidents ? S.analytics.incidents.filter((x) => x.category === 'Switching' && require('./analytics').isOpen(x)).length : null) },
  customers_down:   { label: 'Customers unreachable (MSP)', unit: '', fn: (S) => (S.customers && S.customers.length ? S.customers.filter((c) => !c.ok).length : null) },
  cert_days_left:   { label: 'TLS certificate days left', unit: ' days', fn: () => require('./tls').daysLeft() },
  data_age_min:     { label: 'Minutes since last good poll', unit: ' min', fn: (S) => (S.at ? (Date.now() - S.at) / 60000 : null) },
  sources_failing:  { label: 'Core data sources failing', unit: '', fn: (S) => ['venues', 'aps', 'switches', 'clients', 'alarms'].filter((k) => S.errors && S.errors[k]).length }
};

const DEFAULT_RULES = [
  { id: 'r-crit-alarm', name: 'Critical alarm raised', enabled: true, metric: 'alarms_critical', op: '>=', threshold: 1, severity: 'crit', forSeconds: 0, perVenue: false, takeover: true, notify: true, repeatMinutes: 60 },
  { id: 'r-sw-offline', name: 'Switch offline', enabled: true, metric: 'sw_offline', op: '>=', threshold: 1, severity: 'crit', forSeconds: 120, perVenue: true, takeover: true, notify: true, repeatMinutes: 60 },
  { id: 'r-ap-offline', name: 'Many APs offline', enabled: true, metric: 'aps_offline_pct', op: '>=', threshold: 10, severity: 'warn', forSeconds: 300, perVenue: true, takeover: false, notify: true, repeatMinutes: 0 },
  { id: 'r-sw-cpu', name: 'Switch CPU high', enabled: true, metric: 'sw_cpu_max', op: '>=', threshold: 85, severity: 'warn', forSeconds: 300, perVenue: false, takeover: false, notify: true, repeatMinutes: 0 },
  { id: 'r-poe', name: 'PoE budget nearly exhausted', enabled: true, metric: 'poe_pct', op: '>=', threshold: 90, severity: 'warn', forSeconds: 600, perVenue: false, takeover: false, notify: false, repeatMinutes: 0 },
  { id: 'r-cert', name: 'TLS certificate expiring', enabled: true, metric: 'cert_days_left', op: '<=', threshold: 14, severity: 'warn', forSeconds: 0, perVenue: false, takeover: false, notify: true, repeatMinutes: 1440 },
  { id: 'r-stale', name: 'NOC data is stale', enabled: true, metric: 'data_age_min', op: '>=', threshold: 5, severity: 'crit', forSeconds: 0, perVenue: false, takeover: true, notify: true, repeatMinutes: 30 }
];

const OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b };
const clean = (r, i) => ({
  id: String(r.id || `r-${Date.now().toString(36)}${i}`).slice(0, 40), name: String(r.name || 'Rule').slice(0, 60), enabled: r.enabled !== false,
  metric: METRICS[r.metric] ? r.metric : 'alarms_critical', op: OPS[r.op] ? r.op : '>=', threshold: Number.isFinite(Number(r.threshold)) ? Number(r.threshold) : 1,
  severity: r.severity === 'crit' ? 'crit' : 'warn', forSeconds: Math.max(0, Math.min(86400, Math.round(Number(r.forSeconds) || 0))),
  perVenue: Boolean(r.perVenue) && !r.perCustomer && Boolean((METRICS[r.metric] || {}).perVenue), perCustomer: Boolean(r.perCustomer) && Boolean((METRICS[r.metric] || {}).perVenue), takeover: Boolean(r.takeover), notify: r.notify !== false && Boolean(r.notify), repeatMinutes: Math.max(0, Math.min(1440, Math.round(Number(r.repeatMinutes) || 0)))
});

let rules = load();
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')).map(clean); } catch { return DEFAULT_RULES.map(clean); } }
function save(list) {
  if (!Array.isArray(list)) throw new Error('rules must be a list');
  rules = list.slice(0, 50).map(clean);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(rules, null, 2)); fs.renameSync(FILE + '.tmp', FILE);
  return rules;
}

// ---- evaluation ----
const state = new Map();   // key = ruleId|venueId → { condSince, firedAt, lastNotified, ackUntil, value, venueName }
const fmtVal = (v, m) => `${Math.round(v * 10) / 10}${m.unit}`;

function evaluate(S, now = Date.now()) {
  const events = []; const seen = new Set();
  for (const r of rules) {
    if (!r.enabled) continue;
    const m = METRICS[r.metric];
    const msp = Array.isArray(S.customers) && S.customers.length > 0;   // MSP mode: label venues with their customer; optionally evaluate per customer
    const perC = msp && (r.perCustomer || (!r.perVenue && m.perVenue));   // MSP: a network-wide rule is evaluated per customer so the alert names who it is for
    const scopes = perC ? S.customers.map((c) => [`c:${c.id}`, c.name]) : r.perVenue ? S.venues.map((v) => [v.id, msp && v.customer ? `${v.customer} / ${v.name}` : v.name]) : [['', '']];
    for (const [vid, vname] of scopes) {
      const key = `${r.id}|${vid}`; let v = null;
      try { v = vid.startsWith('c:') ? m.fn(require('./widgets').customerView(S, vid.slice(2)), vid) : m.fn(S, vid); } catch { v = null; }
      if (v == null || !Number.isFinite(v)) continue;             // no data for this metric → neither fires nor resolves
      seen.add(key);
      const hit = OPS[r.op](v, r.threshold); let st = state.get(key);
      if (hit) {
        if (!st) { st = { condSince: now, firedAt: null, lastNotified: 0, ackUntil: 0 }; state.set(key, st); }
        st.value = v; st.venueName = vname;
        if (!st.firedAt && now - st.condSince >= r.forSeconds * 1000) { st.firedAt = now; events.push({ type: 'fired', key, rule: r, alert: describe(key, r, st) }); st.lastNotified = now; }
        else if (st.firedAt && r.repeatMinutes && now - st.lastNotified >= r.repeatMinutes * 60000 && st.ackUntil < now) { st.lastNotified = now; events.push({ type: 'reminder', key, rule: r, alert: describe(key, r, st) }); }
      } else if (st) {
        if (st.firedAt) events.push({ type: 'resolved', key, rule: r, alert: describe(key, r, { ...st, value: v }) });
        state.delete(key);
      }
    }
  }
  for (const [key, st] of state) {   // rule deleted/disabled/venue gone while active
    if (!seen.has(key) && !rules.some((r) => r.enabled && key.startsWith(r.id + '|'))) { if (st.firedAt) { const r = rules.find((x) => key.startsWith(x.id + '|')); if (r) events.push({ type: 'resolved', key, rule: r, alert: describe(key, r, st) }); } state.delete(key); }
  }
  return events;
}
function describe(key, r, st) {
  const m = METRICS[r.metric];
  return { key, ruleId: r.id, name: r.name, severity: r.severity, takeover: r.takeover, venue: st.venueName || '', metric: m.label, value: Math.round(st.value * 10) / 10, unit: m.unit, op: r.op, threshold: r.threshold, since: st.firedAt || st.condSince,
    message: `${r.name}${st.venueName ? ` — ${st.venueName}` : ''}: ${m.label} is ${fmtVal(st.value, m)} (${r.op} ${r.threshold}${m.unit})` };
}
function active(now = Date.now()) {
  const out = [];
  for (const [key, st] of state) { if (!st.firedAt) continue; const r = rules.find((x) => key.startsWith(x.id + '|')); if (!r) continue; out.push({ ...describe(key, r, st), acked: st.ackUntil > now, ackUntil: st.ackUntil > now ? st.ackUntil : 0 }); }
  return out.sort((a, b) => (a.severity === b.severity ? a.since - b.since : a.severity === 'crit' ? -1 : 1));
}
function ack(key, minutes) { const st = state.get(key); if (!st) return false; st.ackUntil = minutes > 0 ? Date.now() + minutes * 60000 : 0; return true; }

const needs = () => new Set(rules.filter((r) => r.enabled).flatMap((r) => METRICS[r.metric].needs || []));
const catalog = () => Object.entries(METRICS).map(([id, m]) => ({ id, label: m.label, unit: m.unit, perVenue: Boolean(m.perVenue) }));
module.exports = { get: () => rules, save, evaluate, active, ack, needs, catalog, METRICS };
