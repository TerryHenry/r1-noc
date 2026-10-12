'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./lib/config');
const collect = require('./lib/collect');
const dash = require('./lib/dashboard');
const widgets = require('./lib/widgets');
const settings = require('./lib/settings');
const r1 = require('./lib/r1');
const rules = require('./lib/rules');
const notify = require('./lib/notify');
const report = require('./lib/report');
const feeds = require('./lib/feeds');
const tls = require('./lib/tls');
const backup = require('./lib/backup');
const upgrade = require('./lib/upgrade');

let layout = dash.load();
const refreshNeeds = () => collect.setNeeds(new Set([...widgets.needsFor({ screens: dash.allScreens(layout) }), ...rules.needs()]));
refreshNeeds();
const clients = new Set(); // SSE connections: { res, venue }  (venue = drill-down filter chosen by that client, '' = all)

// ---- shared rotation clock (so several displays stay on the same screen) ----
// Clients compute the current screen from this anchor + the server's clock, so there is no per-rotation traffic.
let control = { held: false, screen: 0, base: 0, t0: Date.now() };
const activeView = () => dash.viewByName(layout, dash.scheduledView(layout));
// The shared clock is one unbounded step counter; each display takes it modulo the length of ITS playlist, so displays
// with different playlists stay in lockstep (step / hold / jump act on all of them).
const maxLen = () => { const v = activeView(); return Math.max(1, v.screens.length, ...(v.playlists || []).map((l) => l.length)); };
function currentIdx() {
  if (control.held) return control.screen;
  const sec = activeView().rotateSeconds;
  const steps = sec > 0 ? Math.floor((Date.now() - control.t0) / (sec * 1000)) : 0;
  return control.base + steps;
}
function applyControl(body) {
  const idx = currentIdx(); const now = Date.now();
  const move = (target) => { if (control.held) control.screen = target; else { control.base = target; control.t0 = now; } };
  switch (body.action) {
    case 'next': move(idx + 1); break;
    case 'prev': move(idx - 1); break;
    case 'goto': move(Math.max(0, Math.round(Number(body.screen)) || 0)); break;
    case 'hold': control = { held: true, screen: idx, base: idx, t0: now }; break;
    case 'resume': control = { held: false, screen: idx, base: idx, t0: now }; break;
    default: throw new Error('Unknown control action');
  }
}
function reanchorControl() {   // layout changed: keep the current screen if it still exists
  const n = maxLen(); const idx = ((currentIdx() % n) + n) % n;   // keep roughly where we were, but within the new layout
  control = { held: control.held, screen: idx, base: idx, t0: Date.now() };
}

// ---- payload building ----
const cmpOp = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b };
// Per-widget thresholds colour a scorecard by its numeric value (critical wins over warning).
function applyThresholds(wd, p) {
  const th = wd.thresholds;
  if (!th || p.kind !== 'kpi' || typeof p.value !== 'number') return p;
  if (th.crit && cmpOp[th.crit.op](p.value, th.crit.val)) return { ...p, tone: 'bad' };
  if (th.warn && cmpOp[th.warn.op](p.value, th.warn.val)) return { ...p, tone: 'warn' };
  return { ...p, tone: 'ok' };
}
const upS = (d) => d.status === 'Operational' || d.status === 'Degraded';
function summaryOf(S) { return { aps: S.aps.length, apsUp: S.aps.filter(upS).length, sw: S.switches.length, swUp: S.switches.filter(upS).length, clients: S.clients.length || S.aps.reduce((n, a) => n + a.clients, 0), alarms: S.alarms.length }; }
const applyTitle = (wd, p) => (wd.title && p.kind !== 'error' ? { ...p, title: wd.title } : p);
// Viewer drill-down: ?venue=<id> pins widgets without their own venue; ?customer=<id> (or venue=c:<id>) pins them to a customer (MSP mode).
const scoped = (wd, venue) => (!venue || wd.venue || wd.customer ? wd : venue.startsWith('c:') ? { ...wd, customer: venue.slice(2) } : { ...wd, venue });
function buildData(venue = '') {
  const S = collect.get();
  const out = {};
  for (const wd of dash.allWidgets(layout)) out[wd.id] = applyTitle(wd, applyThresholds(wd, widgets.compute(scoped(wd, venue), S)));
  return { at: S.at, serverNow: Date.now(), view: dash.scheduledView(layout), venue, source: S.source, errors: S.errors, pollSeconds: cfg.pollSeconds, alerts: rules.active(), summary: summaryOf(venue.startsWith('c:') ? widgets.customerView(S, venue.slice(2)) : S), ticker: feeds.ticker(), widgets: out };
}
// One payload per distinct drill-down venue among the connected clients.
function broadcastData() {
  const cache = new Map();
  for (const c of clients) {
    if (!cache.has(c.venue)) cache.set(c.venue, `event: data\ndata: ${JSON.stringify(buildData(c.venue))}\n\n`);
    c.res.write(cache.get(c.venue));
  }
}
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.res.write(msg);
}

// Drill-down venue from ?venue= — must be a real venue id.
const venueParam = (url) => {
  const S = collect.get(); const cu = url.searchParams.get('customer') || ''; if (cu && (S.customers || []).some((c) => c.id === cu)) return `c:${cu}`;
  const v = url.searchParams.get('venue') || ''; return v.startsWith('c:') ? ((S.customers || []).some((c) => `c:${c.id}` === v) ? v : '') : S.venues.some((x) => x.id === v) ? v : '';
};

// ---- reports ----
function reportHtml(rep) {
  const view = dash.viewByName(layout, rep.view); const S = collect.get();
  const screens = rep.screen === '*' ? view.screens : view.screens.filter((x) => x.name === rep.screen);
  const data = {}; for (const sc of screens) for (const wd of sc.widgets) data[wd.id] = applyTitle(wd, applyThresholds(wd, widgets.compute(wd, S)));
  return report.render({ title: rep.name, subtitle: `${layout.title} · ${view.name}${rep.screen === '*' ? '' : ' · ' + rep.screen}`, screens, data, source: S.source === 'demo' ? 'demo data' : 'live data' });
}
async function runReport(rep) {
  if (!collect.get().at) throw new Error('No data collected yet');
  const html = reportHtml(rep); const file = report.saveFile(rep.id, html); let status = `Saved ${file}`;
  if (rep.email) {
    const r = await notify.sendReport(`${rep.name} — ${new Date().toLocaleDateString()}`, html, `${rep.name}\nThe full report is in the HTML part of this message; it is also saved on the NOC server as ${file}.`);
    status = r.channels ? (r.errors.length ? `Emailed ${r.sent}/${r.channels} (${r.errors.join('; ')})` : `Emailed ${r.sent} channel${r.sent === 1 ? '' : 's'} · saved`) : 'Saved (no email channel configured)';
  }
  report.mark(rep.id, status); return { file, status };
}
setInterval(() => { for (const rep of report.get()) if (report.due(rep) && collect.get().at) { report.mark(rep.id, 'Running…'); runReport(rep).catch((e) => { report.mark(rep.id, `Failed: ${e.message}`); console.error(`report "${rep.name}" failed: ${e.message}`); }); } }, 30000);

// ---- auth ----
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function keyOf(req, url) { return url.searchParams.get('key') || req.headers['x-noc-key'] || ''; }
const canView = (req, url) => !cfg.viewKey || keyOf(req, url) === cfg.viewKey || keyOf(req, url) === cfg.adminKey && !!cfg.adminKey;
const canAdmin = (req, url) => (cfg.adminKey ? keyOf(req, url) === cfg.adminKey : isLoopback(req));

// ---- http ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

async function readBody(req, max = 256 * 1024) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > max) throw new Error('Body too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

let httpsServer = null, httpsPort = 0, upgradeBusy = false;
const settle = () => new Promise((r) => setTimeout(r, 250));   // let a (re)started HTTPS listener finish binding before we report its state
const handle = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.socket.encrypted && tls.config().hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (!canView(req, url)) return json(res, 401, { error: 'Missing or wrong ?key=' });
      if (p === '/api/config' && req.method === 'GET') return json(res, 200, { layout, control, view: dash.scheduledView(layout), serverNow: Date.now(), venues: collect.get().venues, customers: (collect.get().customers || []).map((c) => ({ id: c.id, name: c.name })), canAdmin: canAdmin(req, url), version: upgrade.version() });
      if (p === '/api/config' && req.method === 'PUT') {
        if (!canAdmin(req, url)) return json(res, 403, { error: 'Admin access requires localhost or ?key=<NOC_ADMIN_KEY>' });
        try { layout = dash.save(await readBody(req)); refreshNeeds(); reanchorControl(); } catch (e) { return json(res, 400, { error: e.message }); }
        broadcast('config', { layout, control, serverNow: Date.now() }); broadcastData(); cycle();
        return json(res, 200, { layout });
      }
      if (p === '/api/settings' || p === '/api/settings/test') {
        if (!canAdmin(req, url)) return json(res, 403, { error: 'Admin access requires localhost or ?key=<NOC_ADMIN_KEY>' });
        if (p === '/api/settings' && req.method === 'GET') return json(res, 200, settings.get());
        if (p === '/api/settings' && req.method === 'PUT') {
          try { settings.save(await readBody(req)); } catch (e) { return json(res, 400, { error: e.message }); }
          r1.reset(); schedule(); cycle();
          return json(res, 200, settings.get());
        }
        if (p === '/api/settings/test' && req.method === 'POST') {
          if (cfg.demo) return json(res, 200, { ok: false, error: 'Server is running in demo mode (NOC_DEMO=1) — restart without it to use live data.' });
          const cid = url.searchParams.get('customer');
          if (cid) { const c = (cfg.customers || []).find((x) => x.id === cid); if (!c) return json(res, 200, { ok: false, error: 'Unknown customer — save the list first' }); try { return json(res, 200, { ok: true, ...(await r1.createClient(c).test()) }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); } }
          try { return json(res, 200, { ok: true, ...(await r1.test()) }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
        }
      }
      if (p.startsWith('/api/upgrade')) {
        if (!canAdmin(req, url)) return json(res, 403, { error: 'Admin access requires localhost or ?key=<NOC_ADMIN_KEY>' });
        try {
          if (p === '/api/upgrade' && req.method === 'GET') return json(res, 200, upgrade.status());
          if (upgrade.disabled()) return json(res, 403, { error: 'Upgrades are disabled on this server (NOC_UPGRADE=off)' });
          if (p === '/api/upgrade/upload' && req.method === 'POST') {
            if (upgradeBusy) return json(res, 409, { error: 'Another upgrade step is running' });
            upgradeBusy = true; fs.mkdirSync(upgrade.DIR, { recursive: true }); const tmp = path.join(upgrade.DIR, `incoming-${Date.now()}.bin`); let n = 0;
            try {
              await new Promise((resolve, reject) => { const out = fs.createWriteStream(tmp); req.on('data', (c) => { n += c.length; if (n > upgrade.MAX_FILE) { req.destroy(); out.destroy(); reject(new Error('The file is larger than 100 MB')); } }); req.pipe(out); out.on('finish', resolve); out.on('error', reject); req.on('error', reject); });
              upgrade.cleanWork(); const plan = await upgrade.inspect(tmp); plan.file = String(url.searchParams.get('name') || plan.file).replace(/[^\w. -]/g, '_').slice(0, 80); return json(res, 200, plan);
            } finally { upgradeBusy = false; try { fs.unlinkSync(tmp); } catch { /* gone */ } }
          }
          if (p === '/api/upgrade/apply' && req.method === 'POST') {
            if (upgradeBusy) return json(res, 409, { error: 'Another upgrade step is running' });
            const b = await readBody(req); upgradeBusy = true;
            try { const r = await upgrade.apply(String(b.id || ''), { allowOlder: Boolean(b.allowDowngrade) }); json(res, 200, { ok: true, ...r, supervised: upgrade.supervised() }); upgrade.restart(); return; } finally { upgradeBusy = false; }
          }
          if (p === '/api/upgrade/rollback' && req.method === 'POST') {
            if (upgradeBusy) return json(res, 409, { error: 'Another upgrade step is running' });
            upgradeBusy = true; try { const r = await upgrade.rollback(); json(res, 200, { ok: true, ...r, supervised: upgrade.supervised() }); upgrade.restart(); return; } finally { upgradeBusy = false; }
          }
          if (p.startsWith('/api/upgrade/staged/') && req.method === 'DELETE') { upgrade.discard(decodeURIComponent(p.slice(20))); return json(res, 200, { ok: true }); }
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (p.startsWith('/api/tls') || p.startsWith('/api/backup') || p.startsWith('/api/restore')) {
        if (!canAdmin(req, url)) return json(res, 403, { error: 'Admin access requires localhost or ?key=<NOC_ADMIN_KEY>' });
        try {
          if (p === '/api/tls' && req.method === 'GET') return json(res, 200, { ...tls.info(), listening: httpsPort || 0, hostSuggestions: tls.defaultHosts() });
          if (p === '/api/tls/config' && req.method === 'PUT') { tls.saveConfig(await readBody(req)); applyTls(); await settle(); return json(res, 200, { ...tls.info(), listening: httpsPort || 0 }); }
          if (p === '/api/tls/self-signed' && req.method === 'POST') { await tls.selfSigned(await readBody(req)); applyTls(); await settle(); return json(res, 200, { ...tls.info(), listening: httpsPort || 0 }); }
          if (p === '/api/tls/csr' && req.method === 'POST') return json(res, 200, { csr: await tls.csr(await readBody(req)) });
          if (p === '/api/tls/csr' && req.method === 'GET') { const c = tls.pendingCsr(); if (!c) return json(res, 404, { error: 'No pending CSR' }); res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Content-Disposition': 'attachment; filename="r1-noc-wall.csr"' }); return res.end(c); }
          if (p === '/api/tls/install' && req.method === 'POST') { tls.install(await readBody(req, 1024 * 1024)); applyTls(); await settle(); return json(res, 200, { ...tls.info(), listening: httpsPort || 0 }); }
          if (p === '/api/tls' && req.method === 'DELETE') { tls.remove(); applyTls(); return json(res, 200, { ...tls.info(), listening: 0 }); }
          if (p === '/api/backup' && req.method === 'POST') { const b = await readBody(req); const r = backup.create({ full: Boolean(b.full), passphrase: b.passphrase }); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${r.name}"`, 'Cache-Control': 'no-store' }); return res.end(r.text); }
          if (p === '/api/backups' && req.method === 'GET') return json(res, 200, backup.list());
          if (p.startsWith('/api/backups/') && req.method === 'GET') { const t = backup.read(decodeURIComponent(p.slice(13))); if (t == null) return json(res, 404, { error: 'Not found' }); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${decodeURIComponent(p.slice(13))}"` }); return res.end(t); }
          if (p === '/api/restore/inspect' && req.method === 'POST') { const b = await readBody(req, 16 * 1024 * 1024); return json(res, 200, backup.inspect(b.bundle, b.passphrase)); }
          if (p === '/api/restore' && req.method === 'POST') {
            const b = await readBody(req, 16 * 1024 * 1024); const r = backup.restore(b.bundle, b.passphrase, b.parts);
            if (r.layout) { layout = r.layout; refreshNeeds(); reanchorControl(); broadcast('config', { layout, control, serverNow: Date.now() }); }
            refreshNeeds(); applyTls(); schedule(); cycle(); broadcastData();
            return json(res, 200, { ok: true, snapshot: r.snapshot, applied: r.applied });
          }
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (p === '/api/control' && req.method === 'POST') {
        try { applyControl(await readBody(req)); } catch (e) { return json(res, 400, { error: e.message }); }
        broadcast('control', { control, serverNow: Date.now() });
        return json(res, 200, { control, serverNow: Date.now() });
      }
      if (p === '/api/alerts/ack' && req.method === 'POST') {
        const b = await readBody(req); rules.ack(String(b.key || ''), Math.max(0, Math.min(1440, Number(b.minutes) || 0)));
        broadcastData(); return json(res, 200, { alerts: rules.active() });
      }
      if (p === '/api/rules' || p === '/api/notify' || p === '/api/notify/test') {
        if (!canAdmin(req, url)) return json(res, 403, { error: 'Admin access requires localhost or ?key=<NOC_ADMIN_KEY>' });
        if (p === '/api/rules' && req.method === 'GET') return json(res, 200, { rules: rules.get(), metrics: rules.catalog(), active: rules.active() });
        if (p === '/api/rules' && req.method === 'PUT') {
          try { rules.save(await readBody(req)); } catch (e) { return json(res, 400, { error: e.message }); }
          refreshNeeds(); evaluateRules(); cycle(); return json(res, 200, { rules: rules.get(), active: rules.active() });
        }
        if (p === '/api/notify' && req.method === 'GET') return json(res, 200, { channels: notify.list(), status: notify.status() });
        if (p === '/api/notify' && req.method === 'PUT') {
          try { return json(res, 200, { channels: notify.save(await readBody(req)) }); } catch (e) { return json(res, 400, { error: e.message }); }
        }
        if (p === '/api/notify/test' && req.method === 'POST') {
          try { await notify.test(String((await readBody(req)).id || '')); return json(res, 200, { ok: true }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
        }
      }
      if (p === '/api/reports' || p === '/api/reports/run') {
        if (!canAdmin(req, url)) return json(res, 403, { error: 'Admin access requires localhost or ?key=<NOC_ADMIN_KEY>' });
        if (p === '/api/reports' && req.method === 'GET') return json(res, 200, { reports: report.get(), files: report.files(), views: ['Main', ...(layout.views || []).map((v) => v.name)].map((n) => ({ name: n, screens: dash.viewByName(layout, n).screens.map((x) => x.name) })) });
        if (p === '/api/reports' && req.method === 'PUT') { try { report.save(await readBody(req)); } catch (e) { return json(res, 400, { error: e.message }); } return json(res, 200, { reports: report.get(), files: report.files() }); }
        if (p === '/api/reports/run' && req.method === 'POST') {
          const body = await readBody(req); const rep = report.get().find((x) => x.id === String(body.id || ''));
          if (!rep) return json(res, 404, { error: 'Unknown report' });
          try { const r = await runReport(rep); return json(res, 200, { ok: true, ...r, files: report.files(), reports: report.get() }); } catch (e) { report.mark(rep.id, `Failed: ${e.message}`); return json(res, 200, { ok: false, error: e.message, reports: report.get() }); }
        }
      }
      if (p === '/api/ticker' || p === '/api/ticker/test') {
        if (!canAdmin(req, url)) return json(res, 403, { error: 'Admin access requires localhost or ?key=<NOC_ADMIN_KEY>' });
        if (p === '/api/ticker' && req.method === 'GET') return json(res, 200, { config: feeds.get(), status: feeds.status() });
        if (p === '/api/ticker' && req.method === 'PUT') { try { const c = feeds.save(await readBody(req), broadcastData); broadcastData(); return json(res, 200, { config: c, status: feeds.status() }); } catch (e) { return json(res, 400, { error: e.message }); } }
        if (p === '/api/ticker/test' && req.method === 'POST') { try { const r = await feeds.test(await readBody(req)); return json(res, 200, { ok: true, lines: r.lines, resolved: r.feed.type === 'weather' ? { lat: r.feed.lat, lon: r.feed.lon, label: r.feed.label } : null }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); } }
      }
      if (p === '/api/diagnostics') {
        if (!canAdmin(req, url)) return json(res, 403, { error: 'Admin access required' });
        const S = collect.get();
        return json(res, 200, { source: S.source, at: S.at, errors: S.errors, diag: S.diag || null });
      }
      if (p === '/api/config/reset' && req.method === 'POST') {
        if (!canAdmin(req, url)) return json(res, 403, { error: 'Admin access requires localhost or ?key=<NOC_ADMIN_KEY>' });
        layout = dash.save(dash.DEFAULT); refreshNeeds();
        broadcast('config', { layout, control, serverNow: Date.now() }); broadcastData(); cycle();
        return json(res, 200, { layout });
      }
      if (p === '/api/catalog') return json(res, 200, { widgets: widgets.catalog(), presets: dash.PRESETS });
      if (p === '/api/data') return json(res, 200, buildData(venueParam(url)));
      if (p === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const conn = { res, venue: venueParam(url) };
        res.write(`event: data\ndata: ${JSON.stringify(buildData(conn.venue))}\n\n`);
        res.write(`event: control\ndata: ${JSON.stringify({ control, serverNow: Date.now() })}\n\n`);
        clients.add(conn);
        const ka = setInterval(() => res.write(': ka\n\n'), 25000);
        req.on('close', () => { clearInterval(ka); clients.delete(conn); });
        return;
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (!canView(req, url) && p !== '/favicon.ico') { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('Unauthorized — append ?key=…'); }
    if (p === '/report') {   // /report?id=<report id>  or  /report?view=Main&screen=Overview (screen=* for all)
      const saved = report.get().find((x) => x.id === url.searchParams.get('id'));
      const rep = saved || { id: 'adhoc', name: 'NOC report', view: url.searchParams.get('view') || 'Main', screen: url.searchParams.get('screen') || '*' };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(reportHtml(rep));
    }
    if (p.startsWith('/reports/')) {
      const f = path.join(report.DIR, path.basename(p));
      return fs.readFile(f, (err, buf) => { if (err) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf); });
    }
    const file = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
    const full = path.normalize(path.join(__dirname, 'public', file));
    if (!full.startsWith(path.join(__dirname, 'public') + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } catch (e) { json(res, 500, { error: e.message }); }
};
const server = http.createServer((req, res) => {
  const to = tls.redirectFor(req, httpsPort, isLoopback(req));
  if (to) { res.writeHead(301, { Location: to }); return res.end(); }
  return handle(req, res);
});
// (Re)start / stop the HTTPS listener to match data/tls/config.json. A new certificate is picked up without a restart.
function applyTls() {
  const st = tls.runtime();
  if (!st.ctx) { if (httpsServer) { httpsServer.closeAllConnections(); httpsServer.close(); httpsServer = null; httpsPort = 0; } if (st.enabled) tls.setError(st.problem || 'HTTPS not available'); return; }
  if (httpsServer && httpsPort === st.port) { httpsServer.setSecureContext(st.ctx); tls.setError(''); return; }
  if (httpsServer) { httpsServer.closeAllConnections(); httpsServer.close(); httpsServer = null; httpsPort = 0; }
  const hs = https.createServer(st.ctx, handle);
  hs.on('error', (e) => { tls.setError(`HTTPS port ${st.port}: ${e.message}`); console.error(`HTTPS: ${e.message}`); if (httpsServer === hs) { httpsServer = null; httpsPort = 0; } });
  hs.listen(st.port, () => { httpsServer = hs; httpsPort = st.port; tls.setError(''); console.log(`  HTTPS on https://localhost:${st.port}${st.redirect ? '  (HTTP redirects here)' : ''}`); });
}

// ---- polling loop ----
// Rules run after every poll and every 20 s (so "data is stale" and debounce timers advance even if polling hangs).
function evaluateRules() { const ev = rules.evaluate(collect.get()); if (ev.length) { notify.dispatch(ev); broadcastData(); } }
feeds.start(() => broadcastData());
function cycle() { collect.poll(() => { evaluateRules(); broadcastData(); }); }
setInterval(evaluateRules, 20000);
// A scheduled view change (e.g. 18:00 → "After hours") re-anchors the shared rotation clock for every display.
let lastView = dash.scheduledView(layout);
setInterval(() => { const v = dash.scheduledView(layout); if (v !== lastView) { lastView = v; reanchorControl(); broadcast('control', { control, serverNow: Date.now() }); broadcastData(); } }, 15000);
let timer = null;
function schedule() { clearInterval(timer); timer = setInterval(cycle, cfg.pollSeconds * 1000); }
cycle();
schedule();

upgrade.cleanWork();
backup.auto(); setInterval(backup.auto, 6 * 3600e3);   // daily credential-free snapshot (kept 14 days) in data/backups
let bindTries = 0;   // after an in-app restart the old process may still hold the port for a moment
server.on('error', (e) => { if (e.code === 'EADDRINUSE' && process.env.NOC_RESTARTED && bindTries++ < 40) return void setTimeout(() => server.listen(cfg.port), 500); console.error(`Cannot listen on port ${cfg.port}: ${e.message}`); process.exit(1); });
server.listen(cfg.port, () => {
  applyTls();
  console.log(`R1 NOC Wall ${upgrade.version()} on http://localhost:${cfg.port}  (${cfg.demo ? 'DEMO data' : 'live R1'}, poll ${cfg.pollSeconds}s)`);
  console.log(`  viewer: /${cfg.viewKey ? '?key=<NOC_VIEW_KEY>' : ''}    editor: /admin${cfg.adminKey ? '?key=<NOC_ADMIN_KEY>' : ' (localhost only)'}`);
});
