'use strict';
// Editor panel: scrolling ticker — custom messages + news / weather / quote feeds. Uses $, esc, api from admin.js.
let tk = { enabled: true, speed: 70, showStatus: true, messages: [], feeds: [] }, tkStatus = {}, tkPreview = {};
const sel = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
// How many displays this dashboard uses (playlists / spread screens) — at least 2 so the choice is always visible.
const tkDisplays = () => { try { const sets = [layout, ...(layout.views || [])]; return Math.max(2, ...sets.map((v) => (v.playlists || []).length), ...sets.flatMap((v) => v.screens.map((x) => x.displays || 1))); } catch { return 2; } };
function showOn(item, kind, idx) {
  const all = !item.displays || !item.displays.length; const n = tkDisplays();
  return `<div class="dpick" style="flex-basis:100%;font-size:.85rem;color:var(--muted)">Show on: <label class="inline"><input type="checkbox" data-dall="${kind}:${idx}" ${all ? 'checked' : ''}> all displays</label>${all ? '' : Array.from({ length: n }, (_, k) => `<label class="inline"><input type="checkbox" data-dn="${kind}:${idx}:${k + 1}" ${item.displays.includes(k + 1) ? 'checked' : ''}> display ${k + 1}</label>`).join('')}</div>`;
}
const FEED_TYPES = [['rss', 'News (RSS / Atom)'], ['weather', 'Weather'], ['stocks', 'Stock / market quotes']];

function renderTicker() {
  const el = $('#tkBody'); if (!el) return;
  el.innerHTML = `
    <div class="wrow" style="margin-bottom:.8rem">
      <label class="inline"><input type="checkbox" data-to="enabled" ${tk.enabled ? 'checked' : ''}> Show messages &amp; feeds in the ticker</label>
      <label>Text size<select data-to="size">${sel([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large (default)'], ['xl', 'Extra large']], tk.size || 'large')}</select></label>
      <label>Scroll speed<select data-to="speed">${sel([['35', 'Slow'], ['70', 'Normal'], ['120', 'Fast'], ['200', 'Very fast']], String(tk.speed))}</select></label>
      <label class="inline"><input type="checkbox" data-to="showStatus" ${tk.showStatus ? 'checked' : ''}> Show an "all clear" status line when there is nothing else</label>
      <span style="flex:1"></span><span style="color:var(--muted);font-size:.85rem">Live alerts always scroll first. Full-screen sign: <a class="chip" href="${api('/?mode=ticker')}" target="_blank">/?mode=ticker</a></span>
    </div>
    <h4 style="margin:.4rem 0;color:var(--muted)">Per-display settings <span style="font-weight:400;font-size:.8rem">(leave on “Same as above” to inherit)</span></h4>
    <div class="wrow" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(25rem,1fr));gap:.6rem">${Array.from({ length: tkDisplays() }, (_, k) => { const d = k + 1; const o = (tk.perDisplay || {})[d] || {};
      return `<div style="border:1px solid var(--line);border-radius:.5rem;padding:.5rem .7rem" data-pd="${d}"><b>Display ${d}</b>${d === 1 ? ' <span style="color:var(--faint);font-size:.8rem">(also a viewer with no ?display=)</span>' : ''}<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.4rem">
        <label title="Off hides messages and feeds on this display. Live alerts still scroll unless you also hide alerts.">Messages &amp; feeds<select data-pdf="enabled">${sel([['', 'Same as above'], ['on', 'On'], ['off', 'Off']], o.enabled === undefined ? '' : o.enabled ? 'on' : 'off')}</select></label>
        <label>Text size<select data-pdf="size">${sel([['', 'Same as above'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xl', 'Extra large']], o.size || '')}</select></label>
        <label>Speed<select data-pdf="speed">${sel([['', 'Same as above'], ['35', 'Slow'], ['70', 'Normal'], ['120', 'Fast'], ['200', 'Very fast']], o.speed ? String(o.speed) : '')}</select></label>
        <label title="Hide alerts (ticker AND full-screen takeover) on a public-facing display">Alerts<select data-pdf="alerts">${sel([['', 'Same as above (shown)'], ['hide', 'Hide on this display']], o.alerts === false ? 'hide' : '')}</select></label></div></div>`; }).join('')}</div>
    <h4 style="margin:.9rem 0 .4rem;color:var(--muted)">Custom messages</h4>
    ${tk.messages.map((m, i) => `<div class="wrow" data-mi="${i}">
      <label class="inline"><input type="checkbox" data-mf="enabled" ${m.enabled ? 'checked' : ''}> On</label>
      <label style="flex:1 1 22rem">Message<input data-mf="text" value="${esc(m.text)}" maxlength="300" style="width:100%" placeholder="e.g. Planned maintenance Saturday 2–4 AM"></label>
      <label>Style<select data-mf="tone">${sel([['info', 'Normal'], ['ok', 'Good news (green)'], ['warn', 'Notice (amber)'], ['bad', 'Urgent (red)']], m.tone)}</select></label>
      <label>Show from<input type="datetime-local" data-mf="from" value="${esc(m.from)}"></label><label>Until<input type="datetime-local" data-mf="to" value="${esc(m.to)}"></label>
      <button data-mact="del" class="danger">Remove</button>${showOn(m, 'm', i)}</div>`).join('') || '<p style="color:var(--muted)">No messages. Messages also appear in the “Message board” widget.</p>'}
    <button id="addMsg">+ Add message</button>
    <h4 style="margin:1rem 0 .4rem;color:var(--muted)">Feeds</h4>
    ${tk.feeds.map((f, i) => { const st = tkStatus[f.id]; const pv = tkPreview[f.id];
      const fields = f.type === 'rss'
        ? `<label style="flex:1 1 24rem">Feed URL<input data-ff="url" value="${esc(f.url || '')}" style="width:100%" placeholder="https://feeds.bbci.co.uk/news/rss.xml"></label><label>Headlines<input data-ff="maxItems" type="number" min="1" max="30" value="${f.maxItems || 8}" style="width:5rem"></label>`
        : f.type === 'weather'
          ? `<label>Place<input data-ff="place" value="${esc(f.place || '')}" style="width:14rem" placeholder="Tampa, FL"></label><label>Units<select data-ff="units">${sel([['f', '°F / mph'], ['c', '°C / km/h']], f.units || 'f')}</select></label>${f.label ? `<span style="color:var(--muted);font-size:.85rem;align-self:flex-end">→ ${esc(f.label)}</span>` : ''}`
          : `<label style="flex:1 1 24rem">Symbols (comma-separated)<input data-ff="symbols" value="${esc(f.symbols || '')}" style="width:100%" placeholder="AAPL, MSFT, ^GSPC, EURUSD=X, BTC-USD"></label>`;
      return `<div class="wrow" data-fi="${i}">
        <label class="inline"><input type="checkbox" data-ff="enabled" ${f.enabled ? 'checked' : ''}> On</label>
        <label>Name<input data-ff="name" value="${esc(f.name || '')}" maxlength="40" style="width:10rem" placeholder="optional label"></label>
        <label>Type<select data-ff="type">${sel(FEED_TYPES, f.type)}</select></label>${fields}
        <label>Refresh (min)<input data-ff="refreshMinutes" type="number" min="1" max="1440" value="${f.refreshMinutes}" style="width:5rem"></label>
        <button data-fact="test">Test</button><button data-fact="del" class="danger">Remove</button>${showOn(f, 'f', i)}
        <div style="flex-basis:100%;font-size:.85rem">${pv ? (pv.ok ? `<span class="ok">Preview:</span> ${pv.lines.map((l) => esc(l)).join(' &nbsp;·&nbsp; ')}` : `<span class="bad">${esc(pv.error)}</span>`) : st ? (st.error ? `<span class="bad">Last fetch failed: ${esc(st.error)}</span>` : st.at ? `<span class="ok">Updated ${new Date(st.at).toLocaleTimeString()}</span>` : '') : ''}</div></div>`; }).join('') || '<p style="color:var(--muted)">No feeds yet.</p>'}
    <button id="addFeed">+ Add feed</button>
    <p style="color:var(--faint);font-size:.82rem;margin:.7rem 0 0">Weather: Open-Meteo. Quotes: Yahoo Finance's free chart service — delayed, unofficial, and may change without notice. Your server needs internet access to reach these. Feed widgets (news, weather, quotes, message board) are in the widget picker under <b>Ticker &amp; feeds</b>.</p>`;
}
async function loadTicker() { const r = await fetch(api('/api/ticker')); if (!r.ok) return; const j = await r.json(); tk = j.config; tkStatus = j.status || {}; renderTicker(); }
const tmsg = (t, cls = 'ok') => { const e = $('#tkMsg'); e.textContent = t; e.className = cls; };
async function saveTicker() {
  const r = await fetch(api('/api/ticker'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tk) }); const j = await r.json();
  if (!r.ok) { tmsg(j.error || 'Save failed', 'bad'); return false; } tk = j.config; tkStatus = j.status || {}; tkPreview = {}; renderTicker(); tmsg(`Saved — ${new Date().toLocaleTimeString()}. Feeds refresh within a minute.`); return true;
}
document.addEventListener('input', (e) => {
  const t = e.target; if (!t.dataset) return; const row = t.closest('.wrow');
  if (t.dataset.to) { const k = t.dataset.to; tk[k] = t.type === 'checkbox' ? t.checked : k === 'speed' ? Number(t.value) : t.value; return; }
  if (t.dataset.mf) { const m = tk.messages[Number(row.dataset.mi)]; m[t.dataset.mf] = t.type === 'checkbox' ? t.checked : t.value; return; }
  if (t.dataset.ff) { const f = tk.feeds[Number(row.dataset.fi)]; const k = t.dataset.ff; f[k] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value; if (k === 'place') { f.lat = null; f.lon = null; f.label = ''; } if (k === 'type') { f.refreshMinutes = f.type === 'stocks' ? 5 : f.type === 'weather' ? 30 : 15; renderTicker(); } }
});
document.addEventListener('change', (e) => {
  const t = e.target; if (!t.dataset) return;
  if (t.dataset.pdf) {   // per-display override: '' = inherit
    const d = Number(t.closest('[data-pd]').dataset.pd); tk.perDisplay = tk.perDisplay || {}; const o = (tk.perDisplay[d] = tk.perDisplay[d] || {}); const f = t.dataset.pdf; const v = t.value;
    if (f === 'enabled') { if (v === '') delete o.enabled; else o.enabled = v === 'on'; } else if (f === 'alerts') { if (v === '') delete o.alerts; else o.alerts = false; } else if (f === 'speed') { if (v === '') delete o.speed; else o.speed = Number(v); } else if (v === '') delete o[f]; else o[f] = v;
    if (!Object.keys(o).length) delete tk.perDisplay[d]; return;
  }
  const pick = (kind, idx) => (kind === 'm' ? tk.messages : tk.feeds)[Number(idx)];
  if (t.dataset.dall) { const [k, i] = t.dataset.dall.split(':'); const it = pick(k, i); it.displays = t.checked ? [] : [1]; renderTicker(); }
  else if (t.dataset.dn) { const [k, i, d] = t.dataset.dn.split(':'); const it = pick(k, i); const set = new Set(it.displays || []); if (t.checked) set.add(Number(d)); else set.delete(Number(d)); it.displays = [...set].sort((a, b) => a - b); renderTicker(); }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'addMsg') { tk.messages.push({ id: '', enabled: true, text: '', tone: 'info', from: '', to: '' }); renderTicker(); }
  else if (b.id === 'addFeed') { tk.feeds.push({ id: '', type: 'rss', enabled: true, name: '', url: '', maxItems: 8, refreshMinutes: 15 }); renderTicker(); }
  else if (b.id === 'saveTicker') saveTicker();
  else if (b.dataset.mact === 'del') { tk.messages.splice(Number(b.closest('.wrow').dataset.mi), 1); renderTicker(); }
  else if (b.dataset.fact === 'del') { tk.feeds.splice(Number(b.closest('.wrow').dataset.fi), 1); renderTicker(); }
  else if (b.dataset.fact === 'test') {
    const i = Number(b.closest('.wrow').dataset.fi); const f = tk.feeds[i]; b.textContent = 'Testing…'; b.disabled = true;
    const j = await (await fetch(api('/api/ticker/test'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) })).json();
    if (j.ok && j.resolved) Object.assign(f, j.resolved);
    tkPreview[f.id || `i${i}`] = j; if (!f.id) f.id = `i${i}`; renderTicker();
  }
});
loadTicker();
