'use strict';
// Synthetic tenant for NOC_DEMO=1 — lets you see/tune the wall without credentials.
const history = require('./history');
const N = require('./normalize');

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
const world = { aps: [], switches: [], clients: [], alarms: [], seeded: false };

function build() {
  VENUES.forEach((v, vi) => {
    const nAps = 8 + vi * 3;
    for (let i = 0; i < nAps; i++) world.aps.push({ id: `AP${vi}${i}`, name: `${v.name.split(' ')[0]}-AP-${String(i + 1).padStart(2, '0')}`, model: pickW(AP_MODELS), firmware: pickW(AP_FW), ip: `10.${vi + 1}.1.${i + 10}`, venueId: v.id, venue: v.name, status: 'Operational', meshRole: pickW([['Wired', 20], ['Mesh', 1]]), health: pickW([['EXCELLENT', 14], ['AVERAGE', 4], ['POOR', 1]]), clients: 0, uplink: '' });
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
    wfc = Math.round(total * 0.06 * (0.9 + rnd() * 0.2));
    m['clients@*'] = total; m['clients_5@*'] = Math.round(total * 0.55); m['clients_24@*'] = Math.round(total * 0.3); m['wfc_clients@*'] = wfc;
    m['aps_total@*'] = world.aps.length; m['aps_online@*'] = world.aps.length - (rnd() < 0.05 ? 1 : 0); m['aps_offline@*'] = rnd() < 0.05 ? 1 : 0;
    m['sw_total@*'] = world.switches.length; m['sw_online@*'] = world.switches.length;
    m['alarms@*'] = Math.round(2 + rnd() * 5); m['alarms_critical@*'] = rnd() < 0.2 ? 1 : 0;
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
        bytes: Math.round(Math.pow(rnd(), 3) * 4e9), ap: a.name, wfc, wfcCarrier: wfc ? pickW([['AT&T', 4], ['Verizon', 4], ['T-Mobile', 5], ['US Cellular', 1]]) : '', wfcBytes: wfc && rnd() < 0.5 ? Math.round(rnd() * 3e7) : 0, wfcQos: '' });
    }
  }
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
      ports.push({ venueId: sw.venueId, switchName: sw.name, label: `${sw.name} 1/1/${i}`, portName: `1/1/${i}`, state: sw.status === 'Disconnected' ? 'Unknown' : up ? 'Up' : rnd() < 0.08 ? 'Disabled' : 'Down', speed: up ? pickW([['1 Gb/s', 10], ['100 Mb/s', 3], ['2.5 Gb/s', 2], ['10 Gb/s', 1]]) : '', poeUsedW: poe ? Math.round(rnd() * 150) / 10 : 0, poeTotalW: 30, utilPct: up ? Math.round(Math.pow(rnd(), 3) * 900) / 10 : 0, errors: up && rnd() < 0.05 ? Math.round(rnd() * 400) : 0, crc: up && rnd() < 0.02 ? Math.round(rnd() * 90) : 0, errDisabled: rnd() < 0.004 ? 'loop-detect' : '', blocking: rnd() < 0.006, neighbor: up && rnd() < 0.6 ? pick(['AP', 'ONT', 'Camera', 'Printer', 'ICX-core']) : '', hasNeighbor: up && rnd() < 0.6 ? 'Has LLDP neighbor' : 'No neighbor', media: pickW([['Copper', 9], ['Fiber', 1]]), vlan: up ? pick(['1', '100', '200', '300']) : '', profile: up && rnd() < 0.5 ? pick(['AP-Trunk', 'Access-Data', 'Camera']) : '', lag: rnd() < 0.05 ? 'LAG member' : 'Not in LAG' });
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
  return { networks, dpskPools: world.dpskPools, dpsk: world.dpsk, guests: world.guests, vlanPools: world.vlanPools, identityGroups: world.identityGroups, ports, wfcProfiles, at: now, venues: VENUES.map((v) => ({ ...v })), aps: world.aps.map((a) => ({ ...a })), switches: world.switches.map((s) => ({ ...s })), clients: world.clients, alarms: world.alarms.slice().reverse(), errors: {}, source: 'demo' };
}

module.exports = { tick };
