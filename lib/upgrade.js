'use strict';
// In-place upgrade from a downloaded release file (.tgz / .tar.gz, or the .zip GitHub offers as "Download ZIP").
// Flow: stage → inspect (safe extraction + checks) → smoke test (the new code must boot in a throw-away demo instance)
//       → back up the current code → swap in the new files → restart.  Your data/ folder and .env are never touched.
// Also usable offline:  node scripts/upgrade.js <file>   /   node scripts/upgrade.js --rollback
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const cfg = require('./config');

const APP = cfg.ROOT;
const DIR = path.join(cfg.DATA_DIR, 'upgrade');
const PREV = path.join(DIR, 'previous');
const STATE = path.join(DIR, 'state.json');
const PRESERVE = new Set(['data', '.env', 'node_modules', '.git', '.gitignore', '.DS_Store']);   // never replaced, even if the package contains them
const MAX_FILE = 100 * 1024 * 1024, MAX_UNPACKED = 300 * 1024 * 1024, MAX_ENTRIES = 8000;

const sh = (cmd, args, opt = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024, ...opt }, (e, out, err) => (e ? reject(new Error(e.code === 'ENOENT' ? `"${cmd}" is not installed on this server` : `${cmd}: ${String(err || e.message).trim().split('\n').slice(-2).join(' ')}`)) : resolve(out))));
const pkgOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } };
const version = () => (pkgOf(APP) || {}).version || '0.0.0';
const cmp = (a, b) => { const x = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0), y = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; } return 0; };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };
const disabled = () => /^(off|0|false|no)$/i.test(process.env.NOC_UPGRADE || '');

// ---- supervision / restart ----
const supervised = () => {
  const m = process.env.NOC_RESTART; if (m) return m === 'exit';
  return Boolean(process.env.INVOCATION_ID || process.env.pm_id || process.env.NOC_SUPERVISED || (process.env.XPC_SERVICE_NAME && !/^(0|application\..*)$/.test(process.env.XPC_SERVICE_NAME)) || fs.existsSync('/.dockerenv'));
};
function restart(delayMs = 800) {
  setTimeout(() => {
    if (supervised()) { console.log('Upgrade applied — exiting so the service manager restarts the app.'); process.exit(0); }
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true }); const log = fs.openSync(path.join(cfg.DATA_DIR, 'server.log'), 'a');
    const child = spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), env: { ...process.env, NOC_RESTARTED: '1' }, detached: true, stdio: ['ignore', log, log] });
    child.unref(); console.log('Upgrade applied — restarting (output continues in data/server.log).'); process.exit(0);
  }, delayMs);
}

// ---- stage + inspect ----
const kindOf = (file) => { const h = Buffer.alloc(4); const fd = fs.openSync(file, 'r'); fs.readSync(fd, h, 0, 4, 0); fs.closeSync(fd); return h[0] === 0x1f && h[1] === 0x8b ? 'tgz' : h[0] === 0x50 && h[1] === 0x4b ? 'zip' : null; };
const sha256 = (file) => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
function checkNames(names) {
  if (names.length > MAX_ENTRIES) throw new Error(`The package has too many files (${names.length})`);
  for (const n of names) { const t = n.replace(/\\/g, '/'); if (t.startsWith('/') || /^[A-Za-z]:/.test(t) || t.split('/').includes('..')) throw new Error(`Unsafe path in the package: ${n.slice(0, 80)}`); }
}
function walk(dir, fn) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isSymbolicLink()) throw new Error(`The package contains a symbolic link (${e.name}) — refusing`); if (e.isDirectory()) walk(p, fn); else if (e.isFile()) fn(p); else throw new Error(`The package contains a special file (${e.name}) — refusing`); } }

async function inspect(file) {
  const kind = kindOf(file); if (!kind) throw new Error('That is not a .tgz/.tar.gz or .zip file');
  const st = fs.statSync(file); if (st.size > MAX_FILE) throw new Error('The file is larger than 100 MB');
  const sum = await sha256(file);
  let names; try { names = (await sh('tar', [kind === 'tgz' ? '-tzf' : '-tf', file])).split('\n').filter(Boolean); } catch (e) { if (kind === 'zip') { try { names = (await sh('unzip', ['-Z1', file])).split('\n').filter(Boolean); } catch { throw new Error('Cannot read this .zip on this server (needs bsdtar or unzip) — upload the .tgz release instead'); } } else throw e; }
  checkNames(names);
  fs.mkdirSync(DIR, { recursive: true }); const work = path.join(DIR, `work-${stamp()}-${crypto.randomBytes(3).toString('hex')}`); fs.mkdirSync(work);
  try {
    if (kind === 'tgz') await sh('tar', ['-xzf', file, '-C', work, '--no-same-owner']);
    else { try { await sh('tar', ['-xf', file, '-C', work, '--no-same-owner']); } catch { await sh('unzip', ['-q', file, '-d', work]); } }
    let total = 0; walk(work, (p) => { total += fs.statSync(p).size; if (total > MAX_UNPACKED) throw new Error('The unpacked package is larger than 300 MB'); });
    const top = fs.readdirSync(work).filter((n) => !n.startsWith('._') && n !== '__MACOSX'); const one = top.length === 1 && fs.statSync(path.join(work, top[0])).isDirectory();
    const root = one ? path.join(work, top[0]) : work;
    const pkg = pkgOf(root);
    if (!pkg || pkg.name !== 'r1-noc') throw new Error('This does not look like an R1 NOC Wall release (package.json missing or a different app)');
    for (const need of ['server.js', 'lib', 'public']) if (!fs.existsSync(path.join(root, need))) throw new Error(`The package is incomplete (${need} is missing)`);
    const eng = /(\d+)\.(\d+)/.exec((pkg.engines || {}).node || ''); const nodeOk = !eng || cmp(process.versions.node, `${eng[1]}.${eng[2]}.0`) >= 0;
    let notes = ''; for (const n of ['UPGRADE.md', 'CHANGELOG.md']) { try { notes = fs.readFileSync(path.join(root, n), 'utf8').slice(0, 1500); break; } catch { /* none */ } }
    const current = version(); const c = cmp(pkg.version, current);
    const plan = { id: path.basename(work), file: path.basename(file), size: st.size, sha256: sum, kind, version: pkg.version, current, relation: c > 0 ? 'newer' : c < 0 ? 'older' : 'same', nodeOk, nodeNeeds: (pkg.engines || {}).node || '', notes, entries: fs.readdirSync(root).filter((n) => !PRESERVE.has(n)), root: path.relative(DIR, root) };
    fs.writeFileSync(path.join(work, 'plan.json'), JSON.stringify(plan)); return plan;
  } catch (e) { rmrf(work); throw e; }
}
const planOf = (id) => { if (!/^work-[\w-]+$/.test(id)) throw new Error('Unknown staged upgrade'); try { return JSON.parse(fs.readFileSync(path.join(DIR, id, 'plan.json'), 'utf8')); } catch { throw new Error('That staged upgrade is no longer available — upload the file again'); } };
function discard(id) { if (/^work-[\w-]+$/.test(id)) rmrf(path.join(DIR, id)); }
function cleanWork(keepId) { try { for (const n of fs.readdirSync(DIR)) if (/^work-/.test(n) && n !== keepId) rmrf(path.join(DIR, n)); } catch { /* none */ } }

// ---- smoke test: boot the NEW code in a throw-away demo instance on a free port ----
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
async function smoke(rootDir) {
  const port = await freePort(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r1noc-smoke-'));
  const child = spawn(process.execPath, [path.join(rootDir, 'server.js')], { cwd: rootDir, env: { PATH: process.env.PATH || '', HOME: process.env.HOME || tmp, NOC_DEMO: '1', NOC_DATA_DIR: tmp, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let exited = null; child.on('exit', (c) => { exited = c; });
  try {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (exited !== null) { const lines = out.split('\n').map((l) => l.trim()).filter(Boolean); const hit = lines.find((l) => /(Syntax|Reference|Type)?Error|Cannot find|EADDR|Unexpected/.test(l)) || lines[lines.length - 1] || 'no output'; throw new Error(`The new version failed to start: ${hit.slice(0, 240)}`); }
      const ok = await new Promise((res) => { const r = http.get({ host: '127.0.0.1', port, path: '/api/config', timeout: 2000 }, (resp) => { let b = ''; resp.on('data', (d) => { b += d; }); resp.on('end', () => { try { res(resp.statusCode === 200 && Boolean(JSON.parse(b).layout)); } catch { res(false); } }); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); });
      if (ok) return true; await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('The new version did not start within 25 seconds');
  } finally { child.kill('SIGKILL'); setTimeout(() => rmrf(tmp), 500); }
}

// ---- apply ----
async function backupCurrent() {
  fs.mkdirSync(PREV, { recursive: true }); const f = path.join(PREV, `app-${version()}-${stamp()}.tgz`);
  await sh('tar', ['-czf', f, '--exclude=./data', '--exclude=./.env', '--exclude=./node_modules', '--exclude=./.git', '-C', APP, '.']);
  const l = fs.readdirSync(PREV).filter((n) => n.endsWith('.tgz')).sort(); for (const n of l.slice(0, Math.max(0, l.length - 3))) fs.unlinkSync(path.join(PREV, n));
  return path.basename(f);
}
function swapIn(root) {
  const done = []; const stampN = Date.now();
  try {
    for (const name of fs.readdirSync(root)) {
      if (PRESERVE.has(name) || name.startsWith('._')) continue;
      const src = path.join(root, name), dst = path.join(APP, name), nu = `${dst}.new-${stampN}`, old = `${dst}.old-${stampN}`;
      fs.cpSync(src, nu, { recursive: true });
      const had = fs.existsSync(dst); if (had) fs.renameSync(dst, old); fs.renameSync(nu, dst); done.push({ dst, old, had });
    }
  } catch (e) {   // put everything back
    for (const d of done.reverse()) { try { rmrf(d.dst); if (d.had) fs.renameSync(d.old, d.dst); } catch { /* best effort */ } }
    throw new Error(`Could not install the new files (${e.message}) — the previous version was restored`);
  }
  for (const d of done) if (d.had) rmrf(d.old);
}
async function apply(id, { allowOlder = false } = {}) {
  if (disabled()) throw new Error('Upgrades are disabled on this server (NOC_UPGRADE=off)');
  const plan = planOf(id); const root = path.join(DIR, plan.root);
  if (!plan.nodeOk) throw new Error(`This version needs Node.js ${plan.nodeNeeds} (this server runs ${process.versions.node})`);
  if (plan.relation === 'older' && !allowOlder) throw new Error('This is an older version than the one installed — tick "allow downgrade" to install it anyway');
  await smoke(root);                                   // refuse to install something that cannot start
  const backup = await backupCurrent();
  swapIn(root);
  saveState({ from: plan.current, to: plan.version, at: Date.now(), sha256: plan.sha256, file: plan.file, backup });
  cleanWork(); return { from: plan.current, to: plan.version, backup };
}
async function rollback() {
  if (disabled()) throw new Error('Upgrades are disabled on this server (NOC_UPGRADE=off)');
  const l = fs.existsSync(PREV) ? fs.readdirSync(PREV).filter((n) => n.endsWith('.tgz')).sort() : []; if (!l.length) throw new Error('There is no previous version to roll back to');
  const f = path.join(PREV, l[l.length - 1]); const plan = await inspect(f);
  try { const r = await apply(plan.id, { allowOlder: true }); const s = loadState(); saveState({ ...s, rollback: true }); return r; } finally { discard(plan.id); }
}
function status() {
  const prev = fs.existsSync(PREV) ? fs.readdirSync(PREV).filter((n) => n.endsWith('.tgz')).sort().reverse().map((n) => ({ name: n, bytes: fs.statSync(path.join(PREV, n)).size })) : [];
  return { version: version(), node: process.versions.node, disabled: disabled(), supervised: supervised(), last: loadState(), previous: prev };
}
module.exports = { version, status, inspect, apply, rollback, discard, cleanWork, restart, disabled, supervised, DIR, MAX_FILE };
