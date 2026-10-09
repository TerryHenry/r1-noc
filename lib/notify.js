'use strict';
// Notification channels: webhook (generic JSON), Slack, Microsoft Teams, email (built-in SMTP client, no dependencies).
// Channel secrets (webhook URLs, SMTP password) live in data/notify.json (0600) and are never sent back to the browser.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'notify.json');
const SEV = { warn: 1, crit: 2 };
const TYPES = ['webhook', 'slack', 'teams', 'email'];

let channels = load();
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } }
function persist() { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(channels, null, 2), { mode: 0o600 }); fs.renameSync(FILE + '.tmp', FILE); }

const mask = (c) => ({ id: c.id, name: c.name, type: c.type, enabled: c.enabled, minSeverity: c.minSeverity, sendResolved: c.sendResolved,
  urlSet: Boolean(c.url), insecure: Boolean(c.insecure), host: c.host || '', port: c.port || 0, secure: c.secure || 'starttls', user: c.user || '', passSet: Boolean(c.pass), from: c.from || '', to: c.to || '' });
const list = () => channels.map(mask);

// Replace the whole list; blank secret fields keep the stored value for the channel with the same id.
function save(input) {
  if (!Array.isArray(input)) throw new Error('channels must be a list');
  const old = new Map(channels.map((c) => [c.id, c]));
  channels = input.slice(0, 20).map((c, i) => {
    const prev = old.get(c.id) || {};
    const type = TYPES.includes(c.type) ? c.type : 'webhook';
    const url = String(c.url || '').trim() || prev.url || '';
    if (['webhook', 'slack', 'teams'].includes(type) && url && !/^https?:\/\//i.test(url)) throw new Error(`"${c.name || type}": URL must start with http:// or https://`);
    return { id: String(c.id || `c${Date.now().toString(36)}${i}`).slice(0, 30), name: String(c.name || type).slice(0, 40), type, enabled: c.enabled !== false, minSeverity: c.minSeverity === 'crit' ? 'crit' : 'warn', sendResolved: c.sendResolved !== false,
      url, host: String(c.host || '').trim(), port: Number(c.port) || 0, secure: ['tls', 'starttls', 'none'].includes(c.secure) ? c.secure : 'starttls', user: String(c.user || '').trim(),
      pass: String(c.pass || '') || prev.pass || '', insecure: Boolean(c.insecure), from: String(c.from || '').trim(), to: String(c.to || '').trim() };
  });
  persist();
  return list();
}

// ---- message formatting ----
const ICON = { fired: { crit: '🔴', warn: '🟠' }, reminder: { crit: '🔴', warn: '🟠' }, resolved: { crit: '✅', warn: '✅' } };
function textOf(ev) {
  const a = ev.alert; const verb = ev.type === 'resolved' ? 'RESOLVED' : ev.type === 'reminder' ? 'STILL ACTIVE' : a.severity === 'crit' ? 'CRITICAL' : 'WARNING';
  return `${ICON[ev.type][a.severity]} [${verb}] ${a.message}`;
}

// ---- transports ----
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Minimal SMTP client: implicit TLS (465), STARTTLS (587/25) or plain; AUTH PLAIN/LOGIN. Enough for alert mail.
function smtpSend(c, subject, text, html) {
  return new Promise((resolve, reject) => {
    const port = c.port || (c.secure === 'tls' ? 465 : 587);
    let sock = null; let buf = ''; let waiter = null; let done = false;
    const fail = (e) => { if (!done) { done = true; try { sock && sock.destroy(); } catch { /* ignore */ } reject(e instanceof Error ? e : new Error(String(e))); } };
    const timer = setTimeout(() => fail(new Error('SMTP timeout')), 20000);
    const attach = (s) => {
      sock = s; s.setEncoding('utf8');
      s.on('data', (d) => { buf += d; check(); }); s.on('error', fail); s.on('close', () => { if (!done && waiter) fail(new Error('SMTP connection closed')); });
    };
    // A reply is complete when its last line is "NNN text" (no dash after the code).
    const check = () => { const lines = buf.split(/\r?\n/); if (lines.length < 2) return; const last = lines[lines.length - 2]; if (/^\d{3} /.test(last) && waiter) { const w = waiter; waiter = null; const reply = buf; buf = ''; w(reply); } };
    const read = () => new Promise((res) => { waiter = res; check(); });
    const send = async (line, expect) => { sock.write(line + '\r\n'); const r = await read(); if (expect && !new RegExp(`^${expect}`).test(r)) throw new Error(`SMTP: ${r.trim().split('\n').pop()}`); return r; };
    const host = os.hostname() || 'localhost';
    const run = async () => {
      let r = await read(); if (!/^220/.test(r)) throw new Error(`SMTP greeting: ${r.trim()}`);
      let caps = await send(`EHLO ${host}`, '250');
      if (c.secure === 'starttls') {
        if (!/STARTTLS/i.test(caps)) throw new Error('Server does not offer STARTTLS');
        await send('STARTTLS', '220');
        sock.removeAllListeners('data'); const raw = sock; sock = null;
        await new Promise((res, rej) => { const t = tls.connect({ socket: raw, servername: c.host, rejectUnauthorized: !c.insecure }, () => res()); attach(t); t.on('error', rej); sock = t; });
        buf = ''; caps = await send(`EHLO ${host}`, '250');
      }
      if (c.user) {
        if (/AUTH[^\n]*PLAIN/i.test(caps)) await send('AUTH PLAIN ' + Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64'), '235');
        else { await send('AUTH LOGIN', '334'); await send(Buffer.from(c.user).toString('base64'), '334'); await send(Buffer.from(c.pass).toString('base64'), '235'); }
      }
      const rcpts = c.to.split(/[,;\s]+/).filter(Boolean); if (!rcpts.length) throw new Error('No recipients');
      const from = c.from || c.user; if (!from) throw new Error('No From address');
      await send(`MAIL FROM:<${from.replace(/.*<|>.*/g, '')}>`, '250');
      for (const rc of rcpts) await send(`RCPT TO:<${rc}>`, '25');
      await send('DATA', '354');
      const b64 = (str) => Buffer.from(str).toString('base64').replace(/(.{76})/g, '$1\r\n');
      const bnd = `noc${Date.now().toString(36)}`;
      const head = [`From: ${from}`, `To: ${rcpts.join(', ')}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0'];
      const msg = (html
        ? [...head, `Content-Type: multipart/alternative; boundary="${bnd}"`, '', `--${bnd}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text), `--${bnd}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html), `--${bnd}--`, '.']
        : [...head, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text), '.']).join('\r\n');
      await send(msg, '250'); await send('QUIT');
    };
    const start = () => { try { if (c.secure === 'tls') { const s = tls.connect({ host: c.host, port, servername: c.host, rejectUnauthorized: !c.insecure }); attach(s); } else { const s = net.connect({ host: c.host, port }); attach(s); } run().then(() => { done = true; clearTimeout(timer); sock.end(); resolve(); }).catch((e) => { clearTimeout(timer); fail(e); }); } catch (e) { fail(e); } };
    start();
  });
}

async function deliver(c, subject, text, payload) {
  if (c.type === 'slack') return postJson(c.url, { text });
  if (c.type === 'teams') return postJson(c.url, { '@type': 'MessageCard', '@context': 'https://schema.org/extensions', summary: subject, themeColor: payload.severity === 'crit' ? 'D13438' : 'E3A72F', title: subject, text });
  if (c.type === 'email') return smtpSend(c, subject, `${text}\n\n— R1 NOC Wall (${os.hostname()})`);
  return postJson(c.url, payload);   // generic webhook: structured JSON
}

const lastStatus = new Map();   // channel id → { ok, at, error }
async function sendTo(c, ev) {
  const text = textOf(ev); const a = ev.alert;
  const subject = `${ev.type === 'resolved' ? 'RESOLVED' : a.severity === 'crit' ? 'CRITICAL' : 'WARNING'}: ${a.name}${a.venue ? ' — ' + a.venue : ''}`;
  try { await deliver(c, subject, text, { event: ev.type, severity: a.severity, rule: a.name, venue: a.venue, message: a.message, metric: a.metric, value: a.value, threshold: a.threshold, since: a.since, text }); lastStatus.set(c.id, { ok: true, at: Date.now() }); }
  catch (e) { lastStatus.set(c.id, { ok: false, at: Date.now(), error: e.message }); console.error(`notify "${c.name}" failed: ${e.message}`); }
}

// Events from the rules engine → every enabled channel that wants this severity.
function dispatch(events) {
  for (const ev of events) {
    if (!ev.rule.notify) continue;
    for (const c of channels) {
      if (!c.enabled || SEV[ev.alert.severity] < SEV[c.minSeverity]) continue;
      if (ev.type === 'resolved' && !c.sendResolved) continue;
      sendTo(c, ev);
    }
  }
}
// "Send test" from the editor: awaits and reports the real result.
async function test(id) {
  const c = channels.find((x) => x.id === id); if (!c) throw new Error('Unknown channel');
  const ev = { type: 'fired', rule: { notify: true }, alert: { severity: 'warn', name: 'Test notification', venue: '', message: 'Test notification from R1 NOC Wall — if you can read this, the channel works.', metric: 'test', value: 1, threshold: 1, since: Date.now() } };
  const text = textOf(ev);
  await deliver(c, 'NOC test notification', text, { event: 'test', severity: 'warn', rule: 'Test notification', message: ev.alert.message, text });
  lastStatus.set(c.id, { ok: true, at: Date.now() });
}
// Scheduled reports: HTML mail to every enabled email channel. Returns { sent, errors }.
async function sendReport(subject, html, text) {
  const mail = channels.filter((c) => c.enabled && c.type === 'email'); const errors = []; let sent = 0;
  for (const c of mail) { try { await smtpSend(c, subject, text, html); sent++; lastStatus.set(c.id, { ok: true, at: Date.now() }); } catch (e) { errors.push(`${c.name}: ${e.message}`); lastStatus.set(c.id, { ok: false, at: Date.now(), error: e.message }); } }
  return { sent, errors, channels: mail.length };
}
module.exports = { list, save, dispatch, test, sendReport, status: () => Object.fromEntries(lastStatus) };
