'use strict';
// R1 NOC Wall launcher — becomes the single-file R1-NOC-Wall.exe (Node.js "single executable application").
// It starts the app that sits in the app\ folder next to the exe, so in-place upgrades from the editor keep working.
//   portable.txt next to the exe  →  data is kept in .\data      otherwise  →  %LOCALAPPDATA%\R1 NOC Wall\data (~/Library/Application Support/... on a Mac)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { createRequire } = require('node:module');
const { exec } = require('node:child_process');

const exe = process.execPath, base = path.dirname(exe), appDir = path.join(base, 'app');
const entry = path.join(appDir, 'server.js');
const load = (file) => createRequire(path.join(path.dirname(file), 'x.js'))(file);

// Used by the in-app updater's start-up test: act like plain `node <script>`.
if (process.env.NOC_RUN_AS_NODE) {
  const script = process.argv.find((a, i) => i > 0 && /\.js$/i.test(a));
  if (script) { process.chdir(path.dirname(path.resolve(script))); load(path.resolve(script)); return; }
}

const portable = fs.existsSync(path.join(base, 'portable.txt'));
const support = process.env.R1NOC_DATA ? path.dirname(process.env.R1NOC_DATA)
  : portable ? base : path.join(process.env.LOCALAPPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.local', 'share')), 'R1 NOC Wall');
const data = process.env.R1NOC_DATA || path.join(support, 'data');
fs.mkdirSync(data, { recursive: true });

const free = (p) => new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, () => s.close(() => res(true))); });
(async () => {
  if (!fs.existsSync(entry)) { console.error(`Cannot find ${entry}\nKeep the "app" folder next to ${path.basename(exe)}.`); return pause(); }
  const portFile = path.join(support, 'port.txt'); let port = Number(process.env.PORT) || 0;
  if (!port) { try { port = Number(fs.readFileSync(portFile, 'utf8')) || 0; } catch { /* first run */ } }
  if (!port) { for (let p = 8080; p <= 8099; p++) if (await free(p)) { port = p; break; } port = port || 8080; fs.writeFileSync(portFile, String(port)); }
  Object.assign(process.env, { PORT: String(port), NOC_DATA_DIR: data, NOC_SUPERVISED: '', NOC_RESTART: process.env.NOC_RESTART || 'respawn', NOC_RESPAWN_CMD: JSON.stringify({ cmd: exe, args: [] }) });
  process.title = 'R1 NOC Wall'; process.chdir(appDir);
  console.log(`R1 NOC Wall  —  wall: http://localhost:${port}/   editor: http://localhost:${port}/admin\nData: ${data}\nLeave this window open (minimise it); close it to stop the wall.\n`);
  const first = !fs.existsSync(path.join(support, '.opened'));
  if (first || process.argv.includes('--open')) {
    fs.writeFileSync(path.join(support, '.opened'), '');
    setTimeout(() => exec(process.platform === 'win32' ? `start "" "http://localhost:${port}/${first ? 'admin' : ''}"` : process.platform === 'darwin' ? `open "http://localhost:${port}/"` : `xdg-open "http://localhost:${port}/"`), 2500);
  }
  load(entry);
})().catch((e) => { console.error(e.stack || e.message); pause(); });
function pause() { console.error('\nPress Ctrl+C to close.'); setInterval(() => {}, 1 << 30); }
