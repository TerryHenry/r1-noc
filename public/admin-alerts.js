'use strict';
// Editor panels: alert rules + notification channels. Uses $, esc, api from admin.js.
let rules = [], metrics = [], chans = [], chStatus = {};
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
const metricOf = (id) => metrics.find((m) => m.id === id) || {};

function renderRules() {
  const m = $('#ruleBody'); if (!m) return;
  m.innerHTML = rules.map((r, i) => {
    const mt = metricOf(r.metric);
    return `<div class="wrow" data-ri="${i}">
      <label class="inline"><input type="checkbox" data-rf="enabled" ${r.enabled ? 'checked' : ''}> On</label>
      <label>Name<input data-rf="name" value="${esc(r.name)}" maxlength="60" style="width:15rem"></label>
      <label>When<select data-rf="metric">${opts(metrics.map((x) => [x.id, x.label]), r.metric)}</select></label>
      <label>is<select data-rf="op">${opts(['>=', '>', '<=', '<'].map((o) => [o, o]), r.op)}</select></label>
      <label>Value${mt.unit ? ` (${esc(mt.unit.trim())})` : ''}<input data-rf="threshold" type="number" step="any" value="${r.threshold}" style="width:6rem"></label>
      <label>Hold for (sec)<input data-rf="forSeconds" type="number" min="0" value="${r.forSeconds}" style="width:5.5rem" title="The condition must stay true this long before the alert fires"></label>
      <label>Severity<select data-rf="severity">${opts([['warn', 'Warning'], ['crit', 'Critical']], r.severity)}</select></label>
      <label class="inline" ${mt.perVenue ? '' : 'style="opacity:.4"'} title="Evaluate separately for every venue"><input type="checkbox" data-rf="perVenue" ${r.perVenue && mt.perVenue ? 'checked' : ''} ${mt.perVenue ? '' : 'disabled'}> Per venue</label>
      ${typeof customers !== 'undefined' && customers.length ? `<label class="inline" ${mt.perVenue ? '' : 'style="opacity:.4"'} title="MSP: evaluate separately for every customer"><input type="checkbox" data-rf="perCustomer" ${r.perCustomer && mt.perVenue ? 'checked' : ''} ${mt.perVenue ? '' : 'disabled'}> Per customer</label>` : ''}
      <label class="inline" title="Cover every display with a full-screen alert until acknowledged"><input type="checkbox" data-rf="takeover" ${r.takeover ? 'checked' : ''}> Take over screens</label>
      <label class="inline"><input type="checkbox" data-rf="notify" ${r.notify ? 'checked' : ''}> Notify</label>
      <label>Remind every (min)<input data-rf="repeatMinutes" type="number" min="0" value="${r.repeatMinutes}" style="width:5rem" title="0 = only once"></label>
      <button data-ract="del" class="danger">Remove</button></div>`;
  }).join('') || '<p style="color:var(--muted)">No rules.</p>';
}
function renderActive(active) {
  $('#activeAlerts').innerHTML = active.length
    ? active.map((a) => `<div class="wrow"><span class="${a.severity === 'crit' ? 'bad' : ''}" style="font-weight:600">${a.severity === 'crit' ? '●' : '▲'}</span><span style="flex:1">${esc(a.message)}</span>${a.acked ? '<span class="tag">acknowledged</span>' : `<button data-ackkey="${esc(a.key)}">Acknowledge 30 min</button>`}</div>`).join('')
    : '<p style="color:var(--ok)">No active alerts.</p>';
}
async function loadRules() {
  const r = await fetch(api('/api/rules')); if (!r.ok) { $('#ruleBody').innerHTML = '<p class="bad">Admin access required.</p>'; return; }
  const j = await r.json(); rules = j.rules; metrics = j.metrics; renderRules(); renderActive(j.active);
}
const rmsg = (t, cls = 'ok') => { const e = $('#ruleMsg'); e.textContent = t; e.className = cls; };
document.addEventListener('input', (e) => {
  const f = e.target.dataset && e.target.dataset.rf; if (!f) return;
  const r = rules[Number(e.target.closest('.wrow').dataset.ri)];
  r[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
  if (f === 'metric') { if (!metricOf(r.metric).perVenue) r.perVenue = false; renderRules(); }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.ract === 'del') { rules.splice(Number(b.closest('.wrow').dataset.ri), 1); renderRules(); }
  else if (b.id === 'addRule') { rules.push({ id: '', name: 'New rule', enabled: true, metric: metrics[0].id, op: '>=', threshold: 1, severity: 'warn', forSeconds: 60, perVenue: false, takeover: false, notify: true, repeatMinutes: 0 }); renderRules(); }
  else if (b.id === 'saveRules') {
    const r = await fetch(api('/api/rules'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rules) }); const j = await r.json();
    if (!r.ok) return rmsg(j.error || 'Save failed', 'bad'); rules = j.rules; renderRules(); renderActive(j.active); rmsg(`Saved ${rules.length} rules — ${new Date().toLocaleTimeString()}`);
  } else if (b.dataset.ackkey) { await fetch(api('/api/alerts/ack'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: b.dataset.ackkey, minutes: 30 }) }); loadRules(); }
});

// ---------- notification channels ----------
const TYPES = [['slack', 'Slack'], ['teams', 'Microsoft Teams'], ['email', 'Email (SMTP)'], ['webhook', 'Generic webhook (JSON)']];
function renderChans() {
  const m = $('#chanBody'); if (!m) return;
  m.innerHTML = chans.map((c, i) => {
    const st = chStatus[c.id];
    const fields = c.type === 'email'
      ? `<label>SMTP host<input data-cf="host" value="${esc(c.host)}" style="width:12rem" placeholder="smtp.example.com"></label>
         <label>Port<input data-cf="port" type="number" value="${c.port || ''}" style="width:5rem" placeholder="587"></label>
         <label>Security<select data-cf="secure">${opts([['starttls', 'STARTTLS (587)'], ['tls', 'TLS (465)'], ['none', 'None (25)']], c.secure)}</select></label>
         <label>Username<input data-cf="user" value="${esc(c.user)}" style="width:11rem" autocomplete="off"></label>
         <label>Password<input data-cf="pass" type="password" value="" placeholder="${c.passSet ? '•••••• (saved)' : '(none)'}" style="width:10rem" autocomplete="new-password"></label>
         <label>From<input data-cf="from" value="${esc(c.from)}" style="width:13rem" placeholder="noc@example.com"></label>
         <label>To (comma-separated)<input data-cf="to" value="${esc(c.to)}" style="width:18rem"></label>
         <label class="inline" title="Accept a self-signed certificate (lab / internal relay)"><input type="checkbox" data-cf="insecure" ${c.insecure ? 'checked' : ''}> Allow self-signed cert</label>`
      : `<label>${c.type === 'webhook' ? 'Webhook URL' : c.type === 'slack' ? 'Slack incoming-webhook URL' : 'Teams webhook URL'}<input data-cf="url" value="" placeholder="${c.urlSet ? 'https://•••••• (saved — leave blank to keep)' : 'https://…'}" style="width:28rem" autocomplete="off"></label>`;
    return `<div class="wrow" data-ci="${i}">
      <label class="inline"><input type="checkbox" data-cf="enabled" ${c.enabled ? 'checked' : ''}> On</label>
      <label>Name<input data-cf="name" value="${esc(c.name)}" maxlength="40" style="width:11rem"></label>
      <label>Type<select data-cf="type">${opts(TYPES, c.type)}</select></label>
      ${fields}
      <label>Send from<select data-cf="minSeverity">${opts([['warn', 'Warning and up'], ['crit', 'Critical only']], c.minSeverity)}</select></label>
      <label class="inline"><input type="checkbox" data-cf="sendResolved" ${c.sendResolved ? 'checked' : ''}> Send “resolved”</label>
      <button data-cact="test">Send test</button><button data-cact="del" class="danger">Remove</button>
      <span class="ctest" style="flex-basis:100%;font-size:.85rem">${st ? (st.ok ? `<span class="ok">Last delivery OK · ${new Date(st.at).toLocaleTimeString()}</span>` : `<span class="bad">Last delivery failed: ${esc(st.error)}</span>`) : ''}</span></div>`;
  }).join('') || '<p style="color:var(--muted)">No channels yet — add one to receive alerts outside the NOC.</p>';
}
async function loadChans() {
  const r = await fetch(api('/api/notify')); if (!r.ok) return;
  const j = await r.json(); chans = j.channels; chStatus = j.status || {}; renderChans();
}
const cmsg = (t, cls = 'ok') => { const e = $('#chanMsg'); e.textContent = t; e.className = cls; };
async function saveChans() {
  const r = await fetch(api('/api/notify'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chans) }); const j = await r.json();
  if (!r.ok) { cmsg(j.error || 'Save failed', 'bad'); return false; } chans = j.channels; renderChans(); cmsg(`Saved ${chans.length} channel${chans.length === 1 ? '' : 's'} — ${new Date().toLocaleTimeString()}`); return true;
}
document.addEventListener('input', (e) => {
  const f = e.target.dataset && e.target.dataset.cf; if (!f) return;
  const c = chans[Number(e.target.closest('.wrow').dataset.ci)];
  if (f === 'url' || f === 'pass') { c[f] = e.target.value; return; }          // secrets: only sent when typed
  c[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
});
document.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.cf === 'type') renderChans(); });
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'addChan') { chans.push({ id: '', name: 'New channel', type: 'slack', enabled: true, minSeverity: 'warn', sendResolved: true, secure: 'starttls', port: 0 }); renderChans(); }
  else if (b.id === 'saveChans') saveChans();
  else if (b.dataset.cact === 'del') { chans.splice(Number(b.closest('.wrow').dataset.ci), 1); renderChans(); }
  else if (b.dataset.cact === 'test') {
    const i = Number(b.closest('.wrow').dataset.ci); const c = chans[i];
    b.textContent = 'Sending…'; b.disabled = true;
    if (!(await saveChans())) return;                       // save first so the test uses what is on screen
    const id = chans[i] && chans[i].id; const j = await (await fetch(api('/api/notify/test'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })).json();
    await loadChans(); cmsg(j.ok ? `Test sent via "${c.name}".` : `Test failed: ${j.error}`, j.ok ? 'ok' : 'bad');
  }
});
loadRules(); loadChans();

// ---------- reports ----------
let reps = [], repViews = [], repFiles = [];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function renderReps() {
  const m = $('#repBody'); if (!m) return;
  m.innerHTML = (reps.map((r, i) => {
    const v = repViews.find((x) => x.name === r.view) || repViews[0] || { screens: [] };
    return `<div class="wrow" data-pi="${i}">
      <label class="inline"><input type="checkbox" data-pf="enabled" ${r.enabled ? 'checked' : ''}> On</label>
      <label>Name<input data-pf="name" value="${esc(r.name)}" maxlength="60" style="width:14rem"></label>
      <label>View<select data-pf="view">${opts(repViews.map((x) => [x.name, x.name]), r.view)}</select></label>
      <label>Screen<select data-pf="screen">${opts([['*', 'All screens'], ...v.screens.map((n) => [n, n])], r.screen)}</select></label>
      <label>Every<select data-pf="freq">${opts([['daily', 'Day'], ['weekly', 'Week']], r.freq)}</select></label>
      ${r.freq === 'weekly' ? `<label>On<select data-pf="day">${opts(DAYS.map((d, k) => [String(k), d]), String(r.day))}</select></label>` : ''}
      <label>At<input data-pf="time" type="time" value="${r.time}"></label>
      <label class="inline" title="Email to every enabled email channel (set up under Notifications)"><input type="checkbox" data-pf="email" ${r.email ? 'checked' : ''}> Email it</label>
      <button data-pact="run">Run now</button>${r.id ? `<a class="chip" href="${api('/report?id=' + encodeURIComponent(r.id))}" target="_blank">Open</a>` : ''}<button data-pact="del" class="danger">Remove</button>
      <span style="flex-basis:100%;font-size:.85rem;color:var(--muted)">${r.lastRun ? `Last run ${new Date(r.lastRun).toLocaleString()} — ${esc(r.lastStatus)}` : 'Never run'}</span></div>`;
  }).join('') || '<p style="color:var(--muted)">No reports yet.</p>') +
    (repFiles.length ? `<details style="margin-top:.6rem"><summary style="cursor:pointer;color:var(--muted)">Saved reports (${repFiles.length})</summary><div style="margin-top:.4rem;display:flex;flex-wrap:wrap;gap:.4rem">${repFiles.map((f) => `<a class="chip" href="${api('/reports/' + encodeURIComponent(f))}" target="_blank">${esc(f.replace(/\.html$/, ''))}</a>`).join('')}</div></details>` : '');
}
async function loadReps() {
  const r = await fetch(api('/api/reports')); if (!r.ok) return;
  const j = await r.json(); reps = j.reports; repViews = j.views; repFiles = j.files; renderReps();
}
const pmsg = (t, cls = 'ok') => { const e = $('#repMsg'); e.textContent = t; e.className = cls; };
async function saveReps() {
  const r = await fetch(api('/api/reports'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reps) }); const j = await r.json();
  if (!r.ok) { pmsg(j.error || 'Save failed', 'bad'); return false; } reps = j.reports; repFiles = j.files; renderReps(); pmsg(`Saved ${reps.length} report${reps.length === 1 ? '' : 's'} — ${new Date().toLocaleTimeString()}`); return true;
}
document.addEventListener('input', (e) => {
  const f = e.target.dataset && e.target.dataset.pf; if (!f) return;
  const r = reps[Number(e.target.closest('.wrow').dataset.pi)];
  r[f] = e.target.type === 'checkbox' ? e.target.checked : f === 'day' ? Number(e.target.value) : e.target.value;
  if (f === 'view') r.screen = '*';
  if (f === 'view' || f === 'freq') renderReps();
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'addRep') { reps.push({ id: '', name: 'Daily NOC summary', enabled: true, view: 'Main', screen: '*', freq: 'daily', day: 1, time: '07:00', email: true }); renderReps(); }
  else if (b.id === 'saveReps') saveReps();
  else if (b.dataset.pact === 'del') { reps.splice(Number(b.closest('.wrow').dataset.pi), 1); renderReps(); }
  else if (b.dataset.pact === 'run') {
    const i = Number(b.closest('.wrow').dataset.pi); b.textContent = 'Running…'; b.disabled = true;
    if (!(await saveReps())) return;
    const j = await (await fetch(api('/api/reports/run'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: reps[i].id }) })).json();
    await loadReps(); pmsg(j.ok ? `Done — ${j.status}` : `Failed: ${j.error}`, j.ok ? 'ok' : 'bad');
  }
});
loadReps();
