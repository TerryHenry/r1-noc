'use strict';
// Editor panel: MSP customers (one R1 tenant + API application each). Uses $, esc, api from admin.js.
let msp = [];
const mspMsg = (t, cls = 'ok') => { const m = $('#mspMsg'); m.textContent = t; m.className = cls; };
const MSP_REGIONS = [['https://api.ruckus.cloud', 'North America'], ['https://api.eu.ruckus.cloud', 'Europe'], ['https://api.asia.ruckus.cloud', 'Asia']];
function renderMsp() {
  $('#mspRows').innerHTML = msp.map((c, i) => `<div class="top" style="border-top:1px solid var(--line);padding-top:.6rem;margin-top:.6rem" data-i="${i}">
    <label>Customer name<input data-m="name" value="${esc(c.name)}" size="22"></label>
    <label>Tenant ID<input data-m="tenantId" value="${esc(c.tenantId)}" size="32" autocomplete="off" spellcheck="false"></label>
    <label>Client ID<input data-m="clientId" value="${esc(c.clientId)}" size="28" autocomplete="off" spellcheck="false"></label>
    <label>Client secret<input data-m="clientSecret" type="password" size="24" autocomplete="new-password" placeholder="${c.secretSet ? '•••••••• (saved)' : '(not set)'}"></label>
    <label>Region<select data-m="apiBase">${MSP_REGIONS.map(([u, l]) => `<option value="${u}" ${u === c.apiBase ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="inline"><input type="checkbox" data-m="enabled" ${c.enabled !== false ? 'checked' : ''}> Enabled</label>
    <button data-mt="${i}" ${c.id ? '' : 'disabled title="Save first"'}>Test</button><button class="danger" data-mr="${i}">Remove</button><span data-ms="${i}"></span></div>`).join('');
}
let mspAcct = { enabled: false, exclude: [] };
function renderFound(info) {
  const box = $('#mspFound'); if (!info) { box.innerHTML = ''; return; }
  if (info.error) { box.innerHTML = `<div class="bad">${esc(info.error)}</div>`; return; }
  const l = info.customers || []; if (!info.enabled && !l.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div style="color:var(--muted);font-size:.85rem">${l.length} customer${l.length === 1 ? '' : 's'} found. Untick any you don't want on the wall:</div>
    <div style="display:flex;flex-wrap:wrap;gap:.3rem 1.2rem;margin:.3rem 0">${l.map((c) => `<label class="inline" style="text-transform:none;letter-spacing:0;font-size:.9rem;color:var(--text)"><input type="checkbox" data-ex="${esc(c.id)}" ${c.excluded ? '' : 'checked'}> ${esc(c.name)} <small style="color:var(--muted)">${esc(c.status)}${c.accountType ? ' · ' + esc(c.accountType) : ''}</small></label>`).join('')}</div>
    <button id="mspExSave">Save selection</button> <span id="mspExMsg"></span>`;
}
async function loadMsp() {
  const r = await fetch(api('/api/settings')); if (!r.ok) return; const j = await r.json(); msp = j.customers || []; mspAcct = j.msp || mspAcct; renderMsp();
  $('#mspT').value = mspAcct.tenantId || ''; $('#mspC').value = mspAcct.clientId || ''; $('#mspS').placeholder = mspAcct.secretSet ? '•••••••• (saved)' : '(not set)'; if (mspAcct.apiBase && [...$('#mspR').options].some((o) => o.value === mspAcct.apiBase)) $('#mspR').value = mspAcct.apiBase;
  if (j.mode === 'msp') { try { renderFound(await (await fetch(api('/api/msp'))).json()); } catch { /* ignore */ } }
}
$('#mspAcctSave').addEventListener('click', async () => {
  const set = (t, c = 'ok') => { const m = $('#mspAcctMsg'); m.textContent = ' ' + t; m.className = c; };
  try {
    const body = { mode: 'msp', pollSeconds: $('#s_poll').value, msp: { tenantId: $('#mspT').value, clientId: $('#mspC').value, clientSecret: $('#mspS').value, apiBase: $('#mspR').value, oauthBase: $('#mspR').value } };
    const r = await fetch(api('/api/settings'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Save failed');
    $('#mspS').value = ''; mspAcct = j.msp; loadSettingsState(j);
    set('Saved — looking for customers…', ''); const info = await (await fetch(api('/api/msp/refresh'), { method: 'POST' })).json(); renderFound(info);
    set(info.error ? '' : `Found ${(info.customers || []).length} customer(s)`, info.error ? 'bad' : 'ok');
  } catch (e) { set(e.message, 'bad'); }
});
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'mspExSave') return;
  const ex = [...document.querySelectorAll('[data-ex]')].filter((c) => !c.checked).map((c) => c.dataset.ex);
  try { const r = await fetch(api('/api/settings'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msp: { exclude: ex } }) }); if (!r.ok) throw new Error('Save failed'); $('#mspExMsg').textContent = ' Saved'; $('#mspExMsg').className = 'ok'; } catch (er) { $('#mspExMsg').textContent = ' ' + er.message; $('#mspExMsg').className = 'bad'; }
});
$('#mspRows').addEventListener('input', (e) => {
  const row = e.target.closest('[data-i]'); const f = e.target.dataset.m; if (!row || !f) return; const c = msp[Number(row.dataset.i)];
  if (f === 'enabled') c.enabled = e.target.checked; else if (f === 'apiBase') { c.apiBase = e.target.value; c.oauthBase = e.target.value; } else c[f] = e.target.value;
});
$('#mspAdd').addEventListener('click', () => { msp.push({ id: '', name: 'New customer', tenantId: '', clientId: '', apiBase: MSP_REGIONS[0][0], oauthBase: MSP_REGIONS[0][0], enabled: true }); renderMsp(); });
$('#mspRows').addEventListener('click', async (e) => {
  const rm = e.target.dataset.mr, ts = e.target.dataset.mt;
  if (rm !== undefined) { msp.splice(Number(rm), 1); renderMsp(); return; }
  if (ts !== undefined) {
    const c = msp[Number(ts)]; const out = $(`[data-ms="${ts}"]`); out.textContent = ' testing…';
    try { const j = await (await fetch(api(`/api/settings/test?customer=${encodeURIComponent(c.id)}`), { method: 'POST' })).json(); out.textContent = j.ok ? ` ✓ ${j.venues} venue${j.venues === 1 ? '' : 's'}${j.sample.length ? ': ' + j.sample.join(', ') : ''}` : ` ✗ ${j.error}`; out.className = j.ok ? 'ok' : 'bad'; } catch (err) { out.textContent = ' ✗ ' + err.message; out.className = 'bad'; }
  }
});
$('#mspSave').addEventListener('click', async () => {
  const r = await fetch(api('/api/settings'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'customers', pollSeconds: $('#s_poll').value, customers: msp }) });
  const j = await r.json(); if (!r.ok) return mspMsg(j.error || 'Save failed', 'bad');
  msp = j.customers || []; renderMsp(); if (typeof fillSettings === 'function') fillSettings(j); mspMsg(msp.length ? 'Saved — polling every customer. Use Test on each row to verify.' : 'Saved — back to the single connection.');
});
loadMsp();

function loadSettingsState(j) { if (typeof fillSettings === 'function') fillSettings(j); }
