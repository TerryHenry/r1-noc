'use strict';
// Editor panel: MSP customers (one R1 tenant + API application each). Uses $, esc, api from admin.js.
let msp = [];
const mspMsg = (t, cls = 'ok') => { const m = $('#mspMsg'); m.textContent = t; m.className = cls; };
const MSP_REGIONS = [['https://api.ruckus.cloud', 'North America'], ['https://api.eu.ruckus.cloud', 'Europe'], ['https://api.asia.ruckus.cloud', 'Asia']];
function renderMsp() {
  $('#mspState').textContent = msp.length ? `${msp.filter((c) => c.enabled !== false).length} of ${msp.length} customers enabled` : 'not used — single connection';
  $('#mspRows').innerHTML = msp.map((c, i) => `<div class="top" style="border-top:1px solid var(--line);padding-top:.6rem;margin-top:.6rem" data-i="${i}">
    <label>Customer name<input data-m="name" value="${esc(c.name)}" size="22"></label>
    <label>Tenant ID<input data-m="tenantId" value="${esc(c.tenantId)}" size="32" autocomplete="off" spellcheck="false"></label>
    <label>Client ID<input data-m="clientId" value="${esc(c.clientId)}" size="28" autocomplete="off" spellcheck="false"></label>
    <label>Client secret<input data-m="clientSecret" type="password" size="24" autocomplete="new-password" placeholder="${c.secretSet ? '•••••••• (saved)' : '(not set)'}"></label>
    <label>Region<select data-m="apiBase">${MSP_REGIONS.map(([u, l]) => `<option value="${u}" ${u === c.apiBase ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="inline"><input type="checkbox" data-m="enabled" ${c.enabled !== false ? 'checked' : ''}> Enabled</label>
    <button data-mt="${i}" ${c.id ? '' : 'disabled title="Save first"'}>Test</button><button class="danger" data-mr="${i}">Remove</button><span data-ms="${i}"></span></div>`).join('');
}
async function loadMsp() { const r = await fetch(api('/api/settings')); if (r.ok) { msp = (await r.json()).customers || []; renderMsp(); } }
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
  const r = await fetch(api('/api/settings'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customers: msp }) });
  const j = await r.json(); if (!r.ok) return mspMsg(j.error || 'Save failed', 'bad');
  msp = j.customers || []; renderMsp(); mspMsg(msp.length ? 'Saved — polling every customer. Use Test on each row to verify.' : 'Saved — back to the single connection.');
});
loadMsp();
