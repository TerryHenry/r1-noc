'use strict';
// Synthetic tenant for NOC_DEMO=1 — lets you see/tune the wall without credentials.
const history = require('./history');
const N = require('./normalize');
const cfg = require('./config');

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pickW = (pairs) => { let r = rnd() * pairs.reduce((s, p) => s + p[1], 0); for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; } return pairs[0][0]; };

const VENUES = ['Maple Heights', 'Harbor View Apartments', 'Cedar Court', 'Northgate Student Living', 'Riverside Lofts'].map((name, i) => ({ id: `v${i + 1}`, name }));
const AP_MODELS = [['R770', 3], ['R650', 6], ['R550', 4], ['H550', 10], ['R350', 3], ['T350', 2]];
const SW_MODELS = [['ICX7150-C12P', 3], ['ICX7150-48PF', 4], ['ICX8200-48PF', 2], ['ICX7550-24P', 2]];
const AP_FW = [['7.1.0.510.171', 12], ['7.0.0.104.1520', 4], ['6.2.4.103.244', 1]];
const SW_FW = [['SPR10.1.10a', 6], ['SPS09.0.10j', 3], ['RDR10.1.10a', 1]];
const SSIDS = [['Resident-WiFi', 60], ['IoT', 14], ['Guest', 10], ['Staff', 4], ['Streaming', 12]];
const OSES = [['iOS', 34], ['Android', 28], ['Windows', 14], ['macOS', 8], ['Linux', 3], ['Smart TV', 9], ['IoT', 12], ['Game Console', 3]];
const BANDS = [['5 GHz', 55], ['2.4 GHz', 30], ['6 GHz', 15]];

const NETS = [['Resident-WiFi', 'dpsk', 'WPA2', 100], ['IoT', 'dpsk', 'WPA2', 200], ['Guest', 'guest', 'Open', 300], ['Staff', 'aaa', 'WPA3', 50], ['Streaming', 'psk', 'WPA2', 100]];
const POOLS = ['Maple Residents', 'Harbor Residents', 'Student Housing', 'Staff Devices'];
const DAYMS = 86400e3;
const GROUPS = ['Residents', 'Public Areas', 'Guest', 'Staff Admin', 'Conference'];
const CH24 = [1, 6, 11], CH5 = [36, 40, 44, 48, 149, 153, 157, 161], CH6 = [5, 21, 37, 53];
const world = { aps: [], switches: [], clients: [], alarms: [], seeded: false };

function build() {
  VENUES.forEach((v, vi) => {
    const nAps = 8 + vi * 3;
    for (let i = 0; i < nAps; i++) world.aps.push({ id: `AP${vi}${i}`, name: `${v.name.split(' ')[0]}-AP-${String(i + 1).padStart(2, '0')}`, model: pickW(AP_MODELS), firmware: pickW(AP_FW), ip: `10.${vi + 1}.1.${i + 10}`, venueId: v.id, venue: v.name, apGroup: pickW([['Residents', 8], ['Public Areas', 3], ['Guest', 2], ['Staff Admin', 2], ['Conference', 1]]), radios: [{ band: '2.4 GHz', channel: pick(CH24), width: '20 MHz', txPower: 8 + Math.round(rnd() * 6), rssi: null }, { band: '5 GHz', channel: pick(CH5), width: pick(['40 MHz', '80 MHz']), txPower: 12 + Math.round(rnd() * 8), rssi: null }, ...(rnd() < 0.3 ? [{ band: '6 GHz', channel: pick(CH6), width: '160 MHz', txPower: 14 + Math.round(rnd() * 6), rssi: null }] : [])], status: 'Operational', meshRole: pickW([['Wired', 20], ['Mesh', 1]]), health: pickW([['EXCELLENT', 14], ['AVERAGE', 4], ['POOR', 1]]), clients: 0, uplink: '' });
    for (let i = 0; i < 2 + (vi % 3); i++) world.switches.push({ id: `SW${vi}${i}`, name: `${v.name.split(' ')[0]}-SW-${i + 1}`, model: pickW(SW_MODELS), firmware: pickW(SW_FW), ip: `10.${vi + 1}.0.${i + 2}`, venueId: v.id, venue: v.name, status: 'Operational', ports: pick([12, 24, 48]), family: pick(['ICX7150', 'ICX7550', 'ICX8200']), switchType: pickW([['Edge', 8], ['Aggregation', 2], ['Core', 1]]), stack: rnd() < 0.2 ? 'Stack' : 'Standalone', poeTotalW: 0, poeUsedW: 0, poeUtil: 0, cpu: Math.round(5 + rnd() * 30), memory: Math.round(30 + rnd() * 40), alerts: 0, warning: false, uptime: '', uptimeSec: Math.floor((rnd() < 0.15 ? rnd() * 86400 * 4 : 86400 * (5 + rnd() * 200))), clients: 0 });
  });
}

function dayCurve(t) { const h = new Date(t).getHours() + new Date(t).getMinutes() / 60; return 0.35 + 0.65 * Math.exp(-Math.pow((h - 21) / 5, 2)) + 0.1 * Math.exp(-Math.pow((h - 8) / 2, 2)); }

function seedHistory(now) {
  // 8 days of backfill (10-minute steps) so trends, hourly profiles and "vs last week" have something to show
  for (let t = now - 8 * 86400e3; t < now; t += 10 * 60e3) {
    const f = dayCurve(t) * (new Date(t).getDay() % 6 === 0 ? 1.15 : 1);   // weekends a little busier
    const m = {};
    let total = 0, wfc = 0;
    VENUES.forEach((v, vi) => {
      const c = Math.round((60 + vi * 35) * f * (0.95 + rnd() * 0.1));
      total += c;
      m[`clients@${v.id}`] = c;
      const n = world.aps.filter((a) => a.venueId === v.id).length;
      m[`aps_total@${v.id}`] = n; m[`aps_online@${v.id}`] = n - (rnd() < 0.03 ? 1 : 0);
    });
    for (const c of CUSTOMERS) { const vs = VENUES.filter((v) => c.venues.includes(v.id)); const sum = (k) => vs.reduce((n, v) => n + (m[`${k}@${v.id}`] || 0), 0); m[`clients@c:${c.id}`] = sum('clients'); m[`aps_total@c:${c.id}`] = sum('aps_total'); m[`aps_online@c:${c.id}`] = sum('aps_online'); m[`thr_mbps@c:${c.id}`] = sum('clients') * 0.14 * (0.9 + rnd() * 0.2); }
    wfc = Math.round(total * 0.06 * (0.9 + rnd() * 0.2));
    m['clients@*'] = total; m['clients_5@*'] = Math.round(total * 0.55); m['clients_24@*'] = Math.round(total * 0.3); m['wfc_clients@*'] = wfc;
    m['aps_total@*'] = world.aps.length; m['aps_online@*'] = world.aps.length - (rnd() < 0.05 ? 1 : 0); m['aps_offline@*'] = rnd() < 0.05 ? 1 : 0;
    m['sw_total@*'] = world.switches.length; m['sw_online@*'] = world.switches.length;
    m['alarms@*'] = Math.round(2 + rnd() * 5); m['alarms_critical@*'] = rnd() < 0.2 ? 1 : 0;
    const thr = Math.round(total * (0.12 + 0.05 * rnd()) * 10) / 10; m['thr_mbps@*'] = thr; m['thr_down_mbps@*'] = thr * 0.88; m['thr_up_mbps@*'] = thr * 0.12; m['traffic_bytes@*'] = (thr * 1e6 / 8) * 600; m['traffic_down_bytes@*'] = m['traffic_bytes@*'] * 0.88; m['traffic_up_bytes@*'] = m['traffic_bytes@*'] * 0.12;
    m['sw_thr_mbps@*'] = Math.round(total * 0.4 * (0.9 + rnd() * 0.2)); m['sw_errors@*'] = rnd() < 0.2 ? Math.round(rnd() * 30) : 0;
    m['clients_6@*'] = Math.round(total * 0.15); m['avg_snr@*'] = 28 + Math.round(4 * rnd()) - Math.round(4 * (1 - f)); m['avg_noise@*'] = -94;
    m['poor_signal@*'] = Math.round(total * 0.08 * (0.8 + rnd() * 0.4)); m['avg_rssi@*'] = -Math.round(58 + 8 * rnd() + 6 * (1 - f));
    m['poe_watts@*'] = Math.round(1500 + 300 * f + rnd() * 60); m['dpsk_active@*'] = 270 - Math.round(rnd() * 3); m['guests_active@*'] = Math.round(20 * f + rnd() * 6); m['ports_up@*'] = Math.round(200 + 60 * f);
    history.record(t, m);
  }
}

function tick() {
  const now = Date.now();
  if (!world.aps.length) { build(); world.aps[3].status = 'Disconnected'; world.aps[17].status = 'Degraded'; world.switches[4].status = 'Disconnected'; world.pinned = new Set([world.aps[3], world.switches[4]]); }   // pinned demo faults stay down so alerts are reproducible
  if (!world.seeded) { if (!history.count()) seedHistory(now); world.seeded = true; }
  const f = dayCurve(now);

  for (const a of world.aps) { if (world.pinned.has(a)) continue; if (a.status === 'Disconnected' ? rnd() < 0.25 : rnd() < 0.006) a.status = a.status === 'Disconnected' ? 'Operational' : (rnd() < 0.7 ? 'Disconnected' : 'Degraded'); else if (a.status === 'Degraded' && rnd() < 0.3) a.status = 'Operational'; }
  for (const s of world.switches) { if (world.pinned.has(s)) { s.alerts = 2; continue; } if (s.status === 'Disconnected' ? rnd() < 0.3 : rnd() < 0.002) s.status = s.status === 'Disconnected' ? 'Operational' : 'Disconnected'; s.poeTotalW = s.poeTotalW || (s.ports > 24 ? 740 : 124); s.poeUtil = Math.max(5, Math.min(95, (s.poeUtil || 30) + (rnd() - 0.5) * 6)); s.poeUsedW = Math.round(s.poeTotalW * s.poeUtil) / 100; s.cpu = Math.max(2, Math.min(95, s.cpu + Math.round((rnd() - 0.5) * 6))); s.memory = Math.max(20, Math.min(90, s.memory + Math.round((rnd() - 0.5) * 2))); s.uptimeSec += 60; s.alerts = s.status === 'Disconnected' ? 2 : 0; }

  world.clients = [];
  for (const a of world.aps) {
    a.clients = a.status === 'Disconnected' ? 0 : Math.round((4 + (a.venueId.charCodeAt(1) - 48) * 2) * f * (0.6 + rnd() * 0.9) + (a.model === 'H550' ? -2 : 1));
    a.clients = Math.max(0, a.clients);
    for (let i = 0; i < a.clients; i++) {
      const band = pickW(BANDS); const os = pickW(OSES); const wfc = (os === 'iOS' || os === 'Android') && rnd() < 0.12;
      world.clients.push({ venueId: a.venueId, ssid: pickW(SSIDS), os, model: os === 'iOS' ? pick(['iPhone 15', 'iPhone 14', 'iPad']) : os === 'Android' ? pick(['Pixel 8', 'Galaxy S24', 'Galaxy A54']) : '', name: `client-${a.id}-${i}`, devType: os, security: pickW([['WPA3 / AES', 5], ['WPA2 / AES', 12], ['Open / None', 2], ['WPA2/WPA3 / AES', 4]]), radioType: band === '6 GHz' ? '802.11ax' : band === '5 GHz' ? pickW([['802.11ac', 5], ['802.11ax', 6]]) : pickW([['802.11n', 4], ['802.11ax', 3]]), health: pickW([['Good', 14], ['Fair', 3], ['Poor', 1]]), identityGroup: rnd() < 0.5 ? pick(['Residents', 'Staff']) : '', vlan: pickW([['VLAN 100', 8], ['VLAN 200', 3], ['VLAN 300', 2], ['VLAN 50', 1]]), vendor: os === 'iOS' || os === 'macOS' ? pickW([['Private (randomized MAC)', 6], ['Apple, Inc.', 4]]) : os === 'Android' ? pickW([['Private (randomized MAC)', 5], ['Samsung Electronics', 4], ['Google, Inc.', 2]]) : os === 'Smart TV' ? pick(['LG Electronics', 'Roku, Inc', 'Samsung Electronics']) : os === 'Windows' ? pick(['Intel Corporate', 'Dell Inc.', 'Microsoft Corporation']) : pick(['Espressif Inc.', 'Amazon Technologies', 'Sonos, Inc.', 'Nintendo Co.']), band,
        channel: band === '2.4 GHz' ? pick([1, 6, 11]) : band === '5 GHz' ? pick([36, 40, 44, 149, 153, 157]) : pick([5, 21, 37]), rssi: -Math.round(45 + rnd() * 45), snr: Math.round(10 + rnd() * 35),
        bytes: Math.round(Math.pow(rnd(), 3) * 4e9), ap: a.name, apSerial: a.id, apGroup: a.apGroup, mac: `aa:${(a.id.charCodeAt(2) % 99).toString(16).padStart(2, '0')}:${i.toString(16).padStart(2, '0')}:${world.clients.length.toString(16).padStart(6, '0').match(/../g).join(':')}`, noiseFloor: -Math.round(92 + rnd() * 6), connectedAt: now - Math.round(Math.pow(rnd(), 2) * 30 * 3600e3), mbpsDown: null, mbpsUp: null, mbps: null, wfc, wfcCarrier: wfc ? pickW([['AT&T', 4], ['Verizon', 4], ['T-Mobile', 5], ['US Cellular', 1]]) : '', wfcBytes: wfc && rnd() < 0.5 ? Math.round(rnd() * 3e7) : 0, wfcQos: '' });
    }
  }
  let bytesDn = 0, bytesUp = 0;
  for (const c of world.clients) { if (rnd() < 0.55) { const d = Math.pow(rnd(), 3) * 6 * f, u = d * (0.05 + rnd() * 0.15); c.mbpsDown = d; c.mbpsUp = u; c.mbps = d + u; bytesDn += (d * 60 * 1e6) / 8; bytesUp += (u * 60 * 1e6) / 8; } }
  const bytesTot = bytesDn + bytesUp;
  for (const s of world.switches) s.clients = Math.round(s.ports * 0.4 * (0.7 + rnd() * 0.3));

  // alarms follow the down devices
  const down = [...world.aps, ...world.switches].filter((d) => d.status === 'Disconnected' || d.status === 'Degraded');
  const keep = world.alarms.filter((al) => (al.id.startsWith('al-x-') ? now - al.time < 30 * 60e3 : down.some((d) => d.id === al.devId)));
  for (const d of down) if (!keep.some((al) => al.devId === d.id && !al.id.startsWith('al-x-'))) keep.push({ id: `al-${d.id}-${now}`, devId: d.id, severity: d.status === 'Disconnected' ? (d.id.startsWith('SW') ? 'Critical' : 'Major') : 'Minor', time: now - Math.floor(rnd() * 120e3), cleared: false, kind: d.status === 'Disconnected' ? 'Device offline' : 'High utilization', entityType: d.id.startsWith('SW') ? 'SWITCH' : 'AP', device: d.name, venueId: d.venueId, venue: d.venue, text: d.status === 'Disconnected' ? `${d.name} disconnected from RUCKUS One` : `${d.name} degraded — high channel utilization` });
  if (rnd() < 0.15) { const d = pick(world.aps); keep.push({ id: `al-x-${now}`, devId: d.id, severity: pick(['Warning', 'Minor', 'Info']), time: now, cleared: false, kind: 'Rogue AP', entityType: 'AP', device: d.name, venueId: d.venueId, venue: d.venue, text: `${d.name} rogue AP detected on channel ${pick([1, 6, 11, 36, 149])}` }); }
  world.alarms = keep.slice(-60);

  const ports = [];
  for (const sw of world.switches) {
    for (let i = 1; i <= sw.ports; i++) {
      const up = sw.status !== 'Disconnected' && rnd() < 0.55; const poe = up && rnd() < 0.5;
      ports.push({ venueId: sw.venueId, switchName: sw.name, label: `${sw.name} 1/1/${i}`, portName: `1/1/${i}`, state: sw.status === 'Disconnected' ? 'Unknown' : up ? 'Up' : rnd() < 0.08 ? 'Disabled' : 'Down', speed: up ? pickW([['1 Gb/s', 10], ['100 Mb/s', 3], ['2.5 Gb/s', 2], ['10 Gb/s', 1]]) : '', poeUsedW: poe ? Math.round(rnd() * 150) / 10 : 0, poeTotalW: 30, utilPct: up ? Math.round(Math.pow(rnd(), 3) * 900) / 10 : 0, errors: up && rnd() < 0.05 ? Math.round(rnd() * 400) : 0, crc: up && rnd() < 0.02 ? Math.round(rnd() * 90) : 0, errDisabled: rnd() < 0.004 ? 'loop-detect' : '', blocking: rnd() < 0.006, model: sw.model, rxBytes: 0, txBytes: 0, mbps: up ? Math.round(Math.pow(rnd(), 3) * 90 * 10) / 10 : 0, errDelta: up && rnd() < 0.05 ? Math.round(rnd() * 20) : 0, neighbor: up && rnd() < 0.6 ? pick(['AP', 'ONT', 'Camera', 'Printer', 'ICX-core']) : '', hasNeighbor: up && rnd() < 0.6 ? 'Has LLDP neighbor' : 'No neighbor', media: pickW([['Copper', 9], ['Fiber', 1]]), vlan: up ? pick(['1', '100', '200', '300']) : '', profile: up && rnd() < 0.5 ? pick(['AP-Trunk', 'Access-Data', 'Camera']) : '', lag: rnd() < 0.05 ? 'LAG member' : 'Not in LAG' });
    }
  }
  const wfcProfiles = [{ id: 'p1', name: 'Carrier WFC — Resident', qos: 'VOICE', epdgs: ['epdg.epc.att.net', 'epdg.epc.mnc260.mcc310.pub.3gppnetwork.org'], networks: 2 }, { id: 'p2', name: 'Carrier WFC — Staff', qos: 'VOICE', epdgs: ['epdg.epc.mnc480.mcc311.pub.3gppnetwork.org'], networks: 1 }];
  for (const sw of world.switches) sw.uptime = `${Math.floor(sw.uptimeSec / 86400)} days, ${new Date(sw.uptimeSec % 86400 * 1000).toISOString().substr(11, 8)}`;
  if (!world.dpsk) {
    world.dpsk = [];
    POOLS.forEach((pn, pi) => {
      const pool = { id: `pool${pi}`, name: pn };
      for (let i = 0; i < 40 + pi * 25; i++) {
        const created = now - Math.floor(rnd() * 120) * DAYMS; const revoked = rnd() < 0.05; const exp = rnd() < 0.15 ? null : now + (rnd() * 400 - 40) * DAYMS; const expired = !revoked && exp && exp < now;
        const limit = pick([2, 3, 5, 8]); const devices = Math.min(limit, Math.floor(rnd() * (limit + 1)));
        world.dpsk.push({ id: `${pool.id}-${i}`, pool: pn, poolId: pool.id, user: `unit-${pi + 1}${String(i + 1).padStart(2, '0')}`, vlan: `VLAN ${pick([100, 100, 100, 200, 300])}`, vlanId: null, status: revoked ? 'Revoked' : expired ? 'Expired' : 'Active', active: !revoked && !expired, deviceLimit: limit, devices, online: Math.floor(devices * rnd()), seenRecently: devices > 0 && rnd() < 0.7, lastSeen: now - rnd() * 3 * DAYMS, created, expiresAt: exp, expiration: '' });
      }
    });
    world.dpskPools = POOLS.map((pn, pi) => ({ id: `pool${pi}`, name: pn, format: 'MOST_SECURED', type: 'DPSK', deviceLimit: 5, networks: pi % 2 + 1, expiration: 'SPECIFIED_DATE', expiresAt: null }));
    world.guests = Array.from({ length: 70 }, (_, i) => { const created = now - rnd() * 6 * DAYMS; const expiry = created + pick([1, 1, 3, 7]) * DAYMS; return { id: `g${i}`, name: `Guest ${1000 + i}`, type: pickW([['GuestPass', 6], ['SelfSignIn', 3], ['HostApproval', 1]]), status: expiry < now ? 'Expired' : rnd() < 0.5 ? 'Online' : 'Offline', network: 'Guest', networkId: 'n3', created, expiry, expired: expiry < now, social: rnd() < 0.15, devices: Math.floor(rnd() * 3), maxClients: 3 }; });
    world.vlanPools = [{ id: 'vp1', name: 'Resident VLAN pool', members: '100-199', networks: 2, networkNames: 'Resident-WiFi, IoT' }, { id: 'vp2', name: 'Guest VLAN pool', members: '300-310', networks: 1, networkNames: 'Guest' }];
    world.identityGroups = POOLS.map((pn, pi) => ({ id: `ig${pi}`, name: `${pn} identities`, identities: 40 + pi * 25 + Math.floor(rnd() * 10), networks: pi % 2 + 1, dpsk: 'DPSK', macReg: '', property: pi < 2 ? 'Property' : '', autoCleanup: pi === 2 }));
  }
  for (const g of world.guests) { g.expired = g.expiry < now; if (g.expired) g.status = 'Expired'; else if (rnd() < 0.05) g.status = g.status === 'Online' ? 'Offline' : 'Online'; }
  for (const d of world.dpsk) if (d.active && d.expiresAt && d.expiresAt < now) { d.active = false; d.status = 'Expired'; }
  const networks = NETS.map(([ssid, type, sec, vlan], i) => ({ id: `n${i}`, name: ssid, ssid, type, subType: '', security: sec, captive: type === 'guest' ? 'GuestPass' : '', vlan: `VLAN ${vlan}`, vlanId: vlan, clients: world.clients.filter((c) => c.ssid === ssid).length, aps: world.aps.length }));
  const radios = world.aps.flatMap((a) => a.radios.map((r) => ({ ...r, apId: a.id, apName: a.name, venueId: a.venueId, venue: a.venue, apGroup: a.apGroup, status: a.status })));
  // synthetic connection-experience analytics (same shape as lib/analytics.js returns)
  const stages = [['assoc', 'Association', 390, 0.43], ['auth', 'Authentication', 599, 0.86], ['eap', 'EAP', 115, 0.88], ['radius', 'RADIUS', 40, 1], ['dhcp', 'DHCP', 958, 0.997]].map(([id, label, att, r]) => ({ id, label, att, ok: Math.round(att * r) }));
  const t15 = Array.from({ length: 96 }, (_, i) => { const t = now - (96 - i) * 900e3; const att = Math.round(6 + 40 * dayCurve(t) * (0.6 + rnd() * 0.8)); return { t, att, ok: Math.round(att * (0.8 + rnd() * 0.18)) }; });
  const daily = Array.from({ length: 7 }, (_, i) => { const att = 1800 + Math.round(rnd() * 1200); return { t: now - (6 - i) * 86400e3, att, ok: Math.round(att * (0.82 + rnd() * 0.12)) }; });
  const G = 1e9; const top = { apps: [['netflix', 41], ['youtube', 33], ['amazon_aws', 22], ['hulu', 18], ['icloud', 12], ['zoom', 9], ['microsoft', 6]].map(([name, g]) => ({ name, bytes: g * G })), appClients: [['amazon_aws', 20], ['apple', 18], ['google', 15], ['cloudflare', 12], ['netflix', 9]].map(([name, clients]) => ({ name, clients })),
    categories: { usage: [['Audio/Video', 96], ['Web', 40], ['Unknown', 31], ['Social', 14], ['Gaming', 9]].map(([name, g]) => ({ name, bytes: g * G })), clients: [] },
    ssids: [['Resident', 150, 190], ['Guest', 22, 41], ['IoT', 3, 28]].map(([name, g, clients]) => ({ name, bytes: g * G, clients })), aps: [['AP-3F-East', 38], ['AP-1F-Lobby', 29], ['AP-2F-West', 21], ['AP-5F-North', 12]].map(([name, g]) => ({ name, bytes: g * G })),
    clients: [['Living-Room-TV', 17], ['MacBook-Pro', 11], ['iPad', 7], ['Roku-Ultra', 6]].map(([name, g]) => ({ name, bytes: g * G })) };
  const fails = { assoc: { ssid: [{ name: 'Guest', n: 180 }, { name: 'Resident', n: 44 }], ap: [{ name: 'AP-3F-East', n: 120 }, { name: 'AP-5F-North', n: 60 }], maker: [{ name: 'Apple', n: 90 }, { name: 'Samsung', n: 70 }] }, auth: { ssid: [{ name: 'Resident', n: 60 }], ap: [{ name: 'AP-2F-West', n: 40 }], maker: [{ name: 'Intel', n: 30 }] }, eap: { ssid: [{ name: 'Resident', n: 14 }], ap: [], maker: [] }, radius: { ssid: [], ap: [], maker: [] }, dhcp: { ssid: [{ name: 'IoT', n: 3 }], ap: [{ name: 'AP-1F-Lobby', n: 3 }], maker: [] } };
  const H = 3600e3; const inc = (code, title, category, sev, ago, dur, where, extra = {}) => ({ id: code + ago, code, title, category, severity: sev, level: sev >= 0.8 ? 'Critical' : sev >= 0.6 ? 'High' : sev >= 0.3 ? 'Medium' : 'Low', start: now - ago * H, end: now - (ago - dur) * H, where, scope: 'zone', muted: false, clients: null, switches: null, airtime: false, ...extra });
  const incidents = [inc('i-switch-vlan-mismatch', 'VLAN mismatch between switches', 'Switching', 0.6, 30, 30, VENUES[0].name, { switches: 6 }), inc('i-apserv-high-num-reboots', 'High number of AP reboots', 'Infrastructure', 0.75, 20, 0.5, VENUES[0].name), inc('assoc-failure', 'Association failures', 'Connection', 0.85, 2, 2, VENUES[0].name, { clients: 34 }), inc('i-apserv-downtime-high', 'High AP downtime', 'Infrastructure', 0.52, 70, 25, VENUES[0].name)];
  const byVenue = Object.fromEntries(VENUES.map((v, i) => [v.name, { conn: 96 - i * 7.5, assoc: 88 - i * 12, auth: 97 - i * 4, eap: 98, radius: 100, dhcp: 99.5, ttcMs: 900 + i * 450, aps: 4, roaming: 92 - i * 6, rss: -58 - i * 4, apUp: 100 - i * 1.5 }]));
  const analytics = { at: now, errors: {}, kpi: { roaming: 88.5, rss: -61.4, apUp: 99.6, poe: 12.5 }, byVenue, incidents, top, fails, conn: { ok: t15.reduce((n, x) => n + x.ok, 0), att: t15.reduce((n, x) => n + x.att, 0) }, ttcMs: 1100 + Math.round(rnd() * 500), stages, trend15: t15, daily, clients: t15.map((x) => ({ t: x.t, added: Math.round(x.att / 6), impacted: 0, connected: Math.round(300 * dayCurve(x.t)) })) };
  const portsFresh = true;
  return { analytics, portsFresh, radios, traffic: { dt: 60, bytes: bytesTot, down: bytesDn, up: bytesUp }, networks, dpskPools: world.dpskPools, dpsk: world.dpsk, guests: world.guests, vlanPools: world.vlanPools, identityGroups: world.identityGroups, ports, wfcProfiles, at: now, venues: VENUES.map((v) => ({ ...v })), aps: world.aps.map((a) => ({ ...a })), switches: world.switches.map((s) => ({ ...s })), clients: world.clients, alarms: world.alarms.slice().reverse(), errors: {}, source: 'demo' };
}

// NOC_DEMO_MSP=1: split the five demo venues across three pretend customers so MSP mode can be tried without an MSP tenant.
const CUSTOMERS = [{ id: 'sunbelt', name: 'Sunbelt Residential', venues: ['v1', 'v3'] }, { id: 'harbor', name: 'Harbor Property Group', venues: ['v2'] }, { id: 'campus', name: 'Campus Living Co.', venues: ['v4', 'v5'] }];
function mspify(S) {
  const cOf = (venueId) => CUSTOMERS.find((c) => c.venues.includes(venueId));
  const tagV = (v) => { const c = cOf(v.id); return c ? Object.assign(v, { customerId: c.id, customer: c.name }) : v; };
  const tag = (r) => { const c = cOf(r.venueId); return c ? Object.assign(r, { customerId: c.id, customer: c.name }) : r; };
  S.venues.forEach(tagV);
  for (const k of ['aps', 'switches', 'clients', 'alarms', 'ports', 'radios']) (S[k] || []).forEach(tag);
  S.customers = CUSTOMERS.map((c) => ({ id: c.id, name: c.name, ok: true, error: '', at: S.at, venues: c.venues.length, aps: S.aps.filter((a) => a.customerId === c.id).length, switches: S.switches.filter((a) => a.customerId === c.id).length, clients: S.clients.filter((a) => a.customerId === c.id).length }));
  S.customers[2].ok = false; S.customers[2].error = 'HTTP 401 — check client secret';   // one customer "unreachable" so the failure state is visible
  const A = S.analytics; S.analyticsBy = {}; S.trafficBy = {};
  for (const c of CUSTOMERS) {
    const names = new Set(S.venues.filter((v) => c.venues.includes(v.id)).map((v) => v.name)); const share = names.size / S.venues.length;
    S.analyticsBy[c.id] = { ...A, conn: { ok: Math.round(A.conn.ok * share), att: Math.round(A.conn.att * share) }, stages: A.stages.map((x) => ({ ...x, ok: Math.round(x.ok * share), att: Math.round(x.att * share) })),
      byVenue: Object.fromEntries(Object.entries(A.byVenue).filter(([n]) => names.has(n))), incidents: A.incidents.filter((x) => names.has(x.where)) };
    S.trafficBy[c.id] = { dt: S.traffic.dt, bytes: S.traffic.bytes * share, down: S.traffic.down * share, up: S.traffic.up * share };
  }
  S.analyticsBy.campus = null;
  S.analytics = A; S.source = 'demo';
  return S;
}
module.exports = { tick: () => (cfg.demoMsp ? mspify(tick()) : tick()) };
