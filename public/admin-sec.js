'use strict';
// Editor panels: HTTPS & certificate, and Backup & restore. Uses $, esc, api from admin.js.
const secJson = async (url, opt = {}) => { const r = await fetch(api(url), { headers: { 'Content-Type': 'application/json' }, ...opt }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
const secSay = (sel, t, cls = 'ok') => { const e = $(sel); e.textContent = t; e.className = cls; };
const secWhen = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

// ---------- HTTPS ----------
function paintTls(t) {
  const c = t.config, x = t.cert;
  $('#tlsEnabled').checked = c.enabled; $('#tlsPort').value = c.port; $('#tlsRedirect').checked = c.redirect; $('#tlsHsts').checked = c.hsts;
  $('#tlsState').textContent = t.listening ? `serving HTTPS on port ${t.listening}` : c.enabled ? 'enabled but not running' : t.installed ? 'certificate installed, HTTPS off' : 'off — no certificate';
  let h = '';
  if (x && x.error) h = `<div class="bad">${esc(x.error)}</div>`;
  else if (x) {
    const tone = x.daysLeft < 0 ? 'bad' : x.daysLeft <= 30 ? 'warn' : 'ok';
    h = `<table class="kv"><tr><td>Subject</td><td>${esc(x.subject)}</td></tr><tr><td>Issuer</td><td>${esc(x.issuer)}${x.selfSigned ? ' <b>(self-signed — browsers will warn)</b>' : ''}</td></tr>
      <tr><td>Valid</td><td>${secWhen(x.validFrom)} → ${secWhen(x.validTo)} · <span class="${tone}">${x.daysLeft < 0 ? 'EXPIRED' : x.daysLeft + ' days left'}</span></td></tr>
      <tr><td>Names</td><td>${esc(x.sans.join(', ') || '—')}</td></tr><tr><td>SHA-256</td><td style="font-family:monospace;font-size:.75rem;word-break:break-all">${esc(x.fingerprint)}</td></tr>
      <tr><td>Key</td><td class="${x.keyMatches ? 'ok' : 'bad'}">${x.keyMatches ? 'matches the certificate' : 'MISSING or does not match'}${x.chain ? ` · ${x.chain} chain certificate${x.chain > 1 ? 's' : ''}` : ''}</td></tr></table>`;
  } else h = '<div style="color:var(--muted)">No certificate installed.</div>';
  if (t.lastError) h += `<div class="bad">${esc(t.lastError)}</div>`;
  $('#tlsInfo').innerHTML = h; $('#tlsCsrBox').style.display = t.pendingCsr ? '' : 'none';
  if (t.pendingCsr && !$('#tlsCsrText').value) fetch(api('/api/tls/csr')).then((r) => r.text()).then((x2) => { $('#tlsCsrText').value = x2; });
  if (!$('#tlsHosts').value && t.hostSuggestions) { $('#tlsHosts').value = t.hostSuggestions.join(', '); $('#tlsCn').placeholder = t.hostSuggestions[0] || ''; }
}
async function loadTls() { try { paintTls(await secJson('/api/tls')); } catch (e) { $('#tlsState').textContent = 'admin access required'; } }
const genBody = () => ({ commonName: $('#tlsCn').value.trim(), hosts: $('#tlsHosts').value, days: Number($('#tlsDays').value), keyType: $('#tlsKeyType').value, organization: $('#tlsOrg').value.trim() });
$('#tlsSaveCfg').addEventListener('click', async () => {
  try { const t = await secJson('/api/tls/config', { method: 'PUT', body: JSON.stringify({ enabled: $('#tlsEnabled').checked, port: $('#tlsPort').value, redirect: $('#tlsRedirect').checked, hsts: $('#tlsHsts').checked }) }); paintTls(t); secSay('#tlsCfgMsg', t.listening ? ` Listening on ${t.listening}` : ' Saved'); } catch (e) { secSay('#tlsCfgMsg', ' ' + e.message, 'bad'); }
});
$('#tlsSelf').addEventListener('click', async () => {
  if (!confirm('Generate a new self-signed certificate? It replaces any installed certificate.')) return;
  secSay('#tlsGenMsg', ' generating…', ''); try { paintTls(await secJson('/api/tls/self-signed', { method: 'POST', body: JSON.stringify(genBody()) })); secSay('#tlsGenMsg', ' Done — turn on "Serve HTTPS" and Apply'); } catch (e) { secSay('#tlsGenMsg', ' ' + e.message, 'bad'); }
});
$('#tlsCsr').addEventListener('click', async () => {
  secSay('#tlsGenMsg', ' generating…', ''); try { const j = await secJson('/api/tls/csr', { method: 'POST', body: JSON.stringify(genBody()) }); $('#tlsCsrText').value = j.csr; $('#tlsCsrBox').style.display = ''; secSay('#tlsGenMsg', ' Request created'); } catch (e) { secSay('#tlsGenMsg', ' ' + e.message, 'bad'); }
});
$('#tlsCsrDl').addEventListener('click', (e) => { e.preventDefault(); location.href = api('/api/tls/csr'); });
$('#tlsInstall').addEventListener('click', async () => {
  try { paintTls(await secJson('/api/tls/install', { method: 'POST', body: JSON.stringify({ cert: $('#tlsCert').value, key: $('#tlsKey').value }) })); $('#tlsCert').value = ''; $('#tlsKey').value = ''; secSay('#tlsInstMsg', ' Installed'); } catch (e) { secSay('#tlsInstMsg', ' ' + e.message, 'bad'); }
});
$('#tlsRemove').addEventListener('click', async () => {
  if (!confirm('Remove the certificate and key and turn HTTPS off?')) return;
  try { paintTls(await secJson('/api/tls', { method: 'DELETE' })); secSay('#tlsInstMsg', ' Removed'); } catch (e) { secSay('#tlsInstMsg', ' ' + e.message, 'bad'); }
});
$('#tlsFile').addEventListener('change', async (e) => {
  for (const f of e.target.files) { const t = await f.text(); if (/PRIVATE KEY/.test(t)) $('#tlsKey').value = t; else if (/BEGIN CERTIFICATE/.test(t)) $('#tlsCert').value = ($('#tlsCert').value ? $('#tlsCert').value.trimEnd() + '\n' : '') + t; }
  e.target.value = '';
});
loadTls();

// ---------- backup & restore ----------
const secDownload = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
$('#bkDownload').addEventListener('click', async () => {
  const full = document.querySelector('input[name="bkMode"]:checked').value === 'full';
  try {
    const r = await fetch(api('/api/backup'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full, passphrase: $('#bkPass').value }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const name = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '')?.[1] || 'r1-noc-wall-backup.json'; secDownload(name, await r.text()); secSay('#bkMsg', ` Downloaded ${name}`); loadBackups();
  } catch (e) { secSay('#bkMsg', ' ' + e.message, 'bad'); }
});
let bkText = '';
$('#bkInspect').addEventListener('click', async () => {
  const f = $('#bkFile').files[0]; if (!f) return secSay('#bkPreview', 'Choose a backup file first.', 'bad');
  bkText = await f.text();
  try {
    const i = await secJson('/api/restore/inspect', { method: 'POST', body: JSON.stringify({ bundle: bkText, passphrase: $('#bkRestorePass').value }) });
    $('#bkPreview').className = ''; $('#bkPreview').innerHTML = `<div>Backup made ${esc(secWhen(Date.parse(i.createdAt)))} · ${i.includesCredentials ? '<b>includes credentials</b>' : 'no credentials'}${i.encrypted ? ' · encrypted' : ''}</div>
      <div style="margin:.4rem 0">${i.parts.map((p) => `<label class="inline" style="display:block"><input type="checkbox" data-bp="${esc(p.name)}" checked> ${esc(p.label)} <small style="color:var(--muted)">${p.replaces ? 'replaces the current one' : 'new'}${p.credentials ? ' · credentials' : ''}</small></label>`).join('')}</div>
      <button class="primary" id="bkRestore">Restore selected</button> <small style="color:var(--muted)">Your current configuration is saved first (see "Saved copies"). Credentials left out of a backup keep their current values.</small> <span id="bkRMsg"></span>`;
  } catch (e) { secSay('#bkPreview', e.message, 'bad'); }
});
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'bkRestore') return;
  const parts = [...document.querySelectorAll('[data-bp]')].filter((c) => c.checked).map((c) => c.dataset.bp); if (!parts.length) return;
  if (!confirm(`Restore ${parts.length} item${parts.length > 1 ? 's' : ''}? This replaces the current settings for them.`)) return;
  try { const j = await secJson('/api/restore', { method: 'POST', body: JSON.stringify({ bundle: bkText, passphrase: $('#bkRestorePass').value, parts }) }); secSay('#bkRMsg', ` Restored ${j.applied.length} item(s). Previous configuration saved as ${j.snapshot}. Reloading…`); setTimeout(() => location.reload(), 1500); } catch (er) { secSay('#bkRMsg', ' ' + er.message, 'bad'); }
});
async function loadBackups() {
  try { const l = await secJson('/api/backups'); $('#bkList').innerHTML = l.length ? l.map((b) => `<div><a href="${api('/api/backups/' + encodeURIComponent(b.name))}">${esc(b.name)}</a> <small style="color:var(--muted)">${esc(secWhen(b.at))} · ${(b.bytes / 1024).toFixed(0)} KB · ${esc(b.kind)}</small></div>`).join('') : '<span style="color:var(--muted)">None yet.</span>'; } catch { /* not admin */ }
}
loadBackups();

// ---------- software update ----------
let upPlan = null;
async function loadUp() {
  try {
    const u = await secJson('/api/upgrade'); $('#upState').textContent = `version ${u.version}${u.disabled ? ' · updates disabled on this server' : ''}`;
    $('#upInfo').innerHTML = `<div>Installed: <b>${esc(u.version)}</b> · Node ${esc(u.node)} · restart method: ${u.supervised ? 'exits and lets the service manager restart it' : 'restarts itself (output goes to data/server.log)'}</div>`
      + (u.last && u.last.to ? `<div style="color:var(--muted)">Last change: ${esc(u.last.from)} → ${esc(u.last.to)}${u.last.rollback ? ' (rollback)' : ''} on ${esc(secWhen(u.last.at))}</div>` : '');
    $('#upPrev').innerHTML = u.previous.length && !u.disabled ? `Previous version saved: <b>${esc(u.previous[0].name.replace(/^app-|\.tgz$/g, ''))}</b> <button id="upRollback">Roll back to it</button> <span id="upRbMsg"></span>` : '';
  } catch { $('#upState').textContent = 'admin access required'; }
}
async function afterRestart(msg) {
  secSay('#upMsg', ' ' + msg, ''); const t0 = Date.now(); await new Promise((r) => setTimeout(r, 2500));
  for (;;) { try { const r = await fetch(api('/api/config'), { cache: 'no-store' }); if (r.ok) { secSay('#upMsg', ' Back online — reloading…'); return setTimeout(() => location.reload(), 800); } } catch { /* still down */ } if (Date.now() - t0 > 90000) return secSay('#upMsg', ' The app has not come back after 90 s — check the server (data/server.log). If you use a service manager, it should restart it automatically.', 'bad'); await new Promise((r) => setTimeout(r, 1500)); }
}
$('#upCheck').addEventListener('click', async () => {
  const f = $('#upFile').files[0]; if (!f) return secSay('#upMsg', ' Choose a release file first', 'bad');
  secSay('#upMsg', ' uploading and checking…', ''); $('#upPlan').innerHTML = '';
  try {
    const r = await fetch(api('/api/upgrade/upload?name=' + encodeURIComponent(f.name)), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f }); const p = await r.json(); if (!r.ok) throw new Error(p.error || `HTTP ${r.status}`);
    upPlan = p; secSay('#upMsg', '');
    const rel = { newer: '<span class="ok">newer than the installed version</span>', same: '<span class="warn">the same version as installed</span>', older: '<span class="bad">OLDER than the installed version (downgrade)</span>' }[p.relation];
    $('#upPlan').innerHTML = `<div class="panel" style="padding:.7rem"><div><b>${esc(p.file)}</b> · ${(p.size / 1024).toFixed(0)} KB</div>
      <div>Version <b>${esc(p.version)}</b> — ${rel}${p.nodeOk ? '' : ` · <span class="bad">needs Node.js ${esc(p.nodeNeeds)}</span>`}</div>
      <div style="font-size:.8rem;color:var(--muted)">SHA-256: <span style="font-family:monospace;word-break:break-all">${esc(p.sha256)}</span> — compare with the checksum published with the release.</div>
      <div style="font-size:.85rem;margin-top:.3rem">Replaces: ${esc(p.entries.join(', '))}</div>
      ${p.notes ? `<pre style="max-height:9rem;overflow:auto;font-size:.75rem;background:var(--panel-2);padding:.5rem;border-radius:.4rem">${esc(p.notes)}</pre>` : ''}
      <div class="bad" style="font-size:.85rem;margin:.4rem 0">Installing runs the code in this file on your server. Only install release files you got from a source you trust.</div>
      ${p.relation === 'older' ? '<label class="inline"><input type="checkbox" id="upDown"> I understand this is a downgrade</label> ' : ''}
      <button class="primary" id="upInstall" ${p.nodeOk ? '' : 'disabled'}>Test, install &amp; restart</button> <button id="upCancel">Cancel</button></div>`;
  } catch (e) { secSay('#upMsg', ' ' + e.message, 'bad'); }
});
document.addEventListener('click', async (e) => {
  if (e.target.id === 'upCancel') { if (upPlan) fetch(api('/api/upgrade/staged/' + encodeURIComponent(upPlan.id)), { method: 'DELETE' }); upPlan = null; $('#upPlan').innerHTML = ''; return; }
  if (e.target.id === 'upInstall' && upPlan) {
    if (upPlan.relation === 'older' && !$('#upDown').checked) return secSay('#upMsg', ' Tick the downgrade box to continue', 'bad');
    if (!confirm(`Install ${upPlan.version} and restart the app now? Displays reconnect automatically.`)) return;
    e.target.disabled = true; secSay('#upMsg', ' testing the new version in a throw-away instance (up to 30 s)…', '');
    try { const j = await secJson('/api/upgrade/apply', { method: 'POST', body: JSON.stringify({ id: upPlan.id, allowDowngrade: upPlan.relation === 'older' }) }); upPlan = null; $('#upPlan').innerHTML = ''; await afterRestart(`Installed ${j.to}. Restarting…`); }
    catch (er) { secSay('#upMsg', ' ' + er.message, 'bad'); e.target.disabled = false; }
  }
  if (e.target.id === 'upRollback') {
    if (!confirm('Roll back to the previous version and restart?')) return;
    try { const j = await secJson('/api/upgrade/rollback', { method: 'POST' }); await afterRestart(`Rolled back to ${j.to}. Restarting…`); } catch (er) { secSay('#upRbMsg', ' ' + er.message, 'bad'); }
  }
});
loadUp();
