'use strict';
// Self-signed certificates and certificate signing requests with nothing but node:crypto — no openssl needed (so it works the same on
// Windows, macOS and the appliance). Builds the ASN.1 DER by hand and signs it with the key.
const crypto = require('node:crypto');
const net = require('node:net');

// ---- minimal DER encoder ----
const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x82, n >> 8, n & 255]) : Buffer.from([0x83, n >> 16, (n >> 8) & 255, n & 255]));
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p), set = (...p) => tlv(0x31, ...p);
const int = (buf) => { let b = Buffer.from(buf); while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); };
const oid = (s) => { const a = s.split('.').map(Number); const out = [a[0] * 40 + a[1]]; for (const v of a.slice(2)) { const t = [v & 127]; for (let x = v >> 7; x > 0; x >>= 7) t.unshift((x & 127) | 128); out.push(...t); } return tlv(0x06, Buffer.from(out)); };
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8')), octets = (b) => tlv(0x04, b), bitstr = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b])), bool = (v) => tlv(0x01, Buffer.from([v ? 255 : 0])), nul = () => Buffer.from([0x05, 0x00]);
const time = (d) => { const p = (n) => String(n).padStart(2, '0'); const y = d.getUTCFullYear(); const body = `${y >= 2050 ? y : String(y).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; return tlv(y >= 2050 ? 0x18 : 0x17, Buffer.from(body)); };
const ctx = (n, ...p) => tlv(0xa0 + n, ...p);

const OID = { cn: '2.5.4.3', org: '2.5.4.10', san: '2.5.29.17', ku: '2.5.29.15', eku: '2.5.29.37', bc: '2.5.29.19', ski: '2.5.29.14', serverAuth: '1.3.6.1.5.5.7.3.1', extReq: '1.2.840.113549.1.9.14', rsaSha256: '1.2.840.113549.1.1.11', ecSha256: '1.2.840.10045.4.3.2' };
const name = (cn, org) => seq(...(org ? [set(seq(oid(OID.org), utf8(org)))] : []), set(seq(oid(OID.cn), utf8(cn))));
const ext = (o, value, critical) => seq(oid(o), ...(critical ? [bool(true)] : []), octets(value));

function ipBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  const [head, tail = ''] = ip.split('::'); const h = head ? head.split(':') : [], t = tail ? tail.split(':') : []; const all = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return Buffer.concat(all.map((x) => Buffer.from([parseInt(x || '0', 16) >> 8, parseInt(x || '0', 16) & 255])));
}
const sanExt = (hosts) => ext(OID.san, seq(...hosts.map((h) => (net.isIP(h) ? tlv(0x87, ipBytes(h)) : tlv(0x82, Buffer.from(h, 'ascii'))))));

function newKey(type) {
  if (type === 'ec') return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}
const sigAlg = (type) => (type === 'ec' ? seq(oid(OID.ecSha256)) : seq(oid(OID.rsaSha256), nul()));
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END ${label}-----\n`;

function selfSigned({ commonName, hosts, days = 825, keyType = 'rsa' }) {
  const { publicKey, privateKey } = newKey(keyType); const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyBits = crypto.createHash('sha1').update(spki).digest();   // subjectKeyIdentifier (a stable 20-byte id)
  const now = new Date(Date.now() - 5 * 60e3), end = new Date(Date.now() + days * 86400e3); const n = name(commonName);
  const tbs = seq(ctx(0, int(Buffer.from([2]))), int(Buffer.concat([Buffer.from([1]), crypto.randomBytes(15)])), sigAlg(keyType), n, seq(time(now), time(end)), n, spki,
    ctx(3, seq(ext(OID.bc, seq(), true), ext(OID.ku, tlv(0x03, keyType === 'ec' ? Buffer.from([7, 0x80]) : Buffer.from([5, 0xa0])), true), ext(OID.eku, seq(oid(OID.serverAuth))), ext(OID.ski, octets(keyBits)), sanExt(hosts))));
  const sig = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, sigAlg(keyType), bitstr(sig));
  return { cert: pem('CERTIFICATE', der), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

function csr({ commonName, organization, hosts, keyType = 'rsa' }) {
  const { publicKey, privateKey } = newKey(keyType); const spki = publicKey.export({ type: 'spki', format: 'der' });
  const info = seq(int(Buffer.from([0])), name(commonName, organization), spki, ctx(0, seq(oid(OID.extReq), set(seq(sanExt(hosts))))));
  const sig = crypto.sign('sha256', info, privateKey);
  return { csr: pem('CERTIFICATE REQUEST', seq(info, sigAlg(keyType), bitstr(sig))), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
module.exports = { selfSigned, csr };
