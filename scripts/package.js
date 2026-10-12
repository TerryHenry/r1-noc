'use strict';
// Build a release file for in-place upgrades:  npm run package   →   dist/r1-noc-<version>.tgz (+ .sha256)
// Uses the files tracked by git (so data/, .env and local notes never ship); falls back to a plain directory walk.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `r1-noc-${pkg.version}`; const out = path.join(root, 'dist'); fs.mkdirSync(out, { recursive: true });
const file = path.join(out, `${name}.tgz`);
let list;
try { list = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); if (!list.length) throw new Error('empty'); }
catch { const skip = new Set(['data', 'dist', '.git', '.env', 'node_modules', '.DS_Store']); list = []; (function walk(d) { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { if (skip.has(e.name)) continue; const rel = path.join(d, e.name); if (e.isDirectory()) walk(rel); else if (e.isFile()) list.push(rel); } })('.'); }
list = list.filter((f) => !f.startsWith('dist/') && !f.startsWith('packaging/') && fs.existsSync(path.join(root, f)));   // packaging/ builds releases; it is not part of the running app
const dirty = (() => { try { return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } })();
const listFile = path.join(out, `${name}.files`); fs.writeFileSync(listFile, list.join('\n') + '\n');
// stage under a versioned top folder so the archive unpacks tidily
const stage = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'r1noc-pkg-')); const top = path.join(stage, name);
for (const f of list) { const dst = path.join(top, f); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(root, f), dst); }
execFileSync('tar', ['-czf', file, '-C', stage, name]); fs.rmSync(stage, { recursive: true, force: true }); fs.unlinkSync(listFile);
const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); fs.writeFileSync(`${file}.sha256`, `${sum}  ${path.basename(file)}\n`);
console.log(`${path.relative(root, file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB  ${list.length} files\nsha256 ${sum}`);
if (dirty) console.log('\nNote: the working tree has uncommitted changes; the package contains the files as they are on disk.');
