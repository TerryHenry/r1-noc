'use strict';
// Scrolling-text sources: custom messages, news (RSS/Atom), weather (Open-Meteo), stock quotes (Stooq).
// Config lives in data/ticker.json; fetched data is cached in memory and refreshed on a per-feed schedule.
// Weather (Open-Meteo) and quotes (Yahoo Finance chart endpoint) use free, key-less public services. Quotes are delayed;
// "change" is versus the previous close. The quote source is unofficial and may change without notice.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'ticker.json');
const UA = 'r1-noc/1.0 (+ticker)';
const MAX_BYTES = 2 * 1024 * 1024;

const DEFAULTS = { enabled: true, speed: 70, size: 'large', showStatus: true, messages: [], feeds: [] };
const clamp = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const str = (s, max = 200) => String(s == null ? '' : s).trim().slice(0, max);
const tsOrNull = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

function cleanFeed(f, i) {
  const type = ['rss', 'weather', 'stocks'].includes(f.type) ? f.type : 'rss';
  const out = { id: str(f.id, 30) || `f${Date.now().toString(36)}${i}`, type, enabled: f.enabled !== false, name: str(f.name, 40), refreshMinutes: clamp(f.refreshMinutes, 1, 1440, type === 'stocks' ? 5 : type === 'weather' ? 30 : 15) };
  if (type === 'rss') { out.url = str(f.url, 500); out.maxItems = clamp(f.maxItems, 1, 30, 8); if (out.url && !/^https?:\/\//i.test(out.url)) throw new Error(`"${out.name || 'News feed'}": URL must start with http:// or https://`); }
  if (type === 'weather') { out.place = str(f.place, 80); out.units = f.units === 'c' ? 'c' : 'f'; out.lat = Number.isFinite(Number(f.lat)) && f.lat !== '' && f.lat != null ? Number(f.lat) : null; out.lon = Number.isFinite(Number(f.lon)) && f.lon !== '' && f.lon != null ? Number(f.lon) : null; out.label = str(f.label, 80); }
  if (type === 'stocks') out.symbols = str(f.symbols, 300);
  return out;
}
function cleanMsg(m, i) { return { id: str(m.id, 30) || `m${Date.now().toString(36)}${i}`, enabled: m.enabled !== false, text: str(m.text, 300), tone: ['info', 'warn', 'bad', 'ok'].includes(m.tone) ? m.tone : 'info', from: m.from ? str(m.from, 30) : '', to: m.to ? str(m.to, 30) : '' }; }
function clean(c) { return { enabled: c.enabled !== false, speed: clamp(c.speed, 20, 300, 70), size: ['small', 'medium', 'large', 'xl'].includes(c.size) ? c.size : 'large', showStatus: c.showStatus !== false, messages: (c.messages || []).slice(0, 30).map(cleanMsg).filter((m) => m.text), feeds: (c.feeds || []).slice(0, 15).map(cleanFeed) }; }

let cfg = (() => { try { return clean(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { return clean(DEFAULTS); } })();
const cache = new Map();   // feed id → { at, items, error, ...extra }

// ---------------- HTTP ----------------
async function get(url, init = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (/^(169\.254\.|metadata\.google)/.test(u.hostname)) throw new Error('That address is not allowed');
  const res = await fetch(u, { ...init, headers: { 'User-Agent': UA, Accept: '*/*', ...(init.headers || {}) }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length')); if (len > MAX_BYTES) throw new Error('Response too large');
  const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > MAX_BYTES) throw new Error('Response too large');
  return buf.toString('utf8');
}

// ---------------- RSS / Atom ----------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m));
const text = (s) => decode(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();   // strip tags before AND after decoding (Atom often escapes its HTML)
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1] : ''; };
function parseFeed(xml, max = 8) {
  const items = [];
  for (const m of xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
    const b = m[0]; const title = text(tag(b, 'title')); if (!title) continue;
    const link = text(tag(b, 'link')) || ((b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || '');
    const when = tsOrNull(text(tag(b, 'pubDate')) || text(tag(b, 'published')) || text(tag(b, 'updated')) || text(tag(b, 'dc:date')));
    items.push({ title, link, at: when });
    if (items.length >= max) break;
  }
  const head = xml.split(/<(?:item|entry)[\s>]/i)[0]; const channel = text(tag(head, 'title'));
  return { channel, items };
}
async function fetchRss(f) { const r = parseFeed(await get(f.url), f.maxItems); if (!r.items.length) throw new Error('No items found — is this an RSS/Atom feed URL?'); return { channel: r.channel, items: r.items }; }

// ---------------- weather (Open-Meteo) ----------------
const WMO = { 0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail' };
const wmo = (c) => WMO[c] || 'Unknown';
async function geocode(place) {
  const j = JSON.parse(await get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`));
  const r = j.results && j.results[0]; if (!r) throw new Error(`Couldn't find a place called "${place}"`);
  return { lat: r.latitude, lon: r.longitude, label: [r.name, r.admin1, r.country].filter(Boolean).join(', ') };
}
async function fetchWeather(f) {
  if (f.lat == null || f.lon == null) { if (!f.place) throw new Error('Enter a place name'); const g = await geocode(f.place); f.lat = g.lat; f.lon = g.lon; f.label = g.label; }
  const imp = f.units !== 'c';
  const j = JSON.parse(await get(`https://api.open-meteo.com/v1/forecast?latitude=${f.lat}&longitude=${f.lon}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m,apparent_temperature&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=${imp ? 'fahrenheit' : 'celsius'}&wind_speed_unit=${imp ? 'mph' : 'kmh'}&timezone=auto&forecast_days=3`));
  const c = j.current || {}; const d = j.daily || {};
  return { place: f.label || f.place, units: imp ? 'F' : 'C', windUnit: imp ? 'mph' : 'km/h', now: { temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), text: wmo(c.weather_code), wind: Math.round(c.wind_speed_10m), humidity: c.relative_humidity_2m },
    days: (d.time || []).map((t, i) => ({ date: t, hi: Math.round(d.temperature_2m_max[i]), lo: Math.round(d.temperature_2m_min[i]), pop: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null, text: wmo(d.weather_code[i]) })) };
}

// ---------------- quotes (Yahoo Finance chart endpoint — free, no key, unofficial) ----------------
// Works for stocks (AAPL), indices (^GSPC, ^DJI), FX (EURUSD=X) and crypto (BTC-USD). One request per symbol.
// It is an unofficial endpoint: delayed, and it may change or stop working without notice.
async function fetchStocks(f) {
  const list = [...new Set(f.symbols.split(/[\s,;]+/).filter(Boolean))].slice(0, 15); if (!list.length) throw new Error('Enter at least one symbol');
  const results = await Promise.allSettled(list.map(async (sym) => {
    const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`));
    const m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta; if (!m || !Number.isFinite(m.regularMarketPrice)) throw new Error(`No data for ${sym}`);
    const prev = Number.isFinite(m.chartPreviousClose) ? m.chartPreviousClose : m.previousClose; const chg = Number.isFinite(prev) ? m.regularMarketPrice - prev : 0;
    return { symbol: String(m.symbol || sym).toUpperCase().replace(/=X$/, ''), price: m.regularMarketPrice, change: chg, pct: Number.isFinite(prev) && prev ? (chg / prev) * 100 : 0, currency: m.currency || '' };
  }));
  const items = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!items.length) throw new Error(`No quotes returned — ${results[0].reason.message.replace(/^HTTP 404$/, 'symbol not found')}. Examples: AAPL, ^GSPC, EURUSD=X, BTC-USD`);
  const bad = results.map((r, i) => (r.status === 'rejected' ? list[i] : null)).filter(Boolean);
  return { items, notFound: bad };
}

const FETCHERS = { rss: fetchRss, weather: fetchWeather, stocks: fetchStocks };
async function refresh(f) {
  try { const r = await FETCHERS[f.type](f); cache.set(f.id, { at: Date.now(), ...r, error: null }); }
  catch (e) { const old = cache.get(f.id) || {}; cache.set(f.id, { ...old, at: old.at || 0, tried: Date.now(), error: e.message }); }
  return cache.get(f.id);
}
let timer = null;
function start(onUpdate) {
  clearInterval(timer);
  const tick = async () => { let changed = false; for (const f of cfg.feeds) { if (!f.enabled) continue; const c = cache.get(f.id); const due = !c || Date.now() - Math.max(c.at || 0, c.tried || 0) >= f.refreshMinutes * 60000; if (due) { await refresh(f); changed = true; } } if (changed) { persistResolved(); onUpdate && onUpdate(); } };
  tick(); timer = setInterval(tick, 30000);
}
function persistResolved() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 }); fs.renameSync(FILE + '.tmp', FILE); } catch { /* ignore */ } }   // keeps geocoded lat/lon

// ---------------- config API ----------------
const get_ = () => cfg;
function save(input, onUpdate) {
  const next = clean(input);
  for (const f of next.feeds) { const old = cfg.feeds.find((x) => x.id === f.id); if (old && old.type === 'weather' && f.type === 'weather' && old.place === f.place) { f.lat = old.lat; f.lon = old.lon; f.label = old.label; } else if (f.type === 'weather') { f.lat = null; f.lon = null; f.label = ''; } }
  for (const id of [...cache.keys()]) if (!next.feeds.some((f) => f.id === id)) cache.delete(id);
  for (const f of next.feeds) { const old = cfg.feeds.find((x) => x.id === f.id); if (!old || JSON.stringify(old) !== JSON.stringify(f)) cache.delete(f.id); }   // changed → refetch now
  cfg = next; persistResolved(); start(onUpdate); return cfg;
}
async function test(feed) { const f = cleanFeed({ ...feed, id: 'test' }, 0); const r = await FETCHERS[f.type](f); return { feed: f, result: r, lines: previewLines(f, r) }; }

// ---------------- outputs ----------------
const ago = (t) => { if (!t) return ''; const s = Math.max(0, (Date.now() - t) / 1000); return s < 5400 ? `${Math.max(1, Math.round(s / 60))}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const fmtPrice = (p) => (p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p >= 10 ? p.toFixed(2) : p.toFixed(4));
function previewLines(f, r) {
  if (f.type === 'rss') return r.items.slice(0, 5).map((i) => i.title);
  if (f.type === 'weather') return [`${r.place}: ${r.now.temp}°${r.units}, ${r.now.text}, wind ${r.now.wind} ${r.windUnit}`, ...r.days.map((d) => `${d.date}: ${d.hi}° / ${d.lo}°, ${d.text}`)];
  return [...r.items.map((i) => `${i.symbol} ${fmtPrice(i.price)}  ${i.change >= 0 ? '▲' : '▼'} ${Math.abs(i.pct).toFixed(2)}%`), ...(r.notFound && r.notFound.length ? [`(not found: ${r.notFound.join(', ')})`] : [])];
}
const msgActive = (m, now) => m.enabled && (!m.from || tsOrNull(m.from) <= now) && (!m.to || tsOrNull(m.to) >= now);
const activeMessages = (now = Date.now()) => cfg.messages.filter((m) => msgActive(m, now));

// Everything the ticker should scroll (client adds live alerts in front). Each segment: { text, tone, kind }.
function segments() {
  const out = []; const now = Date.now();
  for (const m of activeMessages(now)) out.push({ text: m.text, tone: m.tone, kind: 'message' });
  for (const f of cfg.feeds) {
    if (!f.enabled) continue; const c = cache.get(f.id); if (!c || c.error && !c.items && !c.now) continue; const name = f.name || (f.type === 'rss' ? c.channel : '');
    if (f.type === 'rss') for (const i of (c.items || [])) out.push({ text: `${name ? name + ': ' : ''}${i.title}`.slice(0, 180), tone: 'info', kind: 'news' });
    else if (f.type === 'weather' && c.now) out.push({ text: `${f.name || c.place}: ${c.now.temp}°${c.units} ${c.now.text}${c.days[0] ? ` · H ${c.days[0].hi}° / L ${c.days[0].lo}°` : ''}`, tone: 'info', kind: 'weather' });
    else if (f.type === 'stocks') for (const i of (c.items || [])) out.push({ text: `${i.symbol} ${fmtPrice(i.price)} ${i.change >= 0 ? '▲' : '▼'}${Math.abs(i.pct).toFixed(2)}%`, tone: i.change >= 0 ? 'ok' : 'bad', kind: 'stock' });
  }
  return out;
}
const ticker = () => ({ enabled: cfg.enabled, speed: cfg.speed, size: cfg.size, showStatus: cfg.showStatus, segments: segments() });

// For the dedicated widgets: the n-th feed of a type (1-based).
function nth(type, n) { const l = cfg.feeds.filter((f) => f.type === type && f.enabled); const f = l[Math.max(0, (Number(n) || 1) - 1)]; return f ? { feed: f, data: cache.get(f.id) || null } : null; }
const status = () => Object.fromEntries(cfg.feeds.map((f) => { const c = cache.get(f.id) || {}; return [f.id, { at: c.at || 0, error: c.error || null, count: (c.items || []).length }]; }));
module.exports = { fmtPrice, get: get_, save, test, start, ticker, segments, activeMessages, nth, status, ago, parseFeed, geocode };
