'use strict';
// Widget catalog. Each widget computes a small, render-agnostic payload from the
// latest snapshot (+ history). The browser only knows the payload `kind`:
//   kpi | donut | line | bar | list | table
// To add a report: append an entry here — it appears in the /admin picker automatically.
const history = require('./history');

const UP = (d) => d.status === 'Operational' || d.status === 'Degraded';
const SEV_ORDER = { Critical: 0, Major: 1, Minor: 2, Warning: 3, Info: 4 };
const STATUS_COLOR = { Operational: 'ok', Degraded: 'warn', Initializing: 'info', Disconnected: 'bad', Unknown: 'muted' };

const inVenue = (rows, v) => (v ? rows.filter((r) => r.venueId === v) : rows);
const tally = (rows, f) => { const m = new Map(); for (const r of rows) { const k = f(r) || 'Unknown'; m.set(k, (m.get(k) || 0) + 1); } return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value); };
const topN = (items, n, otherLabel = 'Other') => { if (items.length <= n) return items; const head = items.slice(0, n); const rest = items.slice(n).reduce((s, i) => s + i.value, 0); return [...head, { label: otherLabel, value: rest }]; };
const venueTitle = (S, v, base) => (v ? `${base} — ${(S.venues.find((x) => x.id === v) || {}).name || v}` : base);
const bytesFmt = (b) => { if (!b) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; } return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`; };
const dur = (sec) => { if (sec == null) return ''; const d = Math.floor(sec / 86400); return d >= 1 ? `${d}d` : sec >= 3600 ? `${Math.floor(sec / 3600)}h` : `${Math.max(1, Math.floor(sec / 60))}m`; };
const nf = (n) => new Intl.NumberFormat().format(n);
const nonZeroFmt = (n) => nf(n);
const nonEmpty = (n, d) => Math.max(1, Math.min(50, Number(n) || d));

const fmtAgo = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); if (s < 90) return `${Math.round(s)}s`; if (s < 5400) return `${Math.round(s / 60)}m`; if (s < 129600) return `${Math.round(s / 3600)}h`; return `${Math.round(s / 86400)}d`; };

function statusDonut(S, v, rows, title) {
  const t = tally(inVenue(rows, v), (d) => d.status);
  return { kind: 'donut', title: venueTitle(S, v, title), items: t.map((i) => ({ ...i, tone: STATUS_COLOR[i.label] })), centerLabel: 'devices', center: t.reduce((s, i) => s + i.value, 0) };
}

function trend(S, v, metric, title, hours, unit = '') {
  const key = `${metric}@${v || '*'}`;
  return { kind: 'line', title: venueTitle(S, v, title), hours, unit, points: history.series(key, hours) };
}

const W = [
  // ---------- headline tiles ----------
  { type: 'kpi.clients', title: 'Connected clients', group: 'Headline numbers', w: 3, h: 2, compute: (S, v) => {
      const n = S.clients.length ? inVenue(S.clients, v).length : inVenue(S.aps, v).reduce((s, a) => s + a.clients, 0);
      const prev = history.series(`clients@${v || '*'}`, 24, 400); const old = prev.length > 12 ? prev[Math.max(0, prev.length - 13)][1] : null;
      return { kind: 'kpi', title: venueTitle(S, v, 'Connected clients'), value: n, delta: old != null ? n - Math.round(old) : null, deltaLabel: 'vs 1h ago' };
  } },
  { type: 'kpi.aps', title: 'APs online', group: 'Headline numbers', w: 3, h: 2, compute: (S, v) => {
      const a = inVenue(S.aps, v); const up = a.filter(UP).length;
      return { kind: 'kpi', title: venueTitle(S, v, 'APs online'), value: up, suffix: `/ ${a.length}`, tone: a.length && up < a.length ? (up / a.length < 0.9 ? 'bad' : 'warn') : 'ok' };
  } },
  { type: 'kpi.switches', title: 'Switches online', group: 'Headline numbers', w: 3, h: 2, compute: (S, v) => {
      const a = inVenue(S.switches, v); const up = a.filter(UP).length;
      return { kind: 'kpi', title: venueTitle(S, v, 'Switches online'), value: up, suffix: `/ ${a.length}`, tone: a.length && up < a.length ? 'bad' : 'ok' };
  } },
  { type: 'kpi.alarms', title: 'Active alarms', group: 'Headline numbers', w: 3, h: 2, compute: (S, v) => {
      const a = inVenue(S.alarms, v); const crit = a.filter((x) => x.severity === 'Critical').length; const maj = a.filter((x) => x.severity === 'Major').length;
      return { kind: 'kpi', title: venueTitle(S, v, 'Active alarms'), value: a.length, suffix: crit || maj ? `${crit} crit · ${maj} major` : '', tone: crit ? 'bad' : maj ? 'warn' : 'ok' };
  } },
  { type: 'kpi.offline', title: 'Devices offline', group: 'Headline numbers', w: 3, h: 2, compute: (S, v) => {
      const a = [...inVenue(S.aps, v), ...inVenue(S.switches, v)].filter((d) => d.status === 'Disconnected');
      return { kind: 'kpi', title: venueTitle(S, v, 'Devices offline'), value: a.length, tone: a.length ? 'bad' : 'ok' };
  } },
  { type: 'kpi.ports', title: 'Switch ports', group: 'Headline numbers', w: 3, h: 2, compute: (S, v) => {
      const a = inVenue(S.switches, v);
      return { kind: 'kpi', title: venueTitle(S, v, 'Switch ports'), value: a.reduce((s, x) => s + x.ports, 0), suffix: `${a.length} switches` };
  } },
  { type: 'kpi.poe', title: 'Avg PoE utilization', group: 'Headline numbers', w: 3, h: 2, compute: (S, v) => {
      const a = inVenue(S.switches, v).filter((x) => x.poeUtil != null);
      const avg = a.length ? a.reduce((s, x) => s + x.poeUtil, 0) / a.length : null; const max = a.reduce((m, x) => Math.max(m, x.poeUtil), 0);
      return { kind: 'kpi', title: venueTitle(S, v, 'Avg PoE utilization'), value: avg == null ? '—' : Math.round(avg), suffix: avg == null ? '' : `% · peak ${Math.round(max)}%`, tone: max > 85 ? 'warn' : 'ok' };
  } },

  // ---------- trends ----------
  { type: 'trend.clients', title: 'Clients over time', group: 'Trends', w: 6, h: 4, params: [{ name: 'hours', label: 'Hours', default: 24 }], compute: (S, v, p) => trend(S, v, 'clients', 'Clients over time', Number(p.hours) || 24) },
  { type: 'trend.aps', title: 'APs online over time', group: 'Trends', w: 6, h: 4, params: [{ name: 'hours', label: 'Hours', default: 24 }], compute: (S, v, p) => trend(S, v, 'aps_online', 'APs online over time', Number(p.hours) || 24) },
  { type: 'trend.alarms', title: 'Active alarms over time', group: 'Trends', w: 6, h: 4, params: [{ name: 'hours', label: 'Hours', default: 24 }], compute: (S, v, p) => trend(S, v, 'alarms', 'Active alarms over time', Number(p.hours) || 24) },

  // ---------- breakdowns ----------
  { type: 'donut.ap_status', title: 'AP status', group: 'Breakdowns', w: 3, h: 4, compute: (S, v) => statusDonut(S, v, S.aps, 'AP status') },
  { type: 'donut.sw_status', title: 'Switch status', group: 'Breakdowns', w: 3, h: 4, compute: (S, v) => statusDonut(S, v, S.switches, 'Switch status') },
  { type: 'donut.clients_ssid', title: 'Clients by SSID', group: 'Breakdowns', w: 3, h: 4, params: [{ name: 'n', label: 'Show top', default: 6 }], compute: (S, v, p) => ({ kind: 'donut', title: venueTitle(S, v, 'Clients by SSID'), items: topN(tally(inVenue(S.clients, v), (c) => c.ssid), nonEmpty(p.n, 6)), centerLabel: 'clients', center: inVenue(S.clients, v).length }) },
  { type: 'donut.clients_os', title: 'Clients by OS', group: 'Breakdowns', w: 3, h: 4, params: [{ name: 'n', label: 'Show top', default: 6 }], compute: (S, v, p) => ({ kind: 'donut', title: venueTitle(S, v, 'Clients by OS'), items: topN(tally(inVenue(S.clients, v), (c) => c.os), nonEmpty(p.n, 6)), centerLabel: 'clients', center: inVenue(S.clients, v).length }) },
  { type: 'donut.clients_band', title: 'Clients by band', group: 'Breakdowns', w: 3, h: 4, compute: (S, v) => ({ kind: 'donut', title: venueTitle(S, v, 'Clients by band'), items: tally(inVenue(S.clients, v), (c) => c.band), centerLabel: 'clients', center: inVenue(S.clients, v).length }) },
  { type: 'donut.ap_models', title: 'AP models', group: 'Breakdowns', w: 3, h: 4, params: [{ name: 'n', label: 'Show top', default: 6 }], compute: (S, v, p) => ({ kind: 'donut', title: venueTitle(S, v, 'AP models'), items: topN(tally(inVenue(S.aps, v), (a) => a.model), nonEmpty(p.n, 6)), centerLabel: 'APs', center: inVenue(S.aps, v).length }) },
  { type: 'donut.sw_models', title: 'Switch models', group: 'Breakdowns', w: 3, h: 4, params: [{ name: 'n', label: 'Show top', default: 6 }], compute: (S, v, p) => ({ kind: 'donut', title: venueTitle(S, v, 'Switch models'), items: topN(tally(inVenue(S.switches, v), (a) => a.model), nonEmpty(p.n, 6)), centerLabel: 'switches', center: inVenue(S.switches, v).length }) },
  { type: 'donut.ap_fw', title: 'AP firmware versions', group: 'Breakdowns', w: 3, h: 4, compute: (S, v) => ({ kind: 'donut', title: venueTitle(S, v, 'AP firmware versions'), items: topN(tally(inVenue(S.aps, v), (a) => a.firmware), 6), centerLabel: 'APs', center: inVenue(S.aps, v).length }) },
  { type: 'donut.sw_fw', title: 'Switch firmware versions', group: 'Breakdowns', w: 3, h: 4, compute: (S, v) => ({ kind: 'donut', title: venueTitle(S, v, 'Switch firmware versions'), items: topN(tally(inVenue(S.switches, v), (a) => a.firmware), 6), centerLabel: 'switches', center: inVenue(S.switches, v).length }) },

  // ---------- rankings ----------
  { type: 'bar.venue_clients', title: 'Clients by venue', group: 'Rankings', w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 8 }], compute: (S, v, p) => {
      const useC = S.clients.length > 0;
      const items = S.venues.map((x) => ({ label: x.name, value: useC ? S.clients.filter((c) => c.venueId === x.id).length : S.aps.filter((a) => a.venueId === x.id).reduce((s, a) => s + a.clients, 0) })).sort((a, b) => b.value - a.value).slice(0, nonEmpty(p.n, 8));
      return { kind: 'bar', title: 'Clients by venue', items };
  } },
  { type: 'bar.top_aps', title: 'Busiest APs', group: 'Rankings', w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 10 }], compute: (S, v, p) => ({ kind: 'bar', title: venueTitle(S, v, 'Busiest APs'), items: inVenue(S.aps, v).slice().sort((a, b) => b.clients - a.clients).slice(0, nonEmpty(p.n, 10)).map((a) => ({ label: a.name, value: a.clients, sub: a.venue })) }) },
  { type: 'bar.top_poe', title: 'Highest PoE load', group: 'Rankings', w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 8 }], compute: (S, v, p) => ({ kind: 'bar', title: venueTitle(S, v, 'Highest PoE load'), unit: '%', max: 100, items: inVenue(S.switches, v).filter((s) => s.poeUtil != null).sort((a, b) => b.poeUtil - a.poeUtil).slice(0, nonEmpty(p.n, 8)).map((s) => ({ label: s.name, value: Math.round(s.poeUtil), sub: s.venue })) }) },

  // ---------- lists & tables ----------
  { type: 'list.alarms', title: 'Active alarms (list)', group: 'Lists & tables', w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 10 }], compute: (S, v, p) => ({
      kind: 'list', title: venueTitle(S, v, 'Active alarms'), empty: 'No active alarms',
      rows: inVenue(S.alarms, v).slice().sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.time - a.time).slice(0, nonEmpty(p.n, 10)).map((a) => ({ tone: { Critical: 'bad', Major: 'bad', Minor: 'warn', Warning: 'warn', Info: 'info' }[a.severity], badge: a.severity, primary: a.text, secondary: [a.venue, a.device].filter(Boolean).join(' · '), meta: a.time ? fmtAgo(a.time) : '' })) }) },
  { type: 'list.offline', title: 'Offline devices', group: 'Lists & tables', w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 10 }], compute: (S, v, p) => ({
      kind: 'list', title: venueTitle(S, v, 'Offline devices'), empty: 'Everything is online',
      rows: [...inVenue(S.switches, v).map((d) => ({ ...d, type: 'Switch' })), ...inVenue(S.aps, v).map((d) => ({ ...d, type: 'AP' }))].filter((d) => d.status === 'Disconnected' || d.status === 'Degraded').sort((a, b) => (a.status === 'Disconnected' ? 0 : 1) - (b.status === 'Disconnected' ? 0 : 1)).slice(0, nonEmpty(p.n, 10))
        .map((d) => ({ tone: d.status === 'Disconnected' ? 'bad' : 'warn', badge: d.status === 'Disconnected' ? 'Offline' : 'Degraded', primary: d.name, secondary: [d.type, d.model, d.venue].filter(Boolean).join(' · '), meta: d.ip })) }) },
  { type: 'table.venues', title: 'Venue health', group: 'Lists & tables', w: 8, h: 5, compute: (S) => ({
      kind: 'table', title: 'Venue health', columns: ['Venue', 'Clients', 'APs', 'Switches', 'Alarms'],
      rows: S.venues.map((x) => {
        const aps = S.aps.filter((a) => a.venueId === x.id); const sws = S.switches.filter((a) => a.venueId === x.id); const al = S.alarms.filter((a) => a.venueId === x.id);
        const apUp = aps.filter(UP).length; const swUp = sws.filter(UP).length;
        const clients = S.clients.length ? S.clients.filter((c) => c.venueId === x.id).length : aps.reduce((s, a) => s + a.clients, 0);
        const crit = al.some((a) => a.severity === 'Critical');
        return { tone: crit || apUp < aps.length || swUp < sws.length ? (crit || swUp < sws.length ? 'bad' : 'warn') : 'ok', cells: [x.name, clients, `${apUp}/${aps.length}`, `${swUp}/${sws.length}`, al.length] };
      }).sort((a, b) => ({ bad: 0, warn: 1, ok: 2 }[a.tone] - { bad: 0, warn: 1, ok: 2 }[b.tone]) || String(a.cells[0]).localeCompare(b.cells[0])) }) },
  { type: 'table.switches', title: 'Switch inventory', group: 'Lists & tables', w: 8, h: 5, params: [{ name: 'n', label: 'Rows', default: 12 }], compute: (S, v, p) => ({
      kind: 'table', title: venueTitle(S, v, 'Switch inventory'), columns: ['Switch', 'Model', 'Firmware', 'Status', 'PoE'],
      rows: inVenue(S.switches, v).slice(0, nonEmpty(p.n, 12)).map((s) => ({ tone: { Operational: 'ok', Degraded: 'warn', Disconnected: 'bad' }[s.status] || 'muted', cells: [s.name, s.model, s.firmware, s.status, s.poeUtil != null ? `${Math.round(s.poeUtil)}%` : '—'] })) }) },


  // ---------- switching: ports (loaded only when one of these is on a screen) ----------
  { type: 'kpi.ports_up', title: 'Switch ports up', group: 'Switching', needs: ['ports'], w: 3, h: 2, compute: (S, v) => {
      const p = inVenue(S.ports, v); const up = p.filter((x) => x.state === 'Up').length;
      return { kind: 'kpi', title: venueTitle(S, v, 'Switch ports up'), value: p.length ? up : '—', suffix: p.length ? `/ ${nonZeroFmt(p.length)}` : 'loading…' };
  } },
  { type: 'donut.port_status', title: 'Port status', group: 'Switching', needs: ['ports'], w: 3, h: 4, compute: (S, v) => {
      const t = tally(inVenue(S.ports, v), (p) => p.state);
      return { kind: 'donut', title: venueTitle(S, v, 'Port status'), items: t.map((i) => ({ ...i, tone: { Up: 'ok', Down: 'muted', Disabled: 'info', Unknown: 'warn' }[i.label] })), centerLabel: 'ports', center: t.reduce((s2, i) => s2 + i.value, 0) };
  } },
  { type: 'donut.port_speed', title: 'Link speeds (ports up)', group: 'Switching', needs: ['ports'], w: 3, h: 4, compute: (S, v) => ({ kind: 'donut', title: venueTitle(S, v, 'Link speeds'), items: topN(tally(inVenue(S.ports, v).filter((p) => p.state === 'Up'), (p) => p.speed), 6), centerLabel: 'ports up', center: inVenue(S.ports, v).filter((p) => p.state === 'Up').length }) },
  { type: 'bar.port_util', title: 'Busiest ports (utilization)', group: 'Switching', needs: ['ports'], w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 8 }], compute: (S, v, p) => ({
      kind: 'bar', title: venueTitle(S, v, 'Busiest ports'), unit: '%', max: 100,
      items: inVenue(S.ports, v).filter((x) => x.state === 'Up').sort((a, b) => b.utilPct - a.utilPct).slice(0, nonEmpty(p.n, 8)).map((x) => ({ label: x.label, value: Math.round(x.utilPct * 10) / 10, sub: x.neighbor })) }) },
  { type: 'bar.port_poe', title: 'Top PoE-drawing ports', group: 'Switching', needs: ['ports'], w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 8 }], compute: (S, v, p) => ({
      kind: 'bar', title: venueTitle(S, v, 'Top PoE-drawing ports'), unit: ' W',
      items: inVenue(S.ports, v).filter((x) => x.poeUsedW > 0).sort((a, b) => b.poeUsedW - a.poeUsedW).slice(0, nonEmpty(p.n, 8)).map((x) => ({ label: x.label, value: Math.round(x.poeUsedW * 10) / 10, sub: x.neighbor })) }) },
  { type: 'list.port_errors', title: 'Ports with errors (list)', group: 'Switching', needs: ['ports'], w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 8 }], compute: (S, v, p) => ({
      kind: 'list', title: venueTitle(S, v, 'Ports with errors'), empty: 'No port errors',
      rows: inVenue(S.ports, v).filter((x) => x.errors > 0).sort((a, b) => b.crc - a.crc || b.errors - a.errors).slice(0, nonEmpty(p.n, 8)).map((x) => ({ tone: x.crc ? 'bad' : 'warn', badge: x.crc ? 'CRC' : 'Errors', primary: x.label, secondary: [x.neighbor, x.speed].filter(Boolean).join(' · '), meta: `${nf(x.errors)} err` })) }) },
  { type: 'list.port_alerts', title: 'Err-disabled / blocking ports', group: 'Switching', needs: ['ports'], w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 8 }], compute: (S, v, p) => ({
      kind: 'list', title: venueTitle(S, v, 'Err-disabled / blocking ports'), empty: 'No err-disabled or STP-blocking ports',
      rows: inVenue(S.ports, v).filter((x) => x.errDisabled || x.blocking).slice(0, nonEmpty(p.n, 8)).map((x) => ({ tone: x.errDisabled ? 'bad' : 'warn', badge: x.errDisabled ? 'Err-disabled' : 'STP block', primary: x.label, secondary: x.errDisabled || x.neighbor || '', meta: x.speed })) }) },

  // ---------- switching: switch-level ----------
  { type: 'kpi.poe_draw', title: 'PoE power drawn', group: 'Switching', w: 3, h: 2, compute: (S, v) => {
      const a = inVenue(S.switches, v).filter((x) => x.poeTotalW != null); const used = a.reduce((s2, x) => s2 + (x.poeUsedW || 0), 0); const total = a.reduce((s2, x) => s2 + x.poeTotalW, 0);
      return { kind: 'kpi', title: venueTitle(S, v, 'PoE power allocated'), value: total ? `${Math.round(used)}` : '—', suffix: total ? `W / ${Math.round(total)} W` : '', tone: total && used / total > 0.85 ? 'warn' : undefined };
  } },
  { type: 'bar.switch_cpu', title: 'Switch CPU load', group: 'Switching', w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 8 }], compute: (S, v, p) => ({
      kind: 'bar', title: venueTitle(S, v, 'Switch CPU load'), unit: '%', max: 100,
      items: inVenue(S.switches, v).filter((x) => x.cpu != null).sort((a, b) => b.cpu - a.cpu).slice(0, nonEmpty(p.n, 8)).map((x) => ({ label: x.name, value: Math.round(x.cpu), sub: x.venue })) }) },
  { type: 'bar.switch_mem', title: 'Switch memory use', group: 'Switching', w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 8 }], compute: (S, v, p) => ({
      kind: 'bar', title: venueTitle(S, v, 'Switch memory use'), unit: '%', max: 100,
      items: inVenue(S.switches, v).filter((x) => x.memory != null).sort((a, b) => b.memory - a.memory).slice(0, nonEmpty(p.n, 8)).map((x) => ({ label: x.name, value: Math.round(x.memory), sub: x.venue })) }) },
  { type: 'list.switch_alerts', title: 'Switches needing attention', group: 'Switching', w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 8 }], compute: (S, v, p) => ({
      kind: 'list', title: venueTitle(S, v, 'Switches needing attention'), empty: 'All switches healthy',
      rows: inVenue(S.switches, v).filter((x) => x.status !== 'Operational' || x.alerts > 0 || x.warning).sort((a, b) => (b.status !== 'Operational') - (a.status !== 'Operational') || b.alerts - a.alerts).slice(0, nonEmpty(p.n, 8))
        .map((x) => ({ tone: x.status === 'Disconnected' ? 'bad' : 'warn', badge: x.status !== 'Operational' ? x.status : x.alerts ? `${x.alerts} alert${x.alerts > 1 ? 's' : ''}` : 'Warning', primary: x.name, secondary: [x.model, x.venue].filter(Boolean).join(' · '), meta: x.ip })) }) },
  { type: 'list.switch_uptime', title: 'Recently rebooted switches', group: 'Switching', w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 8 }, { name: 'days', label: 'Within days', default: 7 }], compute: (S, v, p) => {
      const lim = (Number(p.days) || 7) * 86400;
      return { kind: 'list', title: venueTitle(S, v, 'Recently rebooted switches'), empty: `No reboots in the last ${Number(p.days) || 7} days`,
        rows: inVenue(S.switches, v).filter((x) => x.uptimeSec != null && x.uptimeSec < lim).sort((a, b) => a.uptimeSec - b.uptimeSec).slice(0, nonEmpty(p.n, 8)).map((x) => ({ tone: x.uptimeSec < 3600 ? 'bad' : 'warn', badge: 'Reboot', primary: x.name, secondary: [x.model, x.venue].filter(Boolean).join(' · '), meta: `up ${dur(x.uptimeSec)}` })) };
  } },

  // ---------- Wi-Fi calling ----------
  { type: 'kpi.wfc_clients', title: 'Wi-Fi calling clients', group: 'Wi-Fi calling', w: 3, h: 2, compute: (S, v) => {
      const c = inVenue(S.clients, v); const w = c.filter((x) => x.wfc); const active = w.filter((x) => x.wfcBytes > 0).length;
      const prev = history.series(`wfc_clients@${v || '*'}`, 24, 400); const old = prev.length > 12 ? prev[Math.max(0, prev.length - 13)][1] : null;
      return { kind: 'kpi', title: venueTitle(S, v, 'Wi-Fi calling clients'), value: w.length, suffix: `${active} with traffic`, delta: old != null ? w.length - Math.round(old) : null, deltaLabel: 'vs 1h ago' };
  } },
  { type: 'kpi.wfc_traffic', title: 'Wi-Fi calling traffic', group: 'Wi-Fi calling', w: 3, h: 2, compute: (S, v) => {
      const b = inVenue(S.clients, v).reduce((s2, x) => s2 + x.wfcBytes, 0);
      return { kind: 'kpi', title: venueTitle(S, v, 'Wi-Fi calling traffic (live sessions)'), value: bytesFmt(b) };
  } },
  { type: 'donut.wfc_carriers', title: 'Wi-Fi calling by carrier', group: 'Wi-Fi calling', w: 3, h: 4, compute: (S, v) => {
      const w = inVenue(S.clients, v).filter((x) => x.wfc); const t = tally(w, (x) => x.wfcCarrier || 'Unknown carrier');
      return { kind: 'donut', title: venueTitle(S, v, 'Wi-Fi calling by carrier'), items: topN(t, 6), centerLabel: 'clients', center: w.length };
  } },
  { type: 'bar.wfc_ssids', title: 'Wi-Fi calling by SSID', group: 'Wi-Fi calling', w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 8 }], compute: (S, v, p) => ({
      kind: 'bar', title: venueTitle(S, v, 'Wi-Fi calling by SSID'), items: tally(inVenue(S.clients, v).filter((x) => x.wfc), (x) => x.ssid).slice(0, nonEmpty(p.n, 8)) }) },
  { type: 'list.wfc_clients', title: 'Top Wi-Fi calling clients', group: 'Wi-Fi calling', w: 6, h: 5, params: [{ name: 'n', label: 'Rows', default: 8 }], compute: (S, v, p) => ({
      kind: 'list', title: venueTitle(S, v, 'Top Wi-Fi calling clients'), empty: 'No Wi-Fi calling sessions right now',
      rows: inVenue(S.clients, v).filter((x) => x.wfc).sort((a, b) => b.wfcBytes - a.wfcBytes).slice(0, nonEmpty(p.n, 8)).map((x) => ({ tone: 'info', badge: x.wfcCarrier || 'WFC', primary: x.name || x.model || 'Client', secondary: [x.model, x.ssid, x.ap].filter(Boolean).join(' · '), meta: bytesFmt(x.wfcBytes) })) }) },
  { type: 'trend.wfc', title: 'Wi-Fi calling clients over time', group: 'Wi-Fi calling', w: 6, h: 4, params: [{ name: 'hours', label: 'Hours', default: 24 }], compute: (S, v, p) => trend(S, v, 'wfc_clients', 'Wi-Fi calling clients over time', Number(p.hours) || 24) },
  { type: 'table.wfc_profiles', title: 'Wi-Fi calling profiles', group: 'Wi-Fi calling', needs: ['wfcProfiles'], w: 8, h: 4, compute: (S) => ({
      kind: 'table', title: 'Wi-Fi calling profiles (configuration)', columns: ['Profile', 'ePDGs', 'QoS', 'Networks'],
      rows: S.wfcProfiles.map((x) => ({ tone: 'ok', cells: [x.name, x.epdgs.join(', ') || '—', x.qos || '—', x.networks] })) }) },

  // ---------- Wi-Fi health ----------
  { type: 'donut.ap_health', title: 'AP health', group: 'Wi-Fi health', w: 3, h: 4, compute: (S, v) => {
      const t = tally(inVenue(S.aps, v), (a) => a.health);
      return { kind: 'donut', title: venueTitle(S, v, 'AP health'), items: t.map((i) => ({ ...i, tone: { EXCELLENT: 'ok', AVERAGE: 'warn', POOR: 'bad', UNKNOWN: 'muted' }[i.label] })), centerLabel: 'APs', center: inVenue(S.aps, v).length };
  } },
  { type: 'donut.client_signal', title: 'Client signal quality', group: 'Wi-Fi health', w: 3, h: 4, compute: (S, v) => {
      const c = inVenue(S.clients, v).filter((x) => x.rssi != null);
      const b = { Excellent: 0, Good: 0, Fair: 0, Poor: 0 };
      for (const x of c) b[x.rssi >= -60 ? 'Excellent' : x.rssi >= -70 ? 'Good' : x.rssi >= -80 ? 'Fair' : 'Poor']++;
      return { kind: 'donut', title: venueTitle(S, v, 'Client signal (RSSI)'), items: Object.entries(b).map(([label, value]) => ({ label, value, tone: { Excellent: 'ok', Good: 'info', Fair: 'warn', Poor: 'bad' }[label] })), centerLabel: 'clients', center: c.length };
  } },
  { type: 'bar.channels', title: 'Clients by channel', group: 'Wi-Fi health', w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 8 }], compute: (S, v, p) => ({
      kind: 'bar', title: venueTitle(S, v, 'Clients by channel'), items: tally(inVenue(S.clients, v).filter((x) => x.channel != null), (x) => `Ch ${x.channel}${x.band ? ` · ${x.band}` : ''}`).slice(0, nonEmpty(p.n, 8)) }) },
  { type: 'bar.top_clients', title: 'Top clients by traffic', group: 'Wi-Fi health', w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 8 }], compute: (S, v, p) => {
      const items = inVenue(S.clients, v).filter((x) => x.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, nonEmpty(p.n, 8)).map((x) => ({ label: x.name || x.model || 'Client', value: Math.round(x.bytes / 1e6), sub: [x.ssid, x.ap].filter(Boolean).join(' · ') }));
      return { kind: 'bar', title: venueTitle(S, v, 'Top clients by traffic'), unit: ' MB', items };
  } },


  // ---------- client mix (stands in for "top applications": R1's public API has no per-app usage) ----------
  { type: 'donut.clients_vendor', title: 'Top client manufacturers', group: 'Client mix', w: 3, h: 4, params: [{ name: 'n', label: 'Show top', default: 7 }], compute: (S, v, p) => ({ kind: 'donut', title: venueTitle(S, v, 'Top client manufacturers'), items: topN(tally(inVenue(S.clients, v), (c) => c.vendor), nonEmpty(p.n, 7)), centerLabel: 'clients', center: inVenue(S.clients, v).length }) },
  { type: 'bar.clients_vendor', title: 'Top client manufacturers (bars)', group: 'Client mix', w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 10 }], compute: (S, v, p) => ({ kind: 'bar', title: venueTitle(S, v, 'Top client manufacturers'), items: tally(inVenue(S.clients, v), (c) => c.vendor).slice(0, nonEmpty(p.n, 10)) }) },
  { type: 'bar.clients_models', title: 'Top device models', group: 'Client mix', w: 4, h: 4, params: [{ name: 'n', label: 'Show top', default: 10 }], compute: (S, v, p) => ({ kind: 'bar', title: venueTitle(S, v, 'Top device models'), items: tally(inVenue(S.clients, v).filter((c) => c.model), (c) => c.model).slice(0, nonEmpty(p.n, 10)) }) },
  { type: 'donut.clients_devtype', title: 'Clients by device type', group: 'Client mix', w: 3, h: 4, params: [{ name: 'n', label: 'Show top', default: 6 }], compute: (S, v, p) => ({ kind: 'donut', title: venueTitle(S, v, 'Clients by device type'), items: topN(tally(inVenue(S.clients, v), (c) => c.devType || 'Unknown'), nonEmpty(p.n, 6)), centerLabel: 'clients', center: inVenue(S.clients, v).length }) },

  // ---------- misc ----------
  { type: 'info.status', title: 'Data source status', group: 'Misc', w: 3, h: 2, compute: (S) => {
      const errs = Object.entries(S.errors || {});
      return { kind: 'kpi', title: 'Data source', value: errs.length ? `${errs.length} issue${errs.length > 1 ? 's' : ''}` : 'Healthy', suffix: errs.length ? errs.map(([k]) => k).join(', ') : `${S.source} · ${S.at ? fmtAgo(S.at) + ' ago' : 'no data'}`, tone: errs.length ? 'warn' : 'ok' };
  } }
];

W.push(...require('./widgetgen').all());   // generated catalog (entity × field × measure × form, scorecards, trends)
const byType = new Map(W.map((w) => [w.type, w]));

const catalog = () => W.map(({ type, title, group, sub, w, h, params, needs, match }) => ({ type, title, group, sub: sub || '', w, h, params: params || [], needs: needs || [], match: Boolean(match), numeric: /^(g\.)?kpi\./.test(type) }));
// Which heavy data sources do the widgets currently on screens require?
const needsFor = (layout) => { const n = new Set(); for (const sc of layout.screens) for (const wd of sc.widgets) for (const k of (byType.get(wd.type) || {}).needs || []) n.add(k); return n; };
function compute(widget, S) {
  const def = byType.get(widget.type);
  if (!def) return { kind: 'error', title: widget.type, message: 'Unknown widget type' };
  try { return def.compute(S, widget.venue || '', { ...(widget.params || {}), _match: widget.match || '' }); } catch (e) { return { kind: 'error', title: def.title, message: e.message }; }
}
module.exports = { catalog, compute, needsFor, has: (t) => byType.has(t) };
