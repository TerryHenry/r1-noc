'use strict';
const http = require('node:http');
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

let layout = dash.load();
const refreshNeeds = () => collect.setNeeds(new Set([...widgets.needsFor({ screens: dash.allScreens(layout) }), ...rules.needs()]));
refreshNeeds();
const clients = new Set(); // SSE connections: { res, venue }  (venue = drill-down filter chosen by that client, '' = all)

// ---- shared rotation clock (so several displays stay on the same screen) ----
// Clients compute the current screen from this anchor + the server's clock, so there is no per-rotation traffic.
let control = { held: false, screen: 0, base: 0, t0: Date.now() };
const activeView = () => dash.viewByName(layout, dash.scheduledView(layout));
const nScreens = () => activeView().screens.length;
function currentIdx() {
  const n = nScreens();
  if (control.held) return Math.max(0, Math.min(control.screen, n - 1));
  const sec = activeView().rotateSeconds;
  const steps = sec > 0 ? Math.floor((Date.now() - control.t0) / (sec * 1000)) : 0;
  return (((control.base + steps) % n) + n) % n;
}
function applyControl(body) {
  const n = nScreens(); const idx = currentIdx(); const now = Date.now();
  const move = (target) => { target = ((target % n) + n) % n; if (control.held) control.screen = target; else { control.base = target; control.t0 = now; } };
  switch (body.action) {
    case 'next': move(idx + 1); break;
    case 'prev': move(idx - 1); break;
    case 'goto': move(Math.round(Number(body.screen)) || 0); break;
    case 'hold': control = { held: true, screen: idx, base: idx, t0: now }; break;
    case 'resume': control = { held: false, screen: idx, base: idx, t0: now }; break;
    default: throw new Error('Unknown control action');
  }
}
function reanchorControl() {   // layout changed: keep the current screen if it still exists
  const idx = Math.min(currentIdx(), nScreens() - 1);
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
function buildData(venue = '') {
  const S = collect.get();
  const out = {};
  for (const wd of dash.allWidgets(layout)) out[wd.id] = applyThresholds(wd, widgets.compute(venue && !wd.venue ? { ...wd, venue } : wd, S));
  return { at: S.at, serverNow: Date.now(), view: dash.scheduledView(layout), venue, source: S.source, errors: S.errors, pollSeconds: cfg.pollSeconds, alerts: rules.active(), summary: summaryOf(S), widgets: out };
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
const venueParam = (url) => { const v = url.searchParams.get('venue') || ''; return collect.get().venues.some((x) => x.id === v) ? v : ''; };

// ---- reports ----
function reportHtml(rep) {
  const view = dash.viewByName(layout, rep.view); const S = collect.get();
  const screens = rep.screen === '*' ? view.screens : view.screens.filter((x) => x.name === rep.screen);
  const data = {}; for (const sc of screens) for (const wd of sc.widgets) data[wd.id] = applyThresholds(wd, widgets.compute(wd, S));
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (!canView(req, url)) return json(res, 401, { error: 'Missing or wrong ?key=' });
      if (p === '/api/config' && req.method === 'GET') return json(res, 200, { layout, control, view: dash.scheduledView(layout), serverNow: Date.now(), venues: collect.get().venues, canAdmin: canAdmin(req, url) });
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
          try { return json(res, 200, { ok: true, ...(await r1.test()) }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
        }
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
});

// ---- polling loop ----
// Rules run after every poll and every 20 s (so "data is stale" and debounce timers advance even if polling hangs).
function evaluateRules() { const ev = rules.evaluate(collect.get()); if (ev.length) { notify.dispatch(ev); broadcastData(); } }
function cycle() { collect.poll(() => { evaluateRules(); broadcastData(); }); }
setInterval(evaluateRules, 20000);
// A scheduled view change (e.g. 18:00 → "After hours") re-anchors the shared rotation clock for every display.
let lastView = dash.scheduledView(layout);
setInterval(() => { const v = dash.scheduledView(layout); if (v !== lastView) { lastView = v; reanchorControl(); broadcast('control', { control, serverNow: Date.now() }); broadcastData(); } }, 15000);
let timer = null;
function schedule() { clearInterval(timer); timer = setInterval(cycle, cfg.pollSeconds * 1000); }
cycle();
schedule();

server.listen(cfg.port, () => {
  console.log(`R1 NOC on http://localhost:${cfg.port}  (${cfg.demo ? 'DEMO data' : 'live R1'}, poll ${cfg.pollSeconds}s)`);
  console.log(`  viewer: /${cfg.viewKey ? '?key=<NOC_VIEW_KEY>' : ''}    editor: /admin${cfg.adminKey ? '?key=<NOC_ADMIN_KEY>' : ' (localhost only)'}`);
});
