'use strict';
const q = new URLSearchParams(location.search);
const KEY = q.get('key') ? `key=${encodeURIComponent(q.get('key'))}` : '';
const api = (p) => p + (KEY ? (p.includes('?') ? '&' : '?') + KEY : '');
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
$('#view').href = api('/'); $('#launch').href = api('/launch.html');

let layout, catalog = [], presets = [], venues = [], cur = 0, curView = -1, showPicker = false, unusedOnly = false;
const SC = () => (curView < 0 ? layout.screens : layout.views[curView].screens);   // screens of the view being edited (-1 = Main)
const def = (t) => catalog.find((c) => c.type === t);

async function load() {
  const [c, k] = await Promise.all([fetch(api('/api/config')).then((r) => r.json()), fetch(api('/api/catalog')).then((r) => r.json())]);
  layout = c.layout; venues = c.venues || []; catalog = k.widgets; presets = k.presets || [];
  if (!c.canAdmin) say('Read-only: editing requires localhost or ?key=<NOC_ADMIN_KEY>', 'bad');
  render();
}
function say(t, cls = 'ok') { const m = $('#msg'); m.textContent = t; m.className = cls; }

// type -> { total: uses across all screens, here: uses on the current screen, where: [screen names] }
function usage() {
  const u = new Map();
  const groups = [['Main', layout.screens, -1], ...(layout.views || []).map((v, vi) => [v.name, v.screens, vi])];
  for (const [vname, screens, vi] of groups) screens.forEach((sc, si) => sc.widgets.forEach((w) => {
    const e = u.get(w.type) || { total: 0, here: 0, where: [] };
    e.total++; if (vi === curView && si === cur) e.here++;
    const label = vname === 'Main' ? sc.name : `${vname} › ${sc.name}`; if (!e.where.includes(label)) e.where.push(label);
    u.set(w.type, e);
  }));
  return u;
}

function thresholdsHtml(w) {
  const th = w.thresholds || {};
  const row = (k, label) => `<label>${label}<span class="thr"><select data-th="${k}.op">${['>=', '>', '<=', '<'].map((o) => `<option ${((th[k] || {}).op || (k === 'crit' ? '>=' : '>=')) === o ? 'selected' : ''}>${o}</option>`).join('')}</select><input data-th="${k}.val" type="number" step="any" placeholder="off" value="${th[k] && th[k].val != null ? th[k].val : ''}"></span></label>`;
  return `<div class="thr-group" title="Colour this scorecard by its value. Leave blank to turn a level off.">${row('warn', 'Amber when value')}${row('crit', 'Red when value')}</div>`;
}

function renderSchedules() {
  const names = ['Main', ...layout.views.map((v) => v.name)];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  $('#schedBody').innerHTML = (layout.schedules.length ? '' : '<p style="color:var(--muted)">No schedules — the Main view is always shown (displays can still pick a view with the dropdown or <code>?view=Name</code>).</p>') +
    layout.schedules.map((x, i) => `<div class="wrow" data-si="${i}">
      <label>Show view<select data-sf="view">${names.map((n) => `<option ${n === x.view ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <label>From<input data-sf="from" type="time" value="${x.from}"></label><label>To<input data-sf="to" type="time" value="${x.to}"></label>
      <div class="days">${days.map((dn, di) => `<label class="inline"><input type="checkbox" data-sd="${di}" ${x.days.includes(di) ? 'checked' : ''}>${dn}</label>`).join('')}</div>
      <label class="inline"><input type="checkbox" data-sf="enabled" ${x.enabled ? 'checked' : ''}> On</label>
      <button data-act="delsched" class="danger">Remove</button></div>`).join('') +
    `<button data-act="addsched" ${layout.views.length ? '' : 'disabled title="Create a view first"'}>+ Add schedule</button> <span style="color:var(--faint);font-size:.85rem">First matching schedule wins · server local time · a window like 18:00 → 06:00 runs overnight.</span>`;
}

function render() {
  $('#title').value = layout.title; $('#rot').value = layout.rotateSeconds;
  const vtabs = [['Main', -1], ...layout.views.map((v, i) => [v.name, i])];
  $('#views').innerHTML = vtabs.map(([n, i]) => `<button data-view="${i}" class="${i === curView ? 'on' : ''}">${esc(n)}</button>`).join('') + '<button data-act="addview" title="Create a new view (copy of the current one)">+ View</button>' +
    (curView >= 0 ? ` <label class="inline">Name <input id="vname" value="${esc(layout.views[curView].name)}" maxlength="40" style="width:11rem"></label> <label class="inline">Rotate every <input id="vrot" type="number" min="0" max="3600" value="${layout.views[curView].rotateSeconds}" style="width:4.5rem"> s</label> <button data-act="delview" class="danger">Delete view</button>` : '');
  renderSchedules();
  $('#tabs').innerHTML = SC().map((s, i) => `<button data-tab="${i}" class="${i === cur ? 'on' : ''}">${esc(s.name)}</button>`).join('') + '<button data-act="addscreen">+ Screen</button>' + (presets.length ? `<select id="preset"><option value="">+ Preset screen…</option>${presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select>` : '');
  const s = SC()[cur];
  const venueOpts = (sel) => `<option value="">All venues</option>` + venues.map((v) => `<option value="${esc(v.id)}" ${v.id === sel ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
  $('#screen').innerHTML = `
    <div style="display:flex;gap:.6rem;align-items:flex-end;margin-bottom:.8rem;flex-wrap:wrap">
      <label>Screen name<input id="sname" value="${esc(s.name)}" maxlength="40"></label>
      <label title="Spread this screen's widgets across several displays. Each display opens /?display=N and all rotate together.">Displays<input id="sdisp" type="number" min="1" max="6" value="${s.displays || 1}"></label>
      <label ${(s.displays || 1) > 1 ? '' : 'style="opacity:.45"'} title="Auto: widgets are cut into groups of similar size, in order. Manual: choose a display for each widget below.">Split<select id="ssplit"><option value="auto" ${s.split !== 'manual' ? 'selected' : ''}>Auto (balanced)</option><option value="manual" ${s.split === 'manual' ? 'selected' : ''}>Manual</option></select></label>
      <label class="inline" title="Tile this screen with no gaps: widgets keep their order, each row is stretched to the full width and one height. Turn off to use the exact widths/heights below."><input type="checkbox" id="autofit" ${s.auto !== false ? 'checked' : ''}> Auto-fit (no gaps)</label>
      <button data-act="left">◀ Move</button><button data-act="right">Move ▶</button>
      <button data-act="delscreen" class="danger">Delete screen</button>
    </div>
    ${s.widgets.map((w, i) => { const d = def(w.type) || { title: w.type, params: [] }; return `
      <div class="wrow" data-i="${i}">
        <div class="ttl">${esc(d.title)}<small>${esc(w.type)}</small></div>
        <label>Venue<select data-f="venue">${venueOpts(w.venue)}</select></label>
        ${(s.displays || 1) > 1 && s.split === 'manual' ? `<label>Display<select data-f="display">${Array.from({ length: s.displays }, (_, k) => `<option value="${k + 1}" ${(w.display || 1) === k + 1 ? 'selected' : ''}>Display ${k + 1}</option>`).join('')}</select></label>` : ''}
        <label>Width (1–12)<input data-f="w" type="number" min="1" max="12" value="${w.w}"></label>
        <label>Height (rows)<input data-f="h" type="number" min="1" max="10" value="${w.h}"></label>
        ${d.params.map((p) => `<label>${esc(p.label)}<input data-p="${p.name}" type="number" min="1" value="${w.params[p.name] ?? p.default}"></label>`).join('')}
        ${d.numeric ? thresholdsHtml(w) : ''}
        <button data-act="up" title="Move earlier">↑</button><button data-act="down" title="Move later">↓</button><button data-act="del" class="danger">Remove</button>
      </div>`; }).join('') || '<p style="color:var(--muted)">No widgets on this screen yet.</p>'}
    <button data-act="addw">${showPicker ? '− Hide' : '+ Add widget'}</button>
    ${showPicker ? pickerHtml() : ''}`;
}

let pickQ = '';
const openGroups = new Set();
function pickBtn(c, u) {
  const e = u.get(c.type);
  const tag = e ? `<span class="tag used" title="Used on: ${esc(e.where.join(', '))}">in use ×${e.total}${e.here ? ` · ${e.here} here` : ''}</span>` : '<span class="tag">unused</span>';
  return `<button data-add="${esc(c.type)}" class="${e ? 'is-used' : ''}" title="${esc(c.type)}"><span>${esc(c.title)}</span>${tag}</button>`;
}
function pickerBody() {
  const u = usage();
  const terms = pickQ.toLowerCase().split(/\s+/).filter(Boolean);
  const items = catalog.filter((c) => (!unusedOnly || !u.has(c.type)) && terms.every((t) => `${c.title} ${c.group} ${c.sub} ${c.type}`.toLowerCase().includes(t)));
  if (!items.length) return '<p style="color:var(--muted)">No widgets match.</p>';
  return [...new Set(items.map((c) => c.group))].map((g) => {
    const gi = items.filter((c) => c.group === g);
    const used = gi.filter((c) => u.has(c.type)).length;
    const open = terms.length || openGroups.has(g);
    const body = [...new Set(gi.map((c) => c.sub))].map((sb) => (sb ? `<h4>${esc(sb)}</h4>` : '') + gi.filter((c) => c.sub === sb).map((c) => pickBtn(c, u)).join('')).join('');
    return `<details class="pgroup" data-g="${esc(g)}" ${open ? 'open' : ''}><summary>${esc(g)} <span class="cnt">${gi.length}${used ? ` · ${used} in use` : ''}</span></summary><div class="picker">${body}</div></details>`;
  }).join('');
}
function pickerHtml() {
  const u = usage();
  const inUse = catalog.filter((c) => u.has(c.type)).length;
  return `<div class="picker-head"><strong>${inUse} of ${catalog.length}</strong> widgets in use
      <input id="pq" type="search" placeholder="Search ${catalog.length} widgets…  try: dpsk, vlan, poe, guest, ssid" value="${esc(pickQ)}">
      <label class="inline"><input type="checkbox" id="unusedOnly" ${unusedOnly ? 'checked' : ''}> Unused only</label></div>
    <div id="pickerBody">${pickerBody()}</div>`;
}
document.addEventListener('input', (e) => {
  const th = e.target.dataset && e.target.dataset.th;
  if (th) {
    const [k, f] = th.split('.'); const w = SC()[cur].widgets[Number(e.target.closest('.wrow').dataset.i)];
    w.thresholds = w.thresholds || {};
    const sel = e.target.closest('.thr'); const op = sel.querySelector('select').value; const raw = sel.querySelector('input').value;
    if (raw === '') delete w.thresholds[k]; else w.thresholds[k] = { op, val: Number(raw) };
    if (!w.thresholds.warn && !w.thresholds.crit) delete w.thresholds;
    return;
  }
  const sf = e.target.dataset && e.target.dataset.sf;
  if (sf) { const x = layout.schedules[Number(e.target.closest('.wrow').dataset.si)]; x[sf] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; return; }
  if (e.target.dataset && e.target.dataset.sd !== undefined) { const x = layout.schedules[Number(e.target.closest('.wrow').dataset.si)]; const d = Number(e.target.dataset.sd); x.days = e.target.checked ? [...new Set([...x.days, d])].sort() : x.days.filter((y) => y !== d); return; } if (e.target.id === 'pq') { pickQ = e.target.value; $('#pickerBody').innerHTML = pickerBody(); } });
document.addEventListener('toggle', (e) => { const d = e.target; if (d.classList && d.classList.contains('pgroup') && !pickQ) { if (d.open) openGroups.add(d.dataset.g); else openGroups.delete(d.dataset.g); } }, true);

document.addEventListener('change', (e) => {
  if (e.target.tagName === 'SELECT' && e.target.dataset && (e.target.dataset.th || e.target.dataset.sf)) { e.target.dispatchEvent(new Event('input', { bubbles: true })); return; }
  if (e.target.id === 'sdisp') { const sc = SC()[cur]; sc.displays = Math.max(1, Math.min(6, Number(e.target.value) || 1)); sc.widgets.forEach((w) => { if ((w.display || 1) > sc.displays) w.display = sc.displays; }); render(); return; }
  if (e.target.id === 'ssplit') { SC()[cur].split = e.target.value; render(); return; }
  if (e.target.id === 'autofit') { SC()[cur].auto = e.target.checked; return; }
  if (e.target.id === 'preset' && e.target.value !== '') {
    const pr = presets[Number(e.target.value)];
    SC().push({ name: pr.name, widgets: pr.widgets.map((x) => ({ type: x.type, venue: '', w: x.w || (catalog.find((c) => c.type === x.type) || {}).w || 3, h: x.h || (catalog.find((c) => c.type === x.type) || {}).h || 2, params: {} })) });
    cur = SC().length - 1; render(); say(`Added "${pr.name}" — click Save & apply to keep it.`); return;
  } if (e.target.id === 'unusedOnly') { unusedOnly = e.target.checked; render(); } });

document.addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const s = SC()[cur]; const row = t.closest('.wrow'); const i = row ? Number(row.dataset.i) : -1;
  if (t.dataset.act === 'addsched') { layout.schedules.push({ view: layout.views[0].name, days: [0, 1, 2, 3, 4, 5, 6], from: '18:00', to: '06:00', enabled: true }); renderSchedules(); return; }
  if (t.dataset.act === 'delsched') { layout.schedules.splice(Number(t.closest('.wrow').dataset.si), 1); renderSchedules(); return; }
  if (t.dataset.view !== undefined) { curView = Number(t.dataset.view); cur = 0; showPicker = false; }
  else if (t.dataset.act === 'addview') { const base = JSON.parse(JSON.stringify(SC())); layout.views.push({ name: `View ${layout.views.length + 1}`, rotateSeconds: layout.rotateSeconds, screens: base }); curView = layout.views.length - 1; cur = 0; say('New view created from a copy of the current one — rename it, then Save & apply.'); }
  else if (t.dataset.act === 'delview') { if (confirm(`Delete view "${layout.views[curView].name}" and its schedules?`)) { const gone = layout.views[curView].name; layout.views.splice(curView, 1); layout.schedules = layout.schedules.filter((x) => x.view !== gone); curView = -1; cur = 0; } }
  else if (t.dataset.tab) { cur = Number(t.dataset.tab); showPicker = false; }
  else if (t.dataset.add) { const d = def(t.dataset.add); s.widgets.push({ type: d.type, venue: '', w: d.w, h: d.h, params: {} }); }
  else if (t.dataset.act === 'addscreen') { SC().push({ name: `Screen ${SC().length + 1}`, widgets: [] }); cur = SC().length - 1; }
  else if (t.dataset.act === 'delscreen') { if (SC().length > 1 && confirm(`Delete screen "${s.name}"?`)) { SC().splice(cur, 1); cur = Math.max(0, cur - 1); } }
  else if (t.dataset.act === 'left' && cur > 0) { [SC()[cur - 1], SC()[cur]] = [SC()[cur], SC()[cur - 1]]; cur--; }
  else if (t.dataset.act === 'right' && cur < SC().length - 1) { [SC()[cur + 1], SC()[cur]] = [SC()[cur], SC()[cur + 1]]; cur++; }
  else if (t.dataset.act === 'addw') showPicker = !showPicker;
  else if (t.dataset.act === 'up' && i > 0) [s.widgets[i - 1], s.widgets[i]] = [s.widgets[i], s.widgets[i - 1]];
  else if (t.dataset.act === 'down' && i < s.widgets.length - 1) [s.widgets[i + 1], s.widgets[i]] = [s.widgets[i], s.widgets[i + 1]];
  else if (t.dataset.act === 'del') s.widgets.splice(i, 1);
  else return;
  render();
});
document.addEventListener('input', (e) => {
  const s = SC()[cur]; const el = e.target;
  if (el.id === 'pq') return;
  if (el.id === 'vname') { const old = layout.views[curView].name; layout.views[curView].name = el.value; layout.schedules.forEach((x) => { if (x.view === old) x.view = el.value; }); const b = document.querySelector(`[data-view="${curView}"]`); if (b) b.textContent = el.value || '…'; return; }
  if (el.id === 'vrot') { layout.views[curView].rotateSeconds = Number(el.value); return; }
  if (el.id === 'sname') { s.name = el.value; const b = document.querySelector(`[data-tab="${cur}"]`); if (b) b.textContent = el.value || '…'; return; }
  if (el.id === 'title') { layout.title = el.value; return; }
  if (el.id === 'rot') { layout.rotateSeconds = Number(el.value); return; }
  const row = el.closest('.wrow'); if (!row) return; const w = s.widgets[Number(row.dataset.i)];
  if (el.dataset.f) w[el.dataset.f] = el.dataset.f === 'venue' ? el.value : Number(el.value);   // venue is a string; w/h/display are numbers
  if (el.dataset.p) w.params[el.dataset.p] = Number(el.value);
});
$('#save').addEventListener('click', async () => {
  const r = await fetch(api('/api/config'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layout) });
  const j = await r.json();
  if (!r.ok) return say(j.error || 'Save failed', 'bad');
  layout = j.layout; say(`Saved — ${new Date().toLocaleTimeString()}. Viewers update live.`); render();
});
load();

// ---------- R1 connection settings ----------
const REGIONS = ['https://api.ruckus.cloud', 'https://api.eu.ruckus.cloud', 'https://api.asia.ruckus.cloud'];
const sMsg = (t, cls = 'ok') => { const m = $('#s_msg'); m.textContent = t; m.className = cls; };
function fillSettings(s) {
  $('#s_tenant').value = s.tenantId; $('#s_client').value = s.clientId; $('#s_secret').value = '';
  $('#s_secret').placeholder = s.secretSet ? '•••••••• (saved — leave blank to keep)' : '(not set)';
  $('#s_api').value = s.apiBase; $('#s_oauth').value = s.oauthBase; $('#s_poll').value = s.pollSeconds;
  $('#s_region').value = REGIONS.includes(s.apiBase) && s.apiBase === s.oauthBase ? s.apiBase : 'custom';
  const ok = s.tenantId && s.clientId && s.secretSet;
  $('#connState').textContent = s.demo ? 'DEMO mode — synthetic data' : ok ? 'configured' : 'not configured';
  if (!ok && !s.demo) $('#conn').open = true;
}
async function loadSettings() {
  const r = await fetch(api('/api/settings'));
  if (r.ok) fillSettings(await r.json()); else $('#connState').textContent = 'admin access required';
}
$('#s_region').addEventListener('change', (e) => { if (e.target.value !== 'custom') { $('#s_api').value = e.target.value; $('#s_oauth').value = e.target.value; } });
$('#s_save').addEventListener('click', async () => {
  const body = { tenantId: $('#s_tenant').value, clientId: $('#s_client').value, clientSecret: $('#s_secret').value, apiBase: $('#s_api').value, oauthBase: $('#s_oauth').value, pollSeconds: $('#s_poll').value };
  const r = await fetch(api('/api/settings'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) return sMsg(j.error || 'Save failed', 'bad');
  fillSettings(j); sMsg('Saved — polling with the new settings. Use Test connection to verify.');
});
$('#s_test').addEventListener('click', async () => {
  sMsg('Testing…', ''); $('#s_test').disabled = true;
  try {
    const j = await (await fetch(api('/api/settings/test'), { method: 'POST' })).json();
    if (j.ok) sMsg(`Connected — ${j.venues} venue${j.venues === 1 ? '' : 's'}${j.sample.length ? ': ' + j.sample.join(', ') : ''}`); else sMsg(j.error, 'bad');
  } catch (e) { sMsg(e.message, 'bad'); }
  $('#s_test').disabled = false;
});
loadSettings();

$('#s_diag').addEventListener('click', async () => {
  const pre = $('#diag'); pre.style.display = 'block'; pre.textContent = 'Loading…';
  const j = await (await fetch(api('/api/diagnostics'))).json();
  pre.textContent = JSON.stringify(j, null, 2);
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('Replace ALL screens, widgets, views and schedules with the built-in defaults? Unsaved edits here are lost, and every connected viewer changes immediately.')) return;
  const r = await fetch(api('/api/config/reset'), { method: 'POST' });
  const j = await r.json();
  if (!r.ok) return say(j.error || 'Reset failed', 'bad');
  layout = j.layout; cur = 0; curView = -1; showPicker = false; render(); say('Reset to defaults.');
});
