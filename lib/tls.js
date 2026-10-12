'use strict';
// HTTPS + certificate management. Files live in data/tls/ (server.key is 0600 and is never sent to a browser):
//   config.json  { enabled, port, redirect, hsts }      server.crt  leaf certificate + any chain      server.key  private key
//   pending.key / pending.csr  a key pair created by "Generate CSR", waiting for the CA's signed certificate
// Self-signed certificates and CSRs are produced with the system `openssl` (no shell: arguments are passed as an array).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { DATA_DIR } = require('./config');

const DIR = path.join(DATA_DIR, 'tls');
const P = { cfg: path.join(DIR, 'config.json'), crt: path.join(DIR, 'server.crt'), key: path.join(DIR, 'server.key'), pkey: path.join(DIR, 'pending.key'), csr: path.join(DIR, 'pending.csr') };
const DEFAULTS = { enabled: false, port: 8443, redirect: false, hsts: false };
let lastError = '';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function write(f, data, mode = 0o644) { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(f + '.tmp', data, { mode }); fs.renameSync(f + '.tmp', f); fs.chmodSync(f, mode); }

function config() {
  let c = {}; try { c = JSON.parse(read(P.cfg)); } catch { /* defaults */ }
  const env = Number(process.env.HTTPS_PORT);
  const port = Number.isInteger(env) && env > 0 && env < 65536 ? env : Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : DEFAULTS.port;
  return { enabled: Boolean(c.enabled), port, redirect: Boolean(c.redirect), hsts: Boolean(c.hsts) };
}
function saveConfig(input) {
  const cur = config(); const next = { ...cur };
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.redirect !== undefined) next.redirect = Boolean(input.redirect);
  if (input.hsts !== undefined) next.hsts = Boolean(input.hsts);
  if (input.port !== undefined && input.port !== '') { const p = Number(input.port); if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Port must be 1–65535 (ports below 1024 need extra privileges)'); next.port = p; }
  if (next.enabled && !read(P.crt)) throw new Error('Install or generate a certificate first');
  write(P.cfg, JSON.stringify(next, null, 2)); return next;
}

// ---- certificate inspection ----
const pemBlocks = (pem) => (String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).map((b) => b.trim());
function describe(x) {
  const day = 86400e3; const to = Date.parse(x.validTo);
  return { subject: x.subject.replace(/\n/g, ', '), issuer: x.issuer.replace(/\n/g, ', '), validFrom: Date.parse(x.validFrom), validTo: to, daysLeft: Math.floor((to - Date.now()) / day), sans: (x.subjectAltName || '').split(/,\s*/).filter(Boolean), fingerprint: x.fingerprint256, serial: x.serialNumber, selfSigned: x.issuer === x.subject && x.verify(x.publicKey) };
}
function info() {
  const crt = read(P.crt); const out = { config: config(), installed: false, pendingCsr: Boolean(read(P.csr)), lastError, openssl: null };
  if (crt) {
    try {
      const blocks = pemBlocks(crt); const leaf = new crypto.X509Certificate(blocks[0]);
      out.installed = true; out.cert = { ...describe(leaf), chain: blocks.length - 1 };
      try { out.cert.keyMatches = leaf.checkPrivateKey(crypto.createPrivateKey(read(P.key))); } catch { out.cert.keyMatches = false; }
    } catch (e) { out.cert = { error: `Cannot read the installed certificate: ${e.message}` }; }
  }
  return out;
}
// Days until the installed certificate expires (null if none) — used by the "certificate expiring" alert metric.
function daysLeft() { try { const b = pemBlocks(read(P.crt))[0]; return b ? Math.floor((Date.parse(new crypto.X509Certificate(b).validTo) - Date.now()) / 86400e3) : null; } catch { return null; } }

// What https.createServer needs, or null when HTTPS is off / not usable.
function runtime() {
  const c = config(); if (!c.enabled) return { ...c, ctx: null };
  const cert = read(P.crt), key = read(P.key);
  if (!cert || !key) return { ...c, ctx: null, problem: 'certificate or key missing' };
  try { crypto.createPrivateKey(key); return { ...c, ctx: { cert, key } }; } catch (e) { return { ...c, ctx: null, problem: e.message }; }
}

// ---- openssl helpers ----
function openssl(args) {
  return new Promise((resolve, reject) => execFile('openssl', args, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(err.code === 'ENOENT' ? 'openssl was not found on this server. Install it, or paste an existing certificate and key instead.' : `openssl failed: ${String(stderr || err.message).split('\n').filter(Boolean).slice(-2).join(' ')}`));
    resolve(stdout);
  }));
}
const HOST = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
function sanList(hosts) {
  const list = [...new Set((Array.isArray(hosts) ? hosts : String(hosts || '').split(/[\s,;]+/)).map((h) => String(h).trim()).filter(Boolean))].slice(0, 30);
  if (!list.length) throw new Error('Enter at least one host name or IP address');
  return list.map((h) => { if (net.isIP(h)) return `IP:${h}`; if (HOST.test(h) && h.length <= 253) return `DNS:${h}`; throw new Error(`"${h.slice(0, 40)}" is not a valid host name or IP address`); });
}
const subj = (cn, org) => {
  const ok = (s) => /^[A-Za-z0-9 ._,'()-]{1,64}$/.test(s);
  if (!ok(cn)) throw new Error('Common name: 1–64 letters, digits, spaces or . _ - , \' ( )');
  if (org && !ok(org)) throw new Error('Organization: 1–64 letters, digits, spaces or . _ - , \' ( )');
  return `/CN=${cn.replace(/[/]/g, '')}${org ? `/O=${org.replace(/[/]/g, '')}` : ''}`;
};
const defaultHosts = () => [...new Set([os.hostname(), 'localhost', '127.0.0.1', ...Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)])];
const keyArgs = (type) => (type === 'ec' ? ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'] : ['-newkey', 'rsa:2048']);

async function selfSigned({ commonName, hosts, days, keyType } = {}) {
  const hs = hosts && hosts.length ? hosts : defaultHosts(); const san = sanList(hs); const cn = String(commonName || hs[0]).trim();
  const d = Math.max(1, Math.min(3650, Math.round(Number(days) || 825)));
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); const tk = P.key + '.new', tc = P.crt + '.new';
  try {
    await openssl(['req', '-x509', ...keyArgs(keyType), '-nodes', '-keyout', tk, '-out', tc, '-days', String(d), '-subj', subj(cn), '-addext', `subjectAltName=${san.join(',')}`, '-addext', 'keyUsage=digitalSignature,keyEncipherment', '-addext', 'extendedKeyUsage=serverAuth']);
    install({ cert: read(tc), key: read(tk) });
  } finally { for (const f of [tk, tc]) try { fs.unlinkSync(f); } catch { /* gone */ } }
  return info();
}
async function csr({ commonName, organization, hosts, keyType } = {}) {
  const hs = hosts && hosts.length ? hosts : defaultHosts(); const san = sanList(hs); const cn = String(commonName || hs[0]).trim();
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  await openssl(['req', '-new', ...keyArgs(keyType), '-nodes', '-keyout', P.pkey, '-out', P.csr, '-subj', subj(cn, organization), '-addext', `subjectAltName=${san.join(',')}`]);
  fs.chmodSync(P.pkey, 0o600); return read(P.csr);
}

// Install a certificate (leaf first, then any intermediates). The key may be pasted, or come from a pending CSR / the current key.
function install({ cert, key } = {}) {
  const blocks = pemBlocks(cert); if (!blocks.length) throw new Error('No certificate found — paste the PEM text (-----BEGIN CERTIFICATE-----)');
  let leaf; try { leaf = new crypto.X509Certificate(blocks[0]); } catch (e) { throw new Error(`The certificate cannot be read: ${e.message}`); }
  let keyPem = String(key || '').trim(); let from = 'pasted';
  if (!keyPem) { if (read(P.pkey)) { keyPem = read(P.pkey); from = 'pending'; } else if (read(P.key)) { keyPem = read(P.key); from = 'current'; } }
  if (!keyPem) throw new Error('A private key is needed: paste it, or generate a CSR first');
  let pk; try { pk = crypto.createPrivateKey(keyPem); } catch (e) { throw new Error(/passphrase|decrypt/i.test(e.message) ? 'The private key is passphrase-protected — decrypt it first (openssl rsa -in key.pem -out key-plain.pem)' : `The private key cannot be read: ${e.message}`); }
  if (!leaf.checkPrivateKey(pk)) throw new Error('The private key does not match this certificate' + (from === 'pending' ? ' (it was checked against your pending CSR key)' : ''));
  if (Date.parse(leaf.validTo) < Date.now()) throw new Error('This certificate has already expired');
  write(P.crt, blocks.join('\n') + '\n'); write(P.key, pk.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  for (const f of [P.pkey, P.csr]) try { fs.unlinkSync(f); } catch { /* none */ }
  lastError = ''; return info();
}
function remove() { for (const f of [P.crt, P.key, P.pkey, P.csr]) try { fs.unlinkSync(f); } catch { /* none */ } const c = config(); write(P.cfg, JSON.stringify({ ...c, enabled: false }, null, 2)); return info(); }
const setError = (m) => { lastError = m || ''; };
const pendingCsr = () => read(P.csr);

// "http://host/x" → "https://host:port/x" (or null): used when "redirect HTTP to HTTPS" is on. Loopback is never redirected.
function redirectFor(req, httpsPort, loopback) {
  if (!httpsPort || loopback || !config().redirect) return null;
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''); if (!host || /[\s/\\@]/.test(host)) return null;
  return `https://${host.includes(':') ? `[${host}]` : host}${httpsPort === 443 ? '' : ':' + httpsPort}${req.url}`;
}
module.exports = { info, config, saveConfig, runtime, install, remove, selfSigned, csr, pendingCsr, daysLeft, redirectFor, setError, defaultHosts, FILES: P, DIR };
