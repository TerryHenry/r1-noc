'use strict';
// Reports: render a screen's widgets as a static, email-safe HTML page (tables + inline CSS, no JS/SVG).
// The same HTML is saved to data/reports/, served at /report, printed to PDF from the browser, and emailed on a schedule.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'reports.json');
const DIR = path.join(DATA_DIR, 'reports');
const PAL = ['#4c9aff', '#e69f00', '#56b4a9', '#cc79a7', '#b8c34a', '#9a7dd8', '#d55e00'];
const TONE = { ok: '#1f8f58', warn: '#b87800', bad: '#d12f2b', info: '#1a6fdc', muted: '#8794a8' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = new Intl.NumberFormat();
const txt = (i) => i.text ?? nf.format(i.value);

// ---- chart-ish renderers (all tables / divs with inline styles) ----
function bars(items, max, unitFmt) {
  const m = max || Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px">${items.map((i, k) => `<tr><td style="padding:2px 8px 2px 0;width:34%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px">${esc(i.label)}${i.sub ? `<br><span style="color:#8794a8;font-size:10px">${esc(i.sub)}</span>` : ''}</td>` +
    `<td style="padding:2px 0"><div style="background:#eef1f5;border-radius:4px"><div style="height:10px;border-radius:4px;background:${i.tone ? TONE[i.tone] : PAL[0]};width:${Math.max(2, (Math.abs(i.value) / m) * 100).toFixed(1)}%"></div></div></td>` +
    `<td style="padding:2px 0 2px 8px;text-align:right;width:56px;color:#55627a">${esc(unitFmt ? unitFmt(i) : txt(i))}</td></tr>`).join('')}</table>`;
}
function donut(d) {
  const items = d.items.filter((i) => i.value > 0); const total = items.reduce((n, i) => n + i.value, 0) || 1;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px">${items.map((i, k) => `<tr><td style="width:12px;padding:3px 6px 3px 0"><div style="width:10px;height:10px;border-radius:2px;background:${i.tone ? TONE[i.tone] : PAL[k % PAL.length]}"></div></td><td style="padding:3px 0">${esc(i.label)}</td>` +
    `<td style="padding:3px 0;width:38%"><div style="background:#eef1f5;border-radius:4px"><div style="height:8px;border-radius:4px;background:${i.tone ? TONE[i.tone] : PAL[k % PAL.length]};width:${((i.value / total) * 100).toFixed(1)}%"></div></div></td>` +
    `<td style="padding:3px 0 3px 8px;text-align:right;color:#55627a;white-space:nowrap">${esc(txt(i))} · ${Math.round((i.value / total) * 100)}%</td></tr>`).join('')}</table>` +
    `<div style="margin-top:6px;font-size:11px;color:#8794a8">Total: ${esc(d.centerText ?? nf.format(d.center ?? total))} ${esc(d.centerLabel || '')}</div>`;
}
// Sparkline as a row of table cells (renders in every mail client, no SVG needed).
function spark(points, color = PAL[0], buckets = 36, height = 44) {
  if (points.length < 2) return '<div style="color:#8794a8;font-size:12px">Not enough history yet</div>';
  const t0 = points[0][0], t1 = points[points.length - 1][0]; const span = (t1 - t0) || 1; const b = Array.from({ length: buckets }, () => ({ s: 0, n: 0 }));
  for (const [t, v] of points) { const i = Math.min(buckets - 1, Math.floor(((t - t0) / span) * buckets)); b[i].s += v; b[i].n++; }
  const vals = b.map((x) => (x.n ? x.s / x.n : null)); const real = vals.filter((v) => v != null); const lo = Math.min(...real), hi = Math.max(...real); const rng = hi - lo || 1;
  const cells = vals.map((v) => `<td valign="bottom" style="padding:0 1px"><div style="height:${v == null ? 0 : Math.round(6 + ((v - lo) / rng) * (height - 6))}px;background:${color};border-radius:2px 2px 0 0"></div></td>`).join('');
  const last = points[points.length - 1][1]; const f = (n) => nf.format(Math.round(n * 10) / 10);
  return `<table width="100%" cellpadding="0" cellspacing="0" style="height:${height}px"><tr>${cells}</tr></table><div style="margin-top:4px;font-size:11px;color:#55627a">min ${f(lo)} · max ${f(hi)} · now ${f(last)} &nbsp; <span style="color:#8794a8">${new Date(t0).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} → ${new Date(t1).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>`;
}
function columns(d) {
  if (!d.hasData) return '<div style="color:#8794a8;font-size:12px">Not enough history yet</div>';
  const hi = Math.max(1, ...d.items.map((i) => Math.max(i.value, i.peak || 0)));
  return `<table width="100%" cellpadding="0" cellspacing="0" style="height:64px"><tr>${d.items.map((i) => `<td valign="bottom" align="center" style="padding:0 1px"><div style="height:${Math.round((i.value / hi) * 54)}px;background:${PAL[0]};border-radius:2px 2px 0 0"></div></td>`).join('')}</tr>` +
    `<tr>${d.items.map((i, k) => `<td align="center" style="font-size:9px;color:#8794a8">${k % 3 === 0 ? esc(i.label) : ''}</td>`).join('')}</tr></table>`;
}
function body(d) {
  switch (d.kind) {
    case 'kpi': return `<div style="font-size:30px;font-weight:700;line-height:1.1;color:${TONE[d.tone] || '#17202b'}">${esc(typeof d.value === 'number' ? nf.format(d.value) : d.value)}<span style="font-size:13px;font-weight:400;color:#55627a;margin-left:6px">${esc(d.suffix || '')}</span></div>${d.delta != null ? `<div style="font-size:12px;color:${d.delta > 0 ? TONE.ok : TONE.warn}">${d.delta > 0 ? '▲' : d.delta < 0 ? '▼' : '•'} ${nf.format(Math.abs(d.delta))} ${esc(d.deltaLabel || '')}</div>` : ''}`;
    case 'donut': return d.items.some((i) => i.value > 0) ? donut(d) : '<div style="color:#8794a8">No data</div>';
    case 'bar': return d.items.length ? bars(d.items, d.max) : '<div style="color:#8794a8">No data</div>';
    case 'list': return d.rows.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px">${d.rows.map((r) => `<tr><td style="padding:4px 8px 4px 0;width:76px;color:${TONE[r.tone] || '#55627a'};font-weight:600;font-size:10px;text-transform:uppercase">${esc(r.badge || '')}</td><td style="padding:4px 0">${esc(r.primary)}<br><span style="color:#8794a8;font-size:10px">${esc(r.secondary || '')}</span></td><td style="padding:4px 0 4px 8px;text-align:right;color:#55627a;white-space:nowrap">${esc(r.meta || '')}</td></tr>`).join('')}</table>` : `<div style="color:${TONE.ok}">${esc(d.empty || 'Nothing to show')}</div>`;
    case 'table': return `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse"><tr>${d.columns.map((c) => `<th align="left" style="padding:4px 6px;border-bottom:2px solid #d8dee6;color:#55627a;font-size:10px;text-transform:uppercase">${esc(c)}</th>`).join('')}</tr>${d.rows.map((r) => `<tr>${r.cells.map((c, i) => `<td style="padding:4px 6px;border-bottom:1px solid #eef1f5;${i === 0 && r.tone ? `border-left:3px solid ${TONE[r.tone] || '#d8dee6'};` : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
    case 'stack': return d.rows.map((r) => { const tot = r.segments.reduce((n, x) => n + x.value, 0); const max = Math.max(1, ...d.rows.map((q) => q.segments.reduce((n, x) => n + x.value, 0)));
      return `<div style="margin-bottom:8px"><div style="font-size:12px">${esc(r.label)} <b>${nf.format(tot)}</b></div><table width="100%" cellpadding="0" cellspacing="0"><tr>${r.segments.map((x) => `<td style="width:${(x.value / max) * 100}%;background:${TONE[x.tone] || PAL[0]};height:14px;color:#fff;font-size:10px;text-align:center">${esc(x.label)} ${x.value}</td>`).join('')}<td></td></tr></table></div>`; }).join('');
    case 'gauge': return `<div style="font-size:30px;font-weight:700;color:${TONE[((d.zones || []).find((z) => d.value != null && d.value <= z.to) || {}).tone] || '#17202b'}">${esc(d.text)}</div><div style="font-size:11px;color:#8794a8">scale ${d.min} … ${d.max}</div>`;
    case 'message': return d.messages.length ? d.messages.map((m) => `<div style="border-left:4px solid ${TONE[m.tone] || TONE.info};padding:4px 8px;margin-bottom:4px;font-size:14px">${esc(m.text)}</div>`).join('') : '<div style="color:#8794a8">No messages</div>';
    case 'weather': return `<div style="font-size:28px;font-weight:700">${d.now.temp}°${esc(d.units)} <span style="font-size:14px;font-weight:400">${esc(d.now.text)}</span></div><div style="font-size:12px;color:#55627a">${esc(d.place)} · wind ${d.now.wind} ${esc(d.windUnit)} · humidity ${d.now.humidity}%</div><table width="100%" cellpadding="0" cellspacing="0" style="font-size:11px;margin-top:6px"><tr>${d.days.map((x) => `<td>${esc(x.date.slice(5))}: ${x.hi}° / ${x.lo}° ${esc(x.text)}</td>`).join('')}</tr></table>`;
    case 'line': return spark(d.points || []);
    case 'multiline': return (d.series || []).length ? d.series.map((s, i) => `<div style="margin-bottom:6px"><div style="font-size:11px;color:${PAL[i % PAL.length]};font-weight:600">${esc(s.label)}</div>${spark(s.points, PAL[i % PAL.length], 36, 28)}</div>`).join('') : '<div style="color:#8794a8;font-size:12px">Not enough history yet</div>';
    case 'columns': return columns(d);
    default: return `<div style="color:#d12f2b">${esc(d.message || 'Unsupported widget')}</div>`;
  }
}
const FULL = new Set(['table', 'list']);   // wide cards span both columns

// screens: [{ name, widgets }]  data: { widgetId → payload }
function render({ title, subtitle, screens, data, generatedAt = new Date(), source = '' }) {
  const card = (wd, span) => { const d = data[wd.id] || { kind: 'error', message: 'No data' }; return `<td colspan="${span}" valign="top" width="${span === 2 ? '100%' : '50%'}" style="padding:6px"><div style="border:1px solid #d8dee6;border-radius:8px;padding:10px 12px;background:#fff"><div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#55627a;margin-bottom:6px">${esc(d.title || wd.type)}</div>${body(d)}</div></td>`; };
  const sections = screens.map((sc) => {
    const rows = []; let kp = [], pair = [];
    const flushK = () => { if (kp.length) { rows.push(`<tr><td colspan="2" style="padding:0"><table width="100%" cellpadding="0" cellspacing="0"><tr>${kp.map((wd) => { const d = data[wd.id] || {}; return `<td valign="top" width="${Math.floor(100 / Math.max(2, Math.min(4, kp.length)))}%" style="padding:6px"><div style="border:1px solid #d8dee6;border-top:3px solid ${TONE[d.tone] || '#d8dee6'};border-radius:8px;padding:10px 12px;background:#fff"><div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#55627a;margin-bottom:6px">${esc(d.title || wd.type)}</div>${body(d)}</div></td>`; }).join('')}</tr></table></td></tr>`); kp = []; } };
    const flushP = () => { if (pair.length) { rows.push(`<tr>${pair.map((wd) => card(wd, 1)).join('')}${pair.length === 1 ? '<td></td>' : ''}</tr>`); pair = []; } };
    for (const wd of sc.widgets) {
      const d = data[wd.id] || {};
      if (d.kind === 'kpi') { flushP(); kp.push(wd); if (kp.length === 4) flushK(); }
      else if (FULL.has(d.kind)) { flushK(); flushP(); rows.push(`<tr>${card(wd, 2)}</tr>`); }
      else { flushK(); pair.push(wd); if (pair.length === 2) flushP(); }
    }
    flushK(); flushP();
    return `<h2 style="font-size:16px;margin:18px 6px 4px;color:#17202b">${esc(sc.name)}</h2><table width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>@media print { body { background:#fff !important } .noprint { display:none } h2 { page-break-after: avoid } table { page-break-inside: auto } tr { page-break-inside: avoid } }</style></head>
<body style="margin:0;background:#eef1f5;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#17202b"><div style="max-width:820px;margin:0 auto;padding:16px">
<div style="padding:6px"><div style="font-size:22px;font-weight:700">${esc(title)}</div><div style="font-size:12px;color:#55627a">${esc(subtitle || '')}${subtitle ? ' · ' : ''}Generated ${esc(generatedAt.toLocaleString())}${source ? ' · ' + esc(source) : ''}</div>
<div class="noprint" style="margin-top:6px"><a href="javascript:window.print()" style="font-size:12px;color:#1a6fdc">Print / save as PDF</a></div></div>${sections}
<div style="padding:12px 6px;font-size:11px;color:#8794a8">RUCKUS One NOC report</div></div></body></html>`;
}

// ---- report definitions (data/reports.json) ----
const clean = (r, i) => ({
  id: String(r.id || `rep-${Date.now().toString(36)}${i}`).slice(0, 40), name: String(r.name || 'Report').slice(0, 60), enabled: r.enabled !== false,
  view: String(r.view || 'Main').slice(0, 40), screen: String(r.screen || '*').slice(0, 40), freq: r.freq === 'weekly' ? 'weekly' : 'daily',
  day: Math.max(0, Math.min(6, Math.round(Number(r.day)) || 0)), time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(r.time)) ? String(r.time).padStart(5, '0') : '07:00', email: r.email !== false, lastRun: Number(r.lastRun) || 0, lastStatus: String(r.lastStatus || '').slice(0, 200)
});
let reports = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')).map(clean); } catch { return []; } })();
const persist = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(reports, null, 2)); fs.renameSync(FILE + '.tmp', FILE); };
function save(list) { if (!Array.isArray(list)) throw new Error('reports must be a list'); const old = new Map(reports.map((r) => [r.id, r])); reports = list.slice(0, 20).map((r, i) => { const c = clean(r, i); const p = old.get(c.id); return p ? { ...c, lastRun: p.lastRun, lastStatus: p.lastStatus } : c; }); persist(); return reports; }
function mark(id, status) { const r = reports.find((x) => x.id === id); if (r) { r.lastRun = Date.now(); r.lastStatus = status; persist(); } }

// Is this report due now? It runs once per day at/after its time (weekly: on its weekday).
function due(r, now = new Date()) {
  if (!r.enabled) return false;
  if (r.freq === 'weekly' && now.getDay() !== r.day) return false;
  const [h, m] = r.time.split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return false;
  const last = new Date(r.lastRun || 0);
  return !(r.lastRun && last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate());
}
function saveFile(id, html) {
  fs.mkdirSync(DIR, { recursive: true });
  const name = `${id}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.html`;
  fs.writeFileSync(path.join(DIR, name), html);
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.html')).sort(); for (const old of files.slice(0, Math.max(0, files.length - 60))) fs.unlinkSync(path.join(DIR, old));   // keep the newest 60
  return name;
}
const files = () => { try { return fs.readdirSync(DIR).filter((f) => f.endsWith('.html')).sort().reverse().slice(0, 40); } catch { return []; } };
module.exports = { render, get: () => reports, save, mark, due, saveFile, files, DIR };
