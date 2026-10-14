'use strict';
const q = new URLSearchParams(location.search);
const KEY = q.get('key') ? `key=${encodeURIComponent(q.get('key'))}` : '';
const api = (p) => p + (KEY ? (p.includes('?') ? '&' : '?') + KEY : '');
if (q.get('theme')) document.documentElement.dataset.theme = q.get('theme');
const USER_SCALE = Number(q.get('scale')) || 1;

const CAT = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)'];
const TONE = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', info: 'var(--info)', muted: 'var(--faint)' };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = new Intl.NumberFormat();

let layout = null, data = null, screenIdx = 0, rotateTimer = null, lastDataAt = 0;
const pinned = q.get('screen');
// Multi-display: ?display=2 shows only display 2's share of every screen that is spread across displays.
// Any ?display= client (or ?sync=1) follows the server's shared rotation clock, so all displays change together.
const DISPLAY = Math.max(0, Math.floor(Number(q.get('display'))) || 0);
const SIGN = q.get('mode') === 'ticker';   // ?mode=ticker → a dedicated full-screen scrolling-text display
if (SIGN) document.body.classList.add('sign');
const SYNC = !pinned && (q.get('sync') === '1' || DISPLAY > 0);
let control = null, clockOffset = 0;
// Views: the active one is (local pick) → ?view= → the server's scheduled view → Main.
let localView = q.get('view') || '', serverView = 'Main', drillVenue = '', venueList = [];
// The active view, narrowed to this display's playlist when it has one (an empty/missing playlist = all screens).
const viewOf = () => {
  const n = localView || serverView; const v = (layout.views || []).find((x) => x.name === n);
  const base = v ? { name: v.name, rotateSeconds: v.rotateSeconds, screens: v.screens, playlists: v.playlists || [] } : { name: 'Main', rotateSeconds: layout.rotateSeconds, screens: layout.screens, playlists: layout.playlists || [] };
  const pl = DISPLAY > 0 ? base.playlists[DISPLAY - 1] : null;
  if (pl && pl.length) { const byName = new Map(base.screens.map((x) => [x.name, x])); const list = pl.map((x) => byName.get(x)).filter(Boolean); if (list.length) return { ...base, screens: list, playlist: true }; }
  return { ...base, playlist: false };
};
const scr = () => viewOf().screens;
let held = q.get('hold') === '1' || (() => { try { return sessionStorage.getItem('noc.hold') === '1'; } catch { return false; } })();

// ---------- renderers ----------
const R = {
  kpi: (d) => `<div class="kpi"><div class="v ${d.tone ? 't' : ''}">${esc(typeof d.value === 'number' ? nf.format(d.value) : d.value)}${d.suffix ? `<small>${esc(d.suffix)}</small>` : ''}</div>` +
    (d.delta != null ? `<div class="d ${d.delta > 0 ? 'up' : d.delta < 0 ? 'down' : ''}">${d.delta > 0 ? '▲' : d.delta < 0 ? '▼' : '•'} ${nf.format(Math.abs(d.delta))} ${esc(d.deltaLabel || '')}</div>` : '') + '</div>',

  donut: (d) => {
    const items = d.items.filter((i) => i.value > 0);
    const total = items.reduce((s, i) => s + i.value, 0);
    if (!total) return '<div class="empty" style="color:var(--faint)">No data</div>';
    const r = 38, C = 2 * Math.PI * r; let off = 0;
    const arcs = items.map((it, i) => {
      const len = (it.value / total) * C; const col = it.tone ? TONE[it.tone] : CAT[i % CAT.length];
      const s = `<circle r="${r}" cx="50" cy="50" fill="none" stroke="${col}" stroke-width="14" stroke-dasharray="${Math.max(len - (items.length > 1 ? 1.2 : 0), 0.1)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 50 50)"/>`;
      off += len; return s;
    }).join('');
    const leg = items.map((it, i) => `<div><i style="background:${it.tone ? TONE[it.tone] : CAT[i % CAT.length]}"></i><span class="l" title="${esc(it.label)}">${esc(it.label)}</span><span class="n">${esc(it.text ?? nf.format(it.value))}</span></div>`).join('');
    return `<div class="donut"><svg viewBox="0 0 100 100"><circle r="${r}" cx="50" cy="50" fill="none" stroke="var(--panel-2)" stroke-width="14"/>${arcs}` +
      `<text class="ctr-v" x="50" y="53" text-anchor="middle" style="font-size:${(() => { const n = String(d.centerText ?? nf.format(d.center ?? total)).length; return n <= 4 ? 17 : n <= 6 ? 14 : n <= 8 ? 10.5 : 8.5; })()}px">${esc(d.centerText ?? nf.format(d.center ?? total))}</text><text class="ctr-l" x="50" y="64" text-anchor="middle" font-size="7">${esc(d.centerLabel || '')}</text></svg><div class="legend">${leg}</div></div>`;
  },

  bar: (d) => {
    if (!d.items.length) return '<div class="empty" style="color:var(--faint)">No data</div>';
    const max = d.max || Math.max(1, ...d.items.map((i) => Math.abs(i.value)));
    return '<div class="bars">' + d.items.map((i) => `<div class="bar"><div class="l" title="${esc(i.label)}">${esc(i.label)}${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</div><div class="track"><div class="fill" style="width:${Math.max(2, (Math.abs(i.value) / max) * 100)}%"></div></div><div class="n">${esc(i.text ?? (nf.format(i.value) + (d.unit || '')))}</div></div>`).join('') + '</div>';
  },

  list: (d) => !d.rows.length ? `<div class="empty">${esc(d.empty || 'Nothing to show')}</div>` :
    '<div class="rows">' + d.rows.map((r) => `<div class="row ${r.tone || ''}"><span class="badge">${esc(r.badge || '')}</span><div style="min-width:0"><div class="p">${esc(r.primary)}</div><div class="s">${esc(r.secondary || '')}</div></div><span class="m">${esc(r.meta || '')}</span></div>`).join('') + '</div>',

  table: (d) => '<table><thead><tr>' + d.columns.map((c) => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>' +
    d.rows.map((r) => `<tr class="${r.tone || ''}">${r.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>',

  // R1-style stacked bars: one row per group, coloured segments (by status/quality), legend underneath.
  stack: (d) => { const max = Math.max(1, ...d.rows.map((r) => r.segments.reduce((n, x) => n + x.value, 0))); const seen = new Map();
    const rows = d.rows.map((r) => { const tot = r.segments.reduce((n, x) => n + x.value, 0); r.segments.forEach((x) => seen.set(x.label, x.tone));
      return `<div class="stk"><div class="stk-l"><span>${esc(r.label)}</span><b>${nf.format(tot)}</b></div><div class="stk-bar">${tot ? r.segments.map((x) => `<i style="width:${(x.value / max) * 100}%;background:${TONE[x.tone] || 'var(--c1)'}" title="${esc(x.label)}: ${x.value}">${x.value / max > 0.1 ? nf.format(x.value) : ''}</i>`).join('') : '<em>none</em>'}</div></div>`; }).join('');
    return `<div class="stacks">${rows}<div class="stk-legend">${[...seen].map(([l, t]) => `<span><i style="background:${TONE[t] || 'var(--c1)'}"></i>${esc(l)}</span>`).join('')}</div></div>`; },
  message: (d) => (d.messages.length ? `<div class="msgs">${d.messages.map((m) => `<div class="msg ${esc(m.tone || 'info')}">${esc(m.text)}</div>`).join('')}</div>` : '<div class="empty" style="color:var(--faint)">No messages right now</div>'),
  weather: (d) => `<div class="wx"><div class="wx-now"><div class="wx-t">${d.now.temp}°<small>${esc(d.units)}</small></div><div class="wx-c"><b>${esc(d.now.text)}</b><span>Feels ${d.now.feels}° · wind ${d.now.wind} ${esc(d.windUnit)} · humidity ${d.now.humidity}%</span><span>${esc(d.place)}</span></div></div>` +
    `<div class="wx-days">${d.days.map((x, i) => `<div><b>${i === 0 ? 'Today' : new Date(x.date + 'T12:00').toLocaleDateString([], { weekday: 'short' })}</b><span>${x.hi}° / ${x.lo}°</span><span>${esc(x.text)}</span>${x.pop != null ? `<span>${x.pop}% rain</span>` : ''}</div>`).join('')}</div></div>`,
  // Half-circle dial: coloured zones, a needle, and the value underneath.
  gauge: (d) => {
    const R0 = 42, cx = 50, cy = 50; const span = d.max - d.min || 1; const ang = (v) => Math.PI * (1 - Math.max(0, Math.min(1, (v - d.min) / span)));
    const pt = (v, r) => `${(cx + r * Math.cos(ang(v))).toFixed(2)},${(cy - r * Math.sin(ang(v))).toFixed(2)}`;
    let from = d.min; const arcs = (d.zones || []).map((z) => { const a = `<path d="M${pt(from, R0)} A${R0},${R0} 0 0 1 ${pt(z.to, R0)}" fill="none" stroke="${TONE[z.tone]}" stroke-width="9" opacity=".9"/>`; from = z.to; return a; }).join('');
    const has = d.value != null; const col = has ? TONE[((d.zones || []).find((z) => d.value <= z.to) || {}).tone] || 'var(--text)' : 'var(--faint)';
    const needle = has ? `<line x1="${cx}" y1="${cy}" x2="${pt(d.value, R0 - 8).split(',')[0]}" y2="${pt(d.value, R0 - 8).split(',')[1]}" stroke="var(--text)" stroke-width="2.4" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="3" fill="var(--text)"/>` : '';
    return `<div class="gauge"><svg viewBox="0 0 100 62"><path d="M${pt(d.min, R0)} A${R0},${R0} 0 0 1 ${pt(d.max, R0)}" fill="none" stroke="var(--panel-2)" stroke-width="9"/>${arcs}${needle}` +
      `<text x="${cx - R0 - 1}" y="60" font-size="5" fill="var(--faint)" text-anchor="start">${d.min}</text><text x="${cx + R0 + 1}" y="60" font-size="5" fill="var(--faint)" text-anchor="end">${d.max}</text></svg><div class="gv" style="color:${col}">${esc(d.text)}</div></div>`;
  },
  error: (d) => `<div class="err">${esc(d.message)}</div>`
};

// Line charts need real pixel sizes, so they render after layout.
function drawLine(el, d) {
  const w = el.clientWidth, h = el.clientHeight;
  if (w < 40 || h < 30) return;
  const pts = d.points || [];
  if (pts.length < 2) { el.innerHTML = '<div class="nodata">Collecting history…</div>'; return; }
  const padL = 38, padR = 8, padT = 8, padB = 18;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(0, ...ys), y1 = Math.max(...ys); if (y1 === y0) y1 = y0 + 1;
  const nice = niceMax(y1 - y0); y1 = y0 + nice;
  const X = (t) => padL + ((t - x0) / (x1 - x0 || 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - y0) / (y1 - y0)) * (h - padT - padB);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const area = `${line}L${X(x1).toFixed(1)},${Y(y0)}L${X(x0).toFixed(1)},${Y(y0)}Z`;
  const grid = [0, 0.5, 1].map((f) => { const v = y0 + f * (y1 - y0); return `<line class="grid-l" x1="${padL}" x2="${w - padR}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${padL - 6}" y="${Y(v) + 4}" text-anchor="end">${nf.format(Math.round(v))}${esc(d.unit || '')}</text>`; }).join('');
  const tl = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: d.hours <= 6 ? '2-digit' : undefined });
  const last = pts[pts.length - 1];
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${grid}<path d="${area}" fill="var(--c1)" opacity=".16"/><path d="${line}" fill="none" stroke="var(--c1)" stroke-width="2" stroke-linejoin="round"/>` +
    `<circle cx="${X(last[0])}" cy="${Y(last[1])}" r="3.5" fill="var(--c1)"/><text x="${padL}" y="${h - 3}">${tl(x0)}</text><text x="${w - padR}" y="${h - 3}" text-anchor="end">${tl(x1)}</text></svg>`;
}
// Several series on one time axis, legend underneath. Series have independent timestamps (null gaps are fine).
function drawMulti(el, d) {
  const series = (d.series || []).filter((x) => x.points.length > 1);
  if (!series.length) { el.innerHTML = '<div class="nodata">Collecting history…</div>'; return; }
  el.innerHTML = '<div class="mwrap"><div class="mplot"></div><div class="mleg"></div></div>';
  const plot = el.querySelector('.mplot'); const leg = el.querySelector('.mleg');
  leg.innerHTML = series.map((s, i) => `<span><i style="background:${CAT[i % CAT.length]}"></i>${esc(s.label)}</span>`).join('');
  const w = plot.clientWidth, h = plot.clientHeight; if (w < 40 || h < 30) return;
  const padL = 38, padR = 8, padT = 8, padB = 18;
  const all = series.flatMap((s) => s.points);
  const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  const ymax = niceMax(Math.max(1, ...all.map((p) => p[1])));
  const X = (t) => padL + ((t - x0) / (x1 - x0 || 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - v / ymax) * (h - padT - padB);
  const grid = [0, 0.5, 1].map((f) => `<line class="grid-l" x1="${padL}" x2="${w - padR}" y1="${Y(f * ymax)}" y2="${Y(f * ymax)}"/><text x="${padL - 6}" y="${Y(f * ymax) + 4}" text-anchor="end">${nf.format(Math.round(f * ymax))}</text>`).join('');
  const paths = series.map((s, i) => `<path d="${s.points.map((p, k) => `${k ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}" fill="none" stroke="${CAT[i % CAT.length]}" stroke-width="2" stroke-linejoin="round"/>`).join('');
  const tl = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: d.hours <= 6 ? '2-digit' : undefined });
  plot.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${grid}${paths}<text x="${padL}" y="${h - 3}">${tl(x0)}</text><text x="${w - padR}" y="${h - 3}" text-anchor="end">${tl(x1)}</text></svg>`;
}
// Vertical columns (e.g. 24 hours of the day): filled bar = average, short cap = peak.
function drawColumns(el, d) {
  const w = el.clientWidth, h = el.clientHeight; if (w < 60 || h < 40) return;
  if (!d.hasData) { el.innerHTML = '<div class="nodata">Collecting history…</div>'; return; }
  const padL = 38, padR = 6, padT = 8, padB = 18; const n = d.items.length;
  const ymax = niceMax(Math.max(1, ...d.items.map((i) => Math.max(i.value, i.peak || 0))));
  const bw = (w - padL - padR) / n; const Y = (v) => padT + (1 - v / ymax) * (h - padT - padB);
  const grid = [0, 0.5, 1].map((f) => `<line class="grid-l" x1="${padL}" x2="${w - padR}" y1="${Y(f * ymax)}" y2="${Y(f * ymax)}"/><text x="${padL - 6}" y="${Y(f * ymax) + 4}" text-anchor="end">${nf.format(Math.round(f * ymax))}</text>`).join('');
  const cols = d.items.map((it, i) => { const x = padL + i * bw; const y = Y(it.value);
    return `<rect x="${(x + bw * 0.12).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.76).toFixed(1)}" height="${Math.max(0, h - padB - y).toFixed(1)}" rx="2" fill="var(--c1)" opacity=".85"/>` +
      (it.peak > it.value ? `<line x1="${(x + bw * 0.12).toFixed(1)}" x2="${(x + bw * 0.88).toFixed(1)}" y1="${Y(it.peak).toFixed(1)}" y2="${Y(it.peak).toFixed(1)}" stroke="var(--warn)" stroke-width="2"/>` : '') +
      (i % 3 === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 3}" text-anchor="middle">${esc(it.label)}</text>` : ''); }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${grid}${cols}</svg>`;
}
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }

// ---------- screen composition ----------
function cardHtml(wd, d) {
  const title = d ? d.title : wd.type;
  const tone = d && d.tone ? `tone-${d.tone}` : '';
  const body = !d ? '<div class="empty" style="color:var(--faint)">Waiting for data…</div>' : (d.kind === 'line' || d.kind === 'multiline' || d.kind === 'columns') ? '<div class="line" style="height:100%"></div>' : (R[d.kind] || R.error)(d);
  return `<section class="card ${tone}" data-id="${wd.id}" style="grid-column:${wd.x + 1} / span ${wd.w};grid-row:${wd.y + 1} / span ${wd.h}"><h3>${esc(title)}</h3><div class="body">${body}</div></section>`;
}
// Which widgets belong on each of a screen's N displays: 'manual' uses each widget's Display setting,
// 'auto' cuts the widget list (in order) into N contiguous groups of roughly equal area.
function splitWidgets(screen) {
  const n = Math.max(1, screen.displays || 1);
  const groups = Array.from({ length: n }, () => []);
  if (screen.split === 'manual') { screen.widgets.forEach((wd) => groups[Math.min(n, Math.max(1, wd.display || 1)) - 1].push(wd)); return groups; }
  const total = screen.widgets.reduce((a, wd) => a + wd.w * wd.h, 0) || 1; const target = total / n;
  let g = 0, acc = 0;
  screen.widgets.forEach((wd, i) => {
    const a = wd.w * wd.h; const left = screen.widgets.length - i; const groupsAfter = n - 1 - g;
    if (g < n - 1 && groups[g].length && (acc + a / 2 > (g + 1) * target || left <= groupsAfter)) g++;
    groups[g].push(wd); acc += a;
  });
  return groups;
}
// With ?display=k a client with more displays than the screen was split for just mirrors them (k wraps around).
function displayWidgets(screen) {
  const n = screen.displays || 1;
  if (!DISPLAY || n <= 1 || viewOf().playlist) return screen.widgets;
  return splitWidgets(screen)[(DISPLAY - 1) % n];
}
const placedFor = (screen) => { const list = displayWidgets(screen); return NocLayout.place(screen, list, list !== screen.widgets).list; };

// Size rem so the whole screen fills the viewport height exactly (bounded by width so it never gets silly).
function fitScreen(widgets) {
  const rows = NocLayout.rowsNeeded(widgets);
  const banner = $('#banner').classList.contains('show') ? $('#banner').offsetHeight : 0;
  const tickerH = $('#ticker').classList.contains('off') ? 0 : $('#ticker').offsetHeight;
  const avail = innerHeight - banner - tickerH;
  // header ≈ 2.7rem, stage padding 1.5rem, row 5.2rem, gap .75rem
  let f = avail / (2.7 + 1.5 + 5.2 * rows + 0.75 * (rows - 1));
  f = Math.max(8, Math.min(f, innerWidth / 62)) * USER_SCALE;
  document.documentElement.style.fontSize = `${f}px`;
}

// Charts/lists never get a scrollbar: drop trailing rows until each card fits, and stack
// donut legends under the ring when the card is narrow.
function trimOverflow(root) {
  for (const body of root.querySelectorAll('.card .body')) {
    const d = body.querySelector('.donut');
    if (d) { d.classList.toggle('stack', body.clientWidth < body.clientHeight * 1.25); }
    const list = body.querySelector('.bars, .rows, tbody, .legend');
    if (!list) continue;
    const kids = () => (list.tagName === 'TBODY' ? list.rows : list.children);
    let guard = 60;
    while (kids().length > 1 && guard-- > 0 && (list.scrollHeight > list.clientHeight + 1 || body.scrollHeight > body.clientHeight + 1)) kids()[kids().length - 1].remove();
  }
}

function paintScreen(fade = false) {
  if (!layout) return;
  const s = scr()[Math.min(screenIdx, scr().length - 1)];
  const placed = placedFor(s);
  fitScreen(placed);
  const grid = document.createElement('div');
  grid.className = 'grid'; if (!fade) grid.style.animation = 'none';
  grid.innerHTML = placed.map((wd) => cardHtml(wd, data && data.widgets[wd.id])).join('');
  $('#stage').replaceChildren(grid);
  for (const wd of placed) { const d = data && data.widgets[wd.id]; if (d && d.kind === 'line') drawLine(grid.querySelector(`[data-id="${wd.id}"] .line`), d); if (d && d.kind === 'columns') drawColumns(grid.querySelector(`[data-id="${wd.id}"] .line`), d); if (d && d.kind === 'multiline') drawMulti(grid.querySelector(`[data-id="${wd.id}"] .line`), d); }
  trimOverflow(grid);
  $('.screen-name').textContent = DISPLAY && (s.displays || 1) > 1 ? `${s.name} · display ${((DISPLAY - 1) % s.displays) + 1}/${s.displays}` : s.name;
  $('.dots').innerHTML = scr().map((sc, i) => `<i data-i="${i}" title="${esc(sc.name)}" class="${i === screenIdx ? 'on' : ''}"></i>`).join('');
  paintHold();
  $('#title').textContent = layout.title;
  document.title = `${layout.title} — ${s.name}`;
}
function paintHold() {
  const b = $('#hold'); if (!b) return;
  const h = SYNC ? Boolean(control && control.held) : held;
  b.textContent = h ? '▶ Resume' : '❚❚ Hold'; b.classList.toggle('held', h);
  $('#ctl').classList.toggle('pinned', h);   // keep the controls visible while held
}
// In sync mode every action goes to the server and comes back to all displays; otherwise it is local.
async function sendControl(body) {
  try {
    const r = await fetch(api('/api/control'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { const j = await r.json(); control = j.control; clockOffset = j.serverNow - Date.now(); syncTick(); }
  } catch { /* offline: ignore */ }
}
function syncIdx() {
  const n = scr().length; if (!control) return 0;
  if (control.held) return ((control.screen % n) + n) % n;
  const sec = Number(q.get('rotate') ?? viewOf().rotateSeconds);
  const steps = sec > 0 ? Math.floor((Date.now() + clockOffset - control.t0) / (sec * 1000)) : 0;
  return (((control.base + steps) % n) + n) % n;
}
function syncTick() { if (!layout || !SYNC || takeoverOn) return; const i = syncIdx(); if (i !== screenIdx) setScreen(i); else paintHold(); }
function setHold(on) {
  if (SYNC) return sendControl({ action: on ? 'hold' : 'resume' });
  held = on; try { sessionStorage.setItem('noc.hold', on ? '1' : '0'); } catch { /* private mode */ }
  paintHold(); startRotation();
}
const isHeld = () => (SYNC ? Boolean(control && control.held) : held);
function go(delta) { if (SYNC) return sendControl({ action: delta > 0 ? 'next' : 'prev' }); setScreen(screenIdx + delta); startRotation(); }
function goto_(i) { if (SYNC) return sendControl({ action: 'goto', screen: i }); setScreen(i); startRotation(); }

function setScreen(i, fade = true) { screenIdx = (i + scr().length) % scr().length; paintScreen(fade); }
function startRotation() {
  clearInterval(rotateTimer);
  if (SYNC) return;   // the shared clock drives rotation
  const sec = Number(q.get('rotate') ?? viewOf().rotateSeconds);
  if (pinned || held || !sec || scr().length < 2) return;
  rotateTimer = setInterval(() => { if (!takeoverOn) setScreen(screenIdx + 1); }, sec * 1000);
}
setInterval(syncTick, 400);

// ---------- alerts: takeover, ticker, burn-in guard ----------
let alerts = [], takeoverOn = false;
// This display's ticker settings: the global ones, overridden by any per-display setting. A plain viewer counts as display 1.
const myDisplay = () => DISPLAY || 1;
function tickerFor(t) {
  const base = t || { enabled: true, speed: 70, size: 'large', showStatus: true, perDisplay: {}, segments: [] }; const ov = (base.perDisplay || {})[myDisplay()] || {};
  return { ...base, ...ov, alerts: ov.alerts !== false, segments: (base.segments || []).filter((g) => !g.displays || !g.displays.length || g.displays.includes(myDisplay())) };
}
const ago = (t) => { const m = Math.max(0, Math.round((Date.now() + clockOffset - t) / 60000)); return m < 1 ? 'just now' : m < 90 ? `${m} min` : `${Math.round(m / 60)} h`; };
function paintAlerts(summary) {
  const tk = alerts.filter((a) => a.takeover && !a.acked);
  takeoverOn = tk.length > 0;
  const box = $('#takeover');
  box.hidden = !takeoverOn;
  if (takeoverOn) {
    const crit = tk.some((a) => a.severity === 'crit');
    box.querySelector('.tk-card').classList.toggle('warnonly', !crit);
    box.querySelector('.tk-title').textContent = crit ? 'CRITICAL ALERT' : 'WARNING';
    box.querySelector('.tk-count').textContent = `${tk.length} active`;
    box.querySelector('.tk-list').innerHTML = tk.slice(0, 5).map((a) => `<div class="tk-item ${a.severity === 'crit' ? '' : 'warn'}"><b>${esc(a.name)}${a.venue ? ' — ' + esc(a.venue) : ''}</b><span>${esc(a.metric)}: ${esc(a.value)}${esc(a.unit)} (${esc(a.op)} ${esc(a.threshold)}${esc(a.unit)}) · for ${ago(a.since)}</span></div>`).join('') + (tk.length > 5 ? `<div class="tk-item warn"><span>…and ${tk.length - 5} more</span></div>` : '');
    box.dataset.keys = JSON.stringify(tk.map((a) => a.key));
  }
  // ticker: live alerts first, then custom messages and feed items; a one-line status when there is nothing else
  const tkr = $('#ticker'); const track = tkr.querySelector('.track'); const cfgT = tickerFor(data && data.ticker);
  const live = alerts.filter((a) => !a.acked || a.severity === 'crit');
  const parts = live.map((a) => `<span class="${a.severity}">${a.severity === 'crit' ? '●' : '▲'} ${esc(a.message)}${a.acked ? ' (acknowledged)' : ''}</span>`);
  if (cfgT.enabled) for (const g of cfgT.segments) parts.push(`<span class="seg ${esc(g.tone)} k-${esc(g.kind)}">${esc(g.text)}</span>`);
  if (!parts.length && cfgT.enabled && cfgT.showStatus && summary) parts.push(`<span class="okt">● All clear</span>`, `<span>APs ${summary.apsUp}/${summary.aps}</span>`, `<span>Switches ${summary.swUp}/${summary.sw}</span>`, `<span>Clients ${nf.format(summary.clients)}</span>`, `<span>Alarms ${summary.alarms}</span>`);
  if (!parts.length && !summary) parts.push('<span>Waiting for data…</span>');
  const html = parts.join('');
  const SIZES = { small: 3.4, medium: 4.8, large: 6.4, xl: 8.8 };   // ticker height as % of the screen height (text is sized from it)
  const tkSize = SIZES[cfgT.size] || SIZES.large;
  if (tkr.dataset.size !== String(tkSize)) { tkr.dataset.size = String(tkSize); tkr.style.setProperty('--tk', tkSize); if (!SIGN && layout) requestAnimationFrame(() => paintScreen(false)); }
  const hide = !parts.length || q.get('ticker') === '0';
  if (tkr.classList.contains('off') !== hide) { tkr.classList.toggle('off', hide); if (!SIGN) paintScreen(false); }   // the screen is re-fitted around the ticker's height
  if (track.dataset.sig !== html + '|' + cfgT.speed + '|' + tkSize) {
    track.dataset.sig = html + '|' + cfgT.speed + '|' + tkSize; track.classList.remove('scroll'); track.innerHTML = `<span class="copy">${html}</span>`;
    requestAnimationFrame(() => {   // scroll only when it does not fit: two copies loop seamlessly, text is visible immediately
      const w = track.scrollWidth;
      if (w > tkr.clientWidth) { track.innerHTML = `<span class="copy">${html}</span><span class="copy">${html}</span>`; track.classList.add('scroll'); track.style.setProperty('--dur', `${Math.max(10, w / (cfgT.speed || 70))}s`); }
    });
  }
}
$('#takeover').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ack]'); if (!b) return;
  const keys = JSON.parse($('#takeover').dataset.keys || '[]');
  for (const key of keys) await fetch(api('/api/alerts/ack'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, minutes: Number(b.dataset.ack) }) });
});
// Burn-in guard (displays/kiosks by default): nudge everything a couple of pixels every few minutes.
if (q.get('guard') === '1' || (DISPLAY > 0 && q.get('guard') !== '0')) {
  document.body.classList.add('guard');
  setInterval(() => { const dx = Math.round((Math.random() - 0.5) * 8), dy = Math.round((Math.random() - 0.5) * 8); for (const el of [$('header.bar'), $('#stage'), $('#ticker')]) el.style.transform = `translate(${dx}px, ${dy}px)`; }, 4 * 60000);
}

// ---------- status ----------
function updateStatus() {
  const chip = $('#src');
  if (!data) { chip.textContent = 'connecting…'; chip.className = 'chip'; return; }
  if (data.starting) { $('#banner').classList.remove('show'); chip.className = 'chip warn'; chip.textContent = 'starting — fetching from RUCKUS One…'; return; }
  if (data.setup) {   // fresh install: nothing is wrong, it just needs its R1 credentials
    $('#banner').classList.add('show'); $('#banner').style.background = 'var(--info)';
    $('#banner').innerHTML = `${esc(data.setup)} <a href="${api('/admin')}" style="color:#fff;text-decoration:underline">Open the editor</a>`;
    chip.className = 'chip warn'; chip.textContent = 'setup needed'; chip.title = data.setup; return;
  }
  $('#banner').style.background = '';
  const age = Date.now() - data.at; const stale = data.at && age > data.pollSeconds * 3000;
  const errs = Object.keys(data.errors || {});
  const core = ['venues', 'aps', 'switches', 'clients', 'alarms'];
  const down = core.every((k) => (data.errors || {})[k]);
  $('#banner').classList.toggle('show', !!stale || down);
  $('#banner').textContent = stale ? `DATA STALE — last update ${Math.round(age / 60000)} min ago` : `R1 API unreachable: ${Object.values(data.errors)[0]}`;
  chip.className = 'chip ' + (stale || down ? 'bad' : errs.length ? 'warn' : 'ok');
  chip.textContent = `${data.source === 'demo' ? 'DEMO · ' : ''}${errs.length ? errs.length + ' source issue' + (errs.length > 1 ? 's' : '') : 'live'} · ${data.at ? new Date(data.at).toLocaleTimeString() : 'no data'}`;
  chip.title = errs.map((k) => `${k}: ${data.errors[k]}`).join('\n');
}
setInterval(() => { $('#clock').textContent = new Date().toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); updateStatus(); }, 1000);

// ---------- boot ----------
async function boot() {
  const r = await fetch(api('/api/config'));
  if (!r.ok) { $('#stage').innerHTML = `<div class="err">${r.status === 401 ? 'Unauthorized — add ?key=…' : 'Failed to load config'}</div>`; return; }
  const c = await r.json(); layout = c.layout; control = c.control; clockOffset = (c.serverNow || Date.now()) - Date.now();
  venueList = (c.venues || []).concat((c.customers || []).map((x) => ({ id: 'c:' + x.id, name: x.name }))); serverView = c.view || 'Main';
  if (SYNC) screenIdx = syncIdx();
  if (pinned) { const i = scr().findIndex((s) => s.name.toLowerCase() === pinned.toLowerCase()); if (i >= 0) screenIdx = i; }
  if (c.canAdmin) $('#edit').style.display = ''; $('#edit').href = api('/admin');
  paintScreen(); startRotation();

  venueList = (c.venues || []).concat((c.customers || []).map((x) => ({ id: 'c:' + x.id, name: x.name }))); serverView = c.view || 'Main'; paintViews();
  openStream();
}
let es = null;
function openStream() {
  if (es) es.close();
  es = new EventSource(api('/api/stream' + (drillVenue ? `?venue=${encodeURIComponent(drillVenue)}` : '')));
  es.addEventListener('data', (e) => {
    data = JSON.parse(e.data); if (data.serverNow) clockOffset = data.serverNow - Date.now(); lastDataAt = Date.now();
    if (data.view && data.view !== serverView) { serverView = data.view; if (!localView) { screenIdx = SYNC ? syncIdx() : 0; paintViews(); startRotation(); } }
    alerts = tickerFor(data.ticker).alerts ? (data.alerts || []) : []; paintScreen(false); updateStatus(); paintAlerts(data.summary);
  });
  es.addEventListener('control', (e) => { const j = JSON.parse(e.data); control = j.control; clockOffset = j.serverNow - Date.now(); syncTick(); });
  es.addEventListener('config', (e) => { const j = JSON.parse(e.data); layout = j.layout; if (j.control) { control = j.control; clockOffset = j.serverNow - Date.now(); } screenIdx = SYNC ? syncIdx() : Math.min(screenIdx, scr().length - 1); paintViews(); paintScreen(); startRotation(); });
}

// ---------- views dropdown ----------
function paintViews() {
  const sel = $('#viewSel'); const names = ['Main', ...(layout.views || []).map((v) => v.name)];
  sel.style.display = names.length > 1 ? '' : 'none';
  sel.innerHTML = names.map((n) => `<option value="${esc(n)}" ${n === viewOf().name ? 'selected' : ''}>${esc(n === 'Main' ? 'Main view' : n)}${n === serverView && !localView && names.length > 1 ? ' (scheduled)' : ''}</option>`).join('');
}
$('#viewSel').addEventListener('change', (e) => { localView = e.target.value === serverView && !q.get('view') ? '' : e.target.value; screenIdx = 0; paintViews(); paintScreen(); startRotation(); });

// ---------- venue drill-down: click a venue name in any chart/table to filter the whole screen ----------
function paintDrill() {
  const chip = $('#drill'); if (!chip) return;
  const name = (venueList.find((v) => v.id === drillVenue) || {}).name;
  chip.style.display = drillVenue ? '' : 'none'; chip.textContent = drillVenue ? `Venue: ${name || drillVenue}  ✕` : '';
}
let drillTimer = null;
function setDrill(id) {
  drillVenue = id || ''; paintDrill(); openStream();
  clearTimeout(drillTimer);
  if (drillVenue) drillTimer = setTimeout(() => setDrill(''), 90000);   // a wall never stays filtered
}
$('#drill').addEventListener('click', () => setDrill(''));
$('#stage').addEventListener('click', (e) => {
  if (!venueList.length) return;
  const el = e.target.closest('.bar .l, .legend div, tbody tr td:first-child, .row .s');
  if (!el) return;
  const text = (el.querySelector && el.querySelector('.l') ? el.querySelector('.l').textContent : el.firstChild && el.firstChild.textContent ? el.firstChild.textContent : el.textContent || '').trim();
  const hay = el.textContent || '';
  const v = venueList.find((x) => text === x.name) || venueList.find((x) => hay.split('·').map((t) => t.trim()).includes(x.name) || hay.trim().startsWith(x.name));
  if (v) setDrill(drillVenue === v.id ? '' : v.id);
});
addEventListener('keydown', (e) => {
  if (!layout) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
  else if (e.key === ' ') { e.preventDefault(); setHold(!isHeld()); }
  else if (/^[1-9]$/.test(e.key) && scr()[Number(e.key) - 1]) goto_(Number(e.key) - 1);
  else if (e.key === 'f') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
});
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => paintScreen(false), 150); });
boot();

// Controls: buttons, clickable dots, and auto-hide when the pointer is idle (wall displays).
$('#prev').addEventListener('click', () => go(-1));
$('#next').addEventListener('click', () => go(1));
$('#hold').addEventListener('click', () => setHold(!isHeld()));
$('.dots').addEventListener('click', (e) => { const i = e.target.dataset && e.target.dataset.i; if (i != null) goto_(Number(i)); });
let idleT; const wake = () => { document.body.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => document.body.classList.add('idle'), 3500); };
['mousemove', 'mousedown', 'touchstart', 'keydown'].forEach((ev) => addEventListener(ev, wake, { passive: true })); wake();
