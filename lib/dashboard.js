'use strict';
// Dashboard layout store: data/dashboard.json — screens → widgets. Validated on save.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');
const widgets = require('./widgets');
const { ALIASES } = require('./widgetgen');

const FILE = path.join(DATA_DIR, 'dashboard.json');
const w = (type, o = {}) => ({ type, ...o });

// Defaults mirror RUCKUS One's own Dashboard, Wireless/WLAN reports and Wired report (tiles use R1's names).
// Connection Success and Time To Connect come from R1's own analytics service (experimental, see lib/analytics.js).
// AP Capacity and airtime are not reachable with an API key and are left out.
const R1_SCREENS = [
    { name: 'Dashboard', widgets: [
      w('r1.alarms', { w: 3, h: 4 }), w('r1.client_experience', { w: 3, h: 4 }), w('r1.venues', { w: 3, h: 4 }), w('r1.devices', { w: 3, h: 4 }),
      w('r1.clients', { w: 3, h: 4 }), w('r1.insights', { w: 3, h: 4 }), w('table.venues', { w: 6, h: 4, title: 'Venues' }),
      w('trend.clients', { w: 4, h: 4, title: 'Connected Clients Over Time' }),
      w('g.clients.ssid.mbps.donut', { w: 4, h: 4, title: 'Top 5 SSIDs by Traffic', params: { n: 5 } }),
      w('donut.clients_ssid', { w: 4, h: 4, title: 'Top 5 SSIDs by Clients', params: { n: 5 } })
    ] },
    { name: 'Wi-Fi', widgets: [
      w('kpi.clients', { w: 3, h: 2 }), w('kpi.aps', { w: 3, h: 2 }), w('g.kpi.throughput.now', { w: 3, h: 2 }), w('g.kpi.throughput.traffic24', { w: 3, h: 2 }),
      w('g.clients.ap.mbps.donut', { w: 3, h: 4, title: 'Top APs by Traffic', params: { n: 10 } }), w('g.clients.ap.count.donut', { w: 3, h: 4, title: 'Top APs by Client Count', params: { n: 10 } }),
      w('g.clients.ssid.mbps.donut', { w: 3, h: 4, title: 'Top SSIDs by Traffic' }), w('donut.clients_ssid', { w: 3, h: 4, title: 'Top SSIDs by Client Count' }),
      w('r1.traffic_trend', { w: 6, h: 4 }), w('g.trend.clients.ssid', { w: 6, h: 4, title: 'Active SSIDs Trend' }),
      w('g.clients.ap.table', { w: 6, h: 4, title: 'Top APs' }), w('g.clients.ssid.table', { w: 6, h: 4, title: 'Top SSIDs' })
    ] },
    { name: 'Switch', widgets: [
      w('kpi.switches', { w: 3, h: 2 }), w('kpi.ports_up', { w: 3, h: 2 }), w('kpi.poe_draw', { w: 3, h: 2 }), w('g.kpi.ports.thr', { w: 3, h: 2 }),
      w('g.ports.switch.portMbps.donut', { w: 3, h: 4, title: 'Top Switches by Traffic', params: { n: 10 } }), w('g.ports.switch.portPoe.donut', { w: 3, h: 4, title: 'Top Switches by PoE Usage', params: { n: 10 } }),
      w('g.ports.switch.errors.donut', { w: 3, h: 4, title: 'Top Switches by Errors', params: { n: 10 } }), w('g.ports.modelSpeed.portMbps.bar', { w: 3, h: 4, title: 'Traffic by Switch Model and Port Speed' }),
      w('g.trend.sw_thr_mbps', { w: 6, h: 4, title: 'Traffic Trend' }), w('g.trend.sw_errors', { w: 6, h: 4, title: 'Error Trend' }),
      w('r1.wired_overview', { w: 4, h: 4, title: 'Overview' }), w('g.ports.switch.table', { w: 8, h: 4, title: 'Top Switches by Traffic' })
    ] }
];

const DEFAULT = { version: 1, title: 'RUCKUS One NOC', rotateSeconds: 20, screens: R1_SCREENS };

// Optional ready-made screens, offered in the editor ("Add preset screen"). Not part of the defaults.
const PRESETS = [
  // Uses R1's own analytics service (experimental, undocumented; network-wide only).
  { name: 'Connection health (experimental)', widgets: [
    w('kpi.exp.conn_pct'), w('kpi.exp.attempts'), w('kpi.exp.failed'), w('kpi.exp.ttc'),
    w('kpi.exp.roaming'), w('kpi.exp.client_rss'), w('kpi.exp.ap_uptime'),
    w('exp.stages', { w: 6, h: 4 }), w('exp.failures_donut', { w: 3, h: 4 }), w('exp.rates_bar', { w: 3, h: 4 }),
    w('exp.venue_table'),
    w('exp.trend', { w: 6, h: 4 }), w('exp.attempts_trend', { w: 6, h: 4 }),
    w('exp.daily', { w: 6, h: 4 }), w('exp.clients', { w: 6, h: 4 })
  ] },
  // MSP mode (Settings → Customers). Every widget also has a Customer choice, and ?customer=<id> pins a whole wall to one customer.
  { name: 'MSP overview', widgets: [
    w('msp.kpi_customers'), w('msp.kpi_issues'), w('msp.kpi_critical'), w('kpi.clients'),
    w('msp.customers', { w: 12, h: 5 }),
    w('msp.alarms_list', { w: 6, h: 5 }), w('msp.clients', { w: 3, h: 5 }), w('msp.aps_offline', { w: 3, h: 5 }),
    w('msp.conn_bar', { w: 4, h: 4 }), w('msp.aps_donut', { w: 4, h: 4 }), w('msp.alarms', { w: 4, h: 4 })
  ] },
  { name: 'Incidents (experimental)', widgets: [
    w('kpi.exp.inc_open'), w('kpi.exp.inc_high'), w('kpi.exp.inc_7d'), w('kpi.exp.inc_airtime'),
    w('exp.incidents'), w('exp.inc_category', { w: 4, h: 4 }), w('exp.inc_severity', { w: 4, h: 4 }), w('exp.inc_types', { w: 4, h: 4 })
  ] },
  { name: 'Top talkers and failures (experimental)', widgets: [
    w('exp.top_apps', { w: 4, h: 4 }), w('exp.top_categories', { w: 4, h: 4 }), w('exp.top_ssids', { w: 4, h: 4 }),
    w('exp.top_aps', { w: 4, h: 4 }), w('exp.top_clients', { w: 4, h: 4 }), w('exp.top_apps_clients', { w: 4, h: 4 }),
    w('exp.fail_table'),
    w('exp.fail_ssid', { w: 4, h: 4 }), w('exp.fail_ap', { w: 4, h: 4 }), w('exp.fail_maker', { w: 4, h: 4 })
  ] },
  // Airtime utilization itself is Data Studio-only (tested: API-key tokens are rejected). These are the closest things the API can show.
  { name: 'AP load (airtime stand-in)', widgets: [
    w('g.kpi.load.maxRadio'), w('g.kpi.load.over20'), w('g.kpi.load.dense'), w('g.kpi.throughput.now'),
    w('a.load.radios', { w: 12, h: 5 }),
    w('a.load.channels', { w: 6, h: 4 }), w('g.radios.bandChannel.count.bar', { w: 6, h: 4, title: 'Radios per channel' }),
    w('a.load.aps', { w: 6, h: 4 }), w('g.clients.ap.mbps.bar', { w: 6, h: 4, title: 'Top APs by throughput' })
  ] },
  ...R1_SCREENS.map((s) => ({ ...s, name: `RUCKUS One ${s.name}` })),   // add R1's look-alike screens to an existing layout
  { name: 'Overview (classic)', widgets: [
    w('kpi.clients'), w('kpi.aps'), w('kpi.switches'), w('kpi.alarms'),
    w('trend.clients'), w('donut.ap_status'), w('donut.clients_ssid'),
    w('table.venues'), w('list.alarms', { w: 4 })
  ] },
  { name: 'Clients', widgets: [
    w('kpi.clients', { w: 4 }), w('bar.venue_clients', { w: 4 }), w('donut.clients_band', { w: 4 }),
    w('trend.clients', { w: 8 }), w('donut.clients_os', { w: 4 }), w('bar.top_aps', { w: 6 }), w('donut.clients_ssid', { w: 6 })
  ] },
  { name: 'Infrastructure', widgets: [
    w('kpi.aps'), w('kpi.switches'), w('kpi.offline'), w('kpi.poe'),
    w('donut.ap_models'), w('donut.sw_models'), w('donut.ap_fw'), w('donut.sw_fw'),
    w('list.offline'), w('bar.top_poe')
  ] },
  { name: 'Switching', widgets: [
    w('kpi.switches'), w('kpi.ports_up'), w('kpi.poe_draw'), w('kpi.offline'),
    w('donut.port_status', { w: 4 }), w('bar.port_util'), w('bar.switch_cpu'),
    w('list.port_errors'), w('list.port_alerts')
  ] },
  { name: 'Wi-Fi Calling', widgets: [
    w('kpi.wfc_clients'), w('kpi.wfc_traffic'), w('donut.wfc_carriers'), w('donut.clients_vendor'),
    w('trend.wfc'), w('bar.wfc_ssids'), w('list.wfc_clients'), w('table.wfc_profiles', { w: 6 })
  ] },
  { name: 'Wireless performance', widgets: [
    w('g.gauge.rssi_24'), w('g.gauge.rssi_5'), w('g.gauge.rssi_6'), w('g.gauge.snr_all'),
    w('a.rf.quality', { w: 12, h: 5 }),
    w('g.clients.venueGroupChannel.table', { w: 6, h: 4 }), w('g.radios.venueGroupChannel.table', { w: 6, h: 4 }),
    w('g.trend.clients.band', { w: 6, h: 4 }), w('g.cmp.clients_5.lastweek', { w: 6, h: 4 })
  ] },
  { name: 'Student experience', widgets: [
    w('g.gauge.snr_24'), w('g.gauge.snr_5'), w('g.gauge.snr_6'), w('g.gauge.rssi_all'),
    w('g.clients.vendor.count.bar', { w: 4, h: 4, params: { n: 10, hideUnknown: 1 } }), w('g.clients.os.count.bar', { w: 4, h: 4, params: { hideUnknown: 1 } }), w('g.clients.band.count.bar', { w: 4, h: 4 }),
    w('g.clients.venueGroupBand.table', { w: 12, h: 5 })
  ] },
  { name: 'RF coverage', widgets: [
    w('a.rf.coverage', { w: 6, h: 3, match: 'public' }), w('a.rf.coverage', { w: 6, h: 3, match: 'guest' }),
    w('a.rf.coverage', { w: 6, h: 3, match: 'staff' }), w('a.rf.coverage', { w: 6, h: 3, match: 'conference' })
  ] },
  { name: 'Throughput', widgets: [
    w('g.kpi.throughput.now'), w('g.kpi.throughput.down'), w('g.kpi.throughput.up'), w('g.kpi.throughput.traffic24'),
    w('g.trend.thr_mbps', { w: 6, h: 4 }), w('g.cmp.thr_mbps.yesterday', { w: 6, h: 4 }),
    w('g.clients.venue.mbps.bar', { w: 4, h: 4 }), w('g.clients.band.mbps.donut', { w: 4, h: 4 }), w('g.clients.ssid.mbps.bar', { w: 4, h: 4 })
  ] },
  { name: 'Client mix', widgets: [
    w('donut.clients_vendor'), w('bar.clients_models'), w('donut.clients_devtype'), w('donut.clients_os'),
    w('donut.clients_ssid'), w('donut.client_signal'), w('bar.channels'), w('bar.top_clients')
  ] }
];

const clamp = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
const str = (s, max = 80) => String(s == null ? '' : s).slice(0, max);

const OPS = new Set(['>=', '<=', '>', '<']);
const cleanThreshold = (t) => (t && OPS.has(t.op) && Number.isFinite(Number(t.val)) && t.val !== '' ? { op: t.op, val: Number(t.val) } : null);
const hhmm = (v, d) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v).padStart(5, '0') : d);

// A "view" is a named set of screens (Main is the top-level `screens`). Widget ids are unique across all views.
function validateScreens(screens, cat, seq) {
  if (!Array.isArray(screens) || !screens.length) throw new Error('Each view needs at least one screen');
  const out = [];
  for (const s of screens.slice(0, 20)) {
    let nm = str(s.name, 40) || `Screen ${out.length + 1}`; while (out.some((x) => x.name === nm)) nm += ' 2';   // playlists refer to screens by name, so names must be unique within a view
    const screen = { name: nm, auto: s.auto !== false, displays: clamp(s.displays, 1, 6, 1), split: s.split === 'manual' ? 'manual' : 'auto', widgets: [] };
    for (const raw of (s.widgets || []).slice(0, 40)) {
      const x = { ...raw, type: ALIASES[raw.type] || raw.type };   // retired generated twin → its hand-built equivalent
      const def = cat.get(x.type);
      if (!def) throw new Error(`Unknown widget type: ${x.type}`);
      const params = {};
      for (const p of def.params) if (x.params && x.params[p.name] != null && x.params[p.name] !== '') params[p.name] = Number(x.params[p.name]) || p.default;
      const wd = { id: `w${++seq.n}`, type: x.type, venue: str(x.venue, 64), w: clamp(x.w, 1, 12, def.w), h: clamp(x.h, 1, 10, def.h), display: clamp(x.display, 1, screen.displays, 1), params };
      const th = x.thresholds && { warn: cleanThreshold(x.thresholds.warn), crit: cleanThreshold(x.thresholds.crit) };
      const gx = Number(x.x), gy = Number(x.y);   // free-placement position (cells); only used when the screen's Auto-fit is off
      if (x.x != null && x.y != null && x.x !== '' && x.y !== '' && Number.isFinite(gx) && Number.isFinite(gy)) { wd.x = Math.max(0, Math.min(12 - wd.w, Math.round(gx))); wd.y = Math.max(0, Math.min(200, Math.round(gy))); }
      if (x.customer) wd.customer = str(x.customer, 64);   // MSP mode: show only this customer's data
      if (x.title) wd.title = str(x.title, 80).trim();   // optional card title (e.g. R1's own tile names)
      if (def.match && x.match) wd.match = str(x.match, 40).trim();   // AP-group name filter (clients / APs / radios / RF widgets)
      if (th && (th.warn || th.crit)) wd.thresholds = th;   // colours a scorecard amber/red by its value
      screen.widgets.push(wd);
    }
    out.push(screen);
  }
  return out;
}

// A playlist is the ordered list of screen names one display rotates through (index 0 = display 1). An empty list means
// "that display shows every screen" — so a view only changes behaviour for displays you actually give a playlist.
function cleanPlaylists(input, screens) {
  const names = new Set(screens.map((x) => x.name)); const out = [];
  for (const list of (Array.isArray(input) ? input : []).slice(0, 6)) { const seen = new Set(); out.push((Array.isArray(list) ? list : []).filter((n) => names.has(n) && !seen.has(n) && seen.add(n))); }
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}

// Returns a sanitised copy or throws with a human message.
function validate(input) {
  if (!input || !Array.isArray(input.screens) || !input.screens.length) throw new Error('At least one screen is required');
  const cat = new Map(widgets.catalog().map((c) => [c.type, c]));
  const seq = { n: 0 };
  const out = { version: 2, title: str(input.title, 60) || 'NOC', rotateSeconds: clamp(input.rotateSeconds, 0, 3600, 20), screens: validateScreens(input.screens, cat, seq), playlists: [], views: [], schedules: [] };
  out.playlists = cleanPlaylists(input.playlists, out.screens);
  const names = new Set(['Main']);
  for (const v of (input.views || []).slice(0, 12)) {
    let name = str(v.name, 40) || `View ${out.views.length + 1}`; while (names.has(name)) name += ' 2';
    names.add(name);
    const vs = validateScreens(v.screens, cat, seq);
    out.views.push({ name, rotateSeconds: clamp(v.rotateSeconds, 0, 3600, out.rotateSeconds), screens: vs, playlists: cleanPlaylists(v.playlists, vs) });
  }
  for (const sc of (input.schedules || []).slice(0, 20)) {
    if (!names.has(sc.view)) continue;   // schedule pointing at a deleted view
    const days = [...new Set((Array.isArray(sc.days) ? sc.days : [0, 1, 2, 3, 4, 5, 6]).map(Number).filter((d) => d >= 0 && d <= 6))];
    out.schedules.push({ view: sc.view, days, from: hhmm(sc.from, '00:00'), to: hhmm(sc.to, '00:00'), enabled: sc.enabled !== false });
  }
  return out;
}

// ---- views & schedules ----
const allScreens = (layout) => [layout.screens, ...(layout.views || []).map((v) => v.screens)].flat();
const allWidgets = (layout) => allScreens(layout).flatMap((s) => s.widgets);
function viewByName(layout, name) {
  const v = (layout.views || []).find((x) => x.name === name);
  return v ? { name: v.name, rotateSeconds: v.rotateSeconds, screens: v.screens, playlists: v.playlists || [] } : { name: 'Main', rotateSeconds: layout.rotateSeconds, screens: layout.screens, playlists: layout.playlists || [] };
}
// First enabled schedule that matches `date` (server local time). Overnight windows (from > to) belong to the day they start on.
function scheduledView(layout, date = new Date()) {
  const mins = date.getHours() * 60 + date.getMinutes(); const day = date.getDay(); const prev = (day + 6) % 7;
  const m = (t) => { const [h, mm] = t.split(':').map(Number); return h * 60 + mm; };
  for (const sc of layout.schedules || []) {
    if (!sc.enabled) continue;
    const f = m(sc.from), t = m(sc.to);
    const hit = f === t ? sc.days.includes(day)
      : f < t ? sc.days.includes(day) && mins >= f && mins < t
      : (sc.days.includes(day) && mins >= f) || (sc.days.includes(prev) && mins < t);
    if (hit) return sc.view;
  }
  return 'Main';
}

function load() {
  try { return validate(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { return validate(DEFAULT); }
}
function save(cfg) {
  const clean = validate(cfg);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(clean, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  return clean;
}
// How many displays a view needs: the most any screen is spread across, or the most playlists defined.
const displaysNeeded = (layout) => Math.max(1, ...[layout, ...(layout.views || [])].flatMap((v) => [(v.playlists || []).length, ...v.screens.map((x) => x.displays || 1)]));
module.exports = { displaysNeeded, load, save, validate, DEFAULT, PRESETS, allScreens, allWidgets, viewByName, scheduledView };
