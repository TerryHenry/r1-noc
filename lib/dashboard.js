'use strict';
// Dashboard layout store: data/dashboard.json — screens → widgets. Validated on save.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');
const widgets = require('./widgets');
const { ALIASES } = require('./widgetgen');

const FILE = path.join(DATA_DIR, 'dashboard.json');
const w = (type, o = {}) => ({ type, ...o });

const DEFAULT = {
  version: 1,
  title: 'RUCKUS One NOC',
  rotateSeconds: 20,
  screens: [
    { name: 'Overview', widgets: [
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
    ] }
  ]
};

// Optional ready-made screens, offered in the editor ("Add preset screen"). Not part of the defaults.
const PRESETS = [
  { name: 'Switching', widgets: [
    w('kpi.switches'), w('kpi.ports_up'), w('kpi.poe_draw'), w('kpi.offline'),
    w('donut.port_status', { w: 4 }), w('bar.port_util'), w('bar.switch_cpu'),
    w('list.port_errors'), w('list.port_alerts')
  ] },
  { name: 'Wi-Fi Calling', widgets: [
    w('kpi.wfc_clients'), w('kpi.wfc_traffic'), w('donut.wfc_carriers'), w('donut.clients_vendor'),
    w('trend.wfc'), w('bar.wfc_ssids'), w('list.wfc_clients'), w('table.wfc_profiles', { w: 6 })
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
    const screen = { name: str(s.name, 40) || `Screen ${out.length + 1}`, auto: s.auto !== false, displays: clamp(s.displays, 1, 6, 1), split: s.split === 'manual' ? 'manual' : 'auto', widgets: [] };
    for (const raw of (s.widgets || []).slice(0, 40)) {
      const x = { ...raw, type: ALIASES[raw.type] || raw.type };   // retired generated twin → its hand-built equivalent
      const def = cat.get(x.type);
      if (!def) throw new Error(`Unknown widget type: ${x.type}`);
      const params = {};
      for (const p of def.params) if (x.params && x.params[p.name] != null && x.params[p.name] !== '') params[p.name] = Number(x.params[p.name]) || p.default;
      const wd = { id: `w${++seq.n}`, type: x.type, venue: str(x.venue, 64), w: clamp(x.w, 1, 12, def.w), h: clamp(x.h, 1, 10, def.h), display: clamp(x.display, 1, screen.displays, 1), params };
      const th = x.thresholds && { warn: cleanThreshold(x.thresholds.warn), crit: cleanThreshold(x.thresholds.crit) };
      if (th && (th.warn || th.crit)) wd.thresholds = th;   // colours a scorecard amber/red by its value
      screen.widgets.push(wd);
    }
    out.push(screen);
  }
  return out;
}

// Returns a sanitised copy or throws with a human message.
function validate(input) {
  if (!input || !Array.isArray(input.screens) || !input.screens.length) throw new Error('At least one screen is required');
  const cat = new Map(widgets.catalog().map((c) => [c.type, c]));
  const seq = { n: 0 };
  const out = { version: 2, title: str(input.title, 60) || 'NOC', rotateSeconds: clamp(input.rotateSeconds, 0, 3600, 20), screens: validateScreens(input.screens, cat, seq), views: [], schedules: [] };
  const names = new Set(['Main']);
  for (const v of (input.views || []).slice(0, 12)) {
    let name = str(v.name, 40) || `View ${out.views.length + 1}`; while (names.has(name)) name += ' 2';
    names.add(name);
    out.views.push({ name, rotateSeconds: clamp(v.rotateSeconds, 0, 3600, out.rotateSeconds), screens: validateScreens(v.screens, cat, seq) });
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
  return v ? { name: v.name, rotateSeconds: v.rotateSeconds, screens: v.screens } : { name: 'Main', rotateSeconds: layout.rotateSeconds, screens: layout.screens };
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
module.exports = { load, save, validate, DEFAULT, PRESETS, allScreens, allWidgets, viewByName, scheduledView };
