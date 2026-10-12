'use strict';
const oui = require('./oui');
// Tolerant field readers: R1 viewmodel rows vary by surface/firmware, and the
// client-row fields in particular are not yet confirmed live — try the likely names.

function normStatus(s) {
  if (!s) return 'Unknown';
  const v = String(s).toLowerCase();
  if (v.includes('operational') || v === 'online' || v === 'good') return 'Operational';
  if (v.includes('degraded') || v.includes('warning')) return 'Degraded';
  if (v.includes('disconnect') || v.includes('offline') || v.includes('down')) return 'Disconnected';
  if (v.includes('initializ') || v.includes('provision') || v.includes('pending') || v.includes('reboot') || v.includes('never') || v.includes('setup') || v.includes('upgrad')) return 'Initializing';
  // R1 AP status codes are prefixed by class: 1_ setup, 2_ operational, 3_ requires attention, 4_ transient issue
  const m = v.match(/^(\d)_/);
  if (m) return { 1: 'Initializing', 2: 'Operational', 3: 'Disconnected', 4: 'Degraded' }[m[1]] || 'Unknown';
  return 'Unknown';
}

function normSeverity(s) {
  const v = String(s || '').toLowerCase();
  if (v.startsWith('crit')) return 'Critical';
  if (v.startsWith('maj')) return 'Major';
  if (v.startsWith('min')) return 'Minor';
  if (v.startsWith('warn')) return 'Warning';
  return 'Info';
}

// Alarm/event messages are a JSON string like {"message_template":"@@switchName Switch … "}.
function alarmText(a) {
  let m = a.message;
  if (typeof m === 'string') { try { const j = JSON.parse(m); m = j.message_template || j.message || m; } catch { /* plain */ } }
  return String(m || a.name || '').replace(/@@\w+/g, '').replace(/\s+/g, ' ').trim() || a.name || '';
}

// SwitchDto (viewmodel-1.0.45): poeTotal = capacity mW, poeFree = unallocated mW,
// poeUtilization = ALLOCATED mW (not a percent). Percent = allocated / total.
function poeOf(s) {
  const total = Number(s.poeTotal), free = Number(s.poeFree), used = Number(s.poeUtilization);
  if (!(total > 0)) return { poeTotalW: null, poeUsedW: null, poeUtil: null };
  const usedMw = Number.isFinite(used) ? used : Number.isFinite(free) ? total - free : null;
  if (usedMw == null) return { poeTotalW: total / 1000, poeUsedW: null, poeUtil: null };
  return { poeTotalW: total / 1000, poeUsedW: usedMw / 1000, poeUtil: Math.max(0, Math.min(100, (usedMw / total) * 100)) };
}

// "12 days, 3:04:05" / "3 days 04:05:06" / "04:05:06" / "2d 3h" → seconds (best effort, null if unparseable)
function uptimeSeconds(u) {
  if (u == null || u === '') return null;
  if (typeof u === 'number') return u;
  const str = String(u).toLowerCase();
  let sec = 0, hit = false;
  const d = str.match(/(\d+)\s*d/); if (d) { sec += d[1] * 86400; hit = true; }
  const t = str.match(/(\d+):(\d+):(\d+)/); if (t) { sec += +t[1] * 3600 + +t[2] * 60 + +t[3]; hit = true; }
  else { const h = str.match(/(\d+)\s*h/); if (h) { sec += h[1] * 3600; hit = true; } const m = str.match(/(\d+)\s*m(?!s)/); if (m) { sec += m[1] * 60; hit = true; } }
  return hit ? sec : null;
}

// ApRadioStatus → one row per radio. Band strings vary ("2.4", "5", "6", "5G"…) so normalise them.
const bandName = (b) => { const v = String(b == null ? '' : b); return /2\.?4/.test(v) ? '2.4 GHz' : /^6|6\(?5/.test(v) ? '6 GHz' : /5/.test(v) ? '5 GHz' : v ? `${v}` : 'Unknown'; };
function radio(r) { return { band: bandName(r.band), channel: r.channel != null ? Number(r.channel) : null, width: r.channelBandwidth != null && r.channelBandwidth !== '' ? `${String(r.channelBandwidth).replace(/\D*$/, '')} MHz` : '', txPower: Number.isFinite(Number(r.actualTxPower ?? r.transmitterPower)) ? Number(r.actualTxPower ?? r.transmitterPower) : null, rssi: Number.isFinite(Number(r.rssi)) ? Number(r.rssi) : null }; }

function ap(a, venueNames) {
  return {
    id: a.serialNumber || a.apMac || a.macAddress,
    name: a.name || a.serialNumber,
    model: a.model || '',
    firmware: a.fwVersion || a.firmwareVersion || '',
    ip: a.IP || (a.networkStatus && a.networkStatus.ipAddress) || '',
    venueId: a.venueId || '',
    venue: a.venueName || venueNames.get(a.venueId) || '',
    status: normStatus(a.deviceStatus || a.connectionStatus || a.status || a.state),
    health: String(a.healthStatus || '').toUpperCase() || 'UNKNOWN',
    meshRole: a.meshRole || (a.meshEnabled ? 'Mesh' : 'Wired'),
    apGroup: a.apGroupName || a.deviceGroupName || '',
    apGroupId: a.apGroupId || '',
    radios: (Array.isArray(a.radioStatuses) ? a.radioStatuses : []).map(radio),
    clients: Number(a.clients ?? a.clientCount) || 0,
    uplink: [a.switchName, a.switchPort].filter(Boolean).join(' ')
  };
}

function sw(s, venueNames) {
  return {
    id: s.serialNumber || s.id,
    name: s.name || s.switchName || s.serialNumber,
    model: s.model || '',
    firmware: s.firmwareVersion || s.firmware || '',
    ip: s.ipAddress || '',
    venueId: s.venueId || '',
    venue: s.venueName || venueNames.get(s.venueId) || '',
    status: normStatus(s.deviceStatus || s.status || s.state),
    ports: Number(s.numOfPorts) || 0,
    family: s.family || '',
    switchType: s.switchType || '',
    stack: s.isStack ? 'Stack' : 'Standalone',
    ...poeOf(s),
    cpu: s.cpu != null && s.cpu !== '' ? parseFloat(s.cpu) : null,
    memory: s.memory != null && s.memory !== '' ? parseFloat(s.memory) : null,
    alerts: Number(s.alerts) || 0,
    warning: Boolean(s.operationalWarning),
    uptime: s.uptime || '',
    uptimeSec: uptimeSeconds(s.uptime),
    clients: Number(s.clientCount) || 0
  };
}

// SwitchPortDto counters arrive as strings; status strings are free text ("Up"/"Down"/…).
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
function port(p, devByMac, devBySerial) {
  const dev = devBySerial.get(p.switchSerial) || devByMac.get(p.switchMac) || {};
  const st = String(p.status || '').toLowerCase();
  const admin = String(p.adminStatus || '').toLowerCase();
  const ed = String(p.errorDisableStatus || '');
  return {
    venueId: p.venueId || dev.venueId || '',
    switchName: p.switchName || dev.name || p.switchSerial || '',
    label: `${p.switchName || dev.name || ''} ${p.portIdentifier || p.name || ''}`.trim(),
    portName: p.portIdentifier || p.name || '',
    state: admin.startsWith('dis') ? 'Disabled' : st.startsWith('up') ? 'Up' : st.startsWith('down') ? 'Down' : 'Unknown',
    speed: p.portSpeed || '',
    poeUsedW: p.poeUsed != null ? num(p.poeUsed) / 1000 : null,
    poeTotalW: p.poeTotal != null ? num(p.poeTotal) / 1000 : null,
    utilPct: Math.max(num(p.signalIn), num(p.signalOut)) / 100,
    model: p.switchModel || dev.model || '',
    rxBytes: num(p.rx), txBytes: num(p.tx),
    mbps: p._mbps != null ? p._mbps : null,         // measured between port fetches (see collect.fetchPorts)
    errDelta: p._errDelta != null ? p._errDelta : null,
    errors: num(p.inErr) + num(p.outErr) + num(p.crcErr),
    crc: num(p.crcErr),
    errDisabled: Boolean(ed) && !/^(none|no|false|n\/a|-)$/i.test(ed) ? ed : '',
    blocking: /block/i.test(String(p.spanningTreeStatus || '')),
    stp: String(p.spanningTreeStatus || '').toLowerCase(),
    neighbor: p.neighborName || '',
    hasNeighbor: p.neighborName || p.neighborMacAddress ? 'Has LLDP neighbor' : 'No neighbor',
    media: p.mediaType || '',
    vlan: p.unTaggedVlan || '',
    profile: p.switchPortProfileName || '',
    lag: p.lagName ? 'LAG member' : 'Not in LAG'
  };
}

// R1 event log (POST /events/query). The text is a template ("@@switchName Switch is connected…"); the kind is inferred from its wording,
// because the event rows carry no separate type field.
const EVENT_KINDS = [['loop', /loop/i], ['stp', /spanning|\bstp\b|topolog|root bridge|bpdu/i], ['port', /flap|\b(port|link|interface)\b.*\b(up|down)\b|\b(up|down)\b.*\b(port|link)\b/i], ['poe', /\bpoe\b|power over/i], ['stack', /\bstack/i],
  ['offline', /disconnect|offline|unreachable|lost contact|went down|rebooted|restart/i], ['online', /is connected|came online|reconnect|discovered|\bonline\b/i], ['change', /updated|configured|applied|firmware|upgrade|position|created|deleted/i]];
function switchEvent(e, bySerial) {
  let tpl = ''; try { tpl = String((JSON.parse(e.message) || {}).message_template || ''); } catch { tpl = String(e.message || ''); }
  const sw = bySerial.get(e.entity_id) || {}; const name = sw.name || '';
  const text = tpl.replace(/[@%]{2}switchName/gi, name || 'switch').replace(/[@%]{2}(\w+)/g, '$1').replace(/\s+/g, ' ').trim();
  const kind = (EVENT_KINDS.find(([, re]) => re.test(text)) || ['other'])[0];
  return { t: Date.parse(e.event_datetime), severity: String(e.severity || ''), kind, text, switchName: name, entityId: e.entity_id || '', venueId: sw.venueId || '' };
}

function wfcProfile(p) {
  return { id: p.id, name: p.name || '', qos: p.qosPriority || '', epdgs: (p.epdgs || []).map((e) => e.domain || e.ip).filter(Boolean), networks: (p.wifiNetworkIds || p.networkIds || []).length };
}

// Local IEEE OUI lookup (no network). Randomized/private MACs carry no vendor — say so.
function vendorOf(mac) {
  if (!mac) return 'Unknown';
  try { const r = oui.lookup(mac); if (!r) return 'Unknown'; if (r.randomized) return 'Private (randomized MAC)'; return r.vendor || 'Unknown'; } catch { return 'Unknown'; }
}

function client(c) {
  const ni = c.networkInformation || {};
  const ai = c.apInformation || {};
  const sig = c.signalStatus || {};
  const tr = c.trafficStatus || {};
  const wf = c.wifiCallingStatus || {};
  return {
    venueId: (c.venueInformation && c.venueInformation.id) || c.venueId || '',
    ssid: ni.ssid || c.ssid || '',
    os: c.osType || c.deviceType || 'Unknown',
    model: c.modelName || '',
    devType: c.deviceType || '',
    security: [ni.authenticationMethod, ni.encryptionMethod].filter(Boolean).join(' / '),
    radioType: (c.radioStatus && c.radioStatus.type) || '',
    health: sig.health || '',
    identityGroup: c.identityGroupName || '',
    vlan: ni.vlan != null ? `VLAN ${ni.vlan}` : '',
    vendor: vendorOf(c.macAddress),
    name: c.alias || c.hostname || c.username || c.macAddress || '',
    band: c.band || '',
    channel: c.radioStatus && c.radioStatus.channel != null ? c.radioStatus.channel : null,
    rssi: Number.isFinite(sig.rssi) ? sig.rssi : null,
    snr: Number.isFinite(sig.snr) ? sig.snr : null,
    bytes: num(tr.totalTraffic) || (num(tr.trafficToClient) + num(tr.trafficFromClient)),   // total session bytes (falls back to up+down)
    ap: ai.name || ai.serialNumber || '',
    apSerial: ai.serialNumber || '',
    mac: String(c.macAddress || '').toLowerCase(),
    noiseFloor: Number.isFinite(sig.noiseFloor) ? sig.noiseFloor : null,
    connectedAt: ts(c.connectedTime),
    bytesDown: num(tr.trafficToClient),
    bytesUp: num(tr.trafficFromClient),
    mbps: null, mbpsDown: null, mbpsUp: null,
    wfc: Boolean(c.wifiCallingEnabled) || Boolean(wf.carrierName) || num(wf.totalTraffic) > 0,
    wfcCarrier: wf.carrierName || '',
    wfcBytes: num(wf.totalTraffic),
    wfcQos: wf.qosPriority || ''
  };
}

function alarm(a, deviceVenue) {
  const dev = deviceVenue.get(a.serialNumber || a.entityId) || {};
  return {
    id: a.id,
    severity: normSeverity(a.severity),
    time: Number(a.startTime) || Date.parse(a.startTime) || 0,
    cleared: Boolean(a.clearTime),
    entityType: a.entityType || '',
    device: dev.name || a.serialNumber || a.entityId || '',
    venueId: dev.venueId || '',
    venue: dev.venue || '',
    text: alarmText(a),
    kind: a.name || ''
  };
}

const ts = (v) => { if (v == null || v === '') return null; const n = Number(v); if (Number.isFinite(n) && n > 1e11) return n; const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

// Wi-Fi networks (WifiNetworkQueryData): the SSID list with per-network client/AP counts + VLAN.
function network(n) {
  return { id: n.id, name: n.name || n.ssid || '', ssid: n.ssid || n.name || '', type: n.nwType || '', subType: n.nwSubType || '', security: n.securityProtocol || '', captive: n.captiveType || '', vlan: n.vlan != null ? `VLAN ${n.vlan}` : '', vlanId: n.vlan != null ? Number(n.vlan) : null, clients: Number(n.clientCount) || 0, aps: Number(n.apCount) || 0 };
}

function dpskPool(p) {
  return { id: p.id, name: p.name || '', format: p.passphraseFormat || '', type: p.type || 'DPSK', deviceLimit: Number(p.deviceCountLimit) || 0, networks: Number(p.networkCount) || 0, expiration: p.expirationType || '', expiresAt: ts(p.expirationDate) };
}

// DPSK passphrase → "user". status (ACTIVE|REVOKED|EXPIRED) is used when R1 returns it, else derived.
function dpskPass(p, pool) {
  const now = Date.now();
  const expiresAt = ts(p.expirationDate);
  let status = String(p.status || '').toUpperCase();
  if (!status) status = p.revocationDate ? 'REVOKED' : expiresAt && expiresAt < now ? 'EXPIRED' : 'ACTIVE';
  const devs = Array.isArray(p.devices) ? p.devices : [];
  const lastSeen = devs.reduce((m, d) => Math.max(m, ts(d.lastConnectedTime) || 0), 0) || null;
  const online = devs.filter((d) => d.online === true || String(d.deviceConnectivity || '').toLowerCase() === 'connected').length;
  return {
    id: p.id, pool: pool.name, poolId: pool.id, user: p.username || '', vlan: p.vlanId != null ? `VLAN ${p.vlanId}` : '', vlanId: p.vlanId != null ? Number(p.vlanId) : null,
    status: status[0] + status.slice(1).toLowerCase(), active: status === 'ACTIVE', deviceLimit: Number(p.numberOfDevices) || 0, devices: devs.length, online,
    seenRecently: lastSeen != null && now - lastSeen < 24 * 3600e3, lastSeen, created: ts(p.createdDate), expiresAt, expiration: p.expiration || ''
  };
}

function guest(g, netNames) {
  const now = Date.now(); const expiry = ts(g.expiryDate);
  return {
    id: g.id, name: g.name || '', type: g.guestType || '', status: g.guestStatus || 'Unknown', network: netNames.get(g.wifiNetworkId) || '', networkId: g.wifiNetworkId || '',
    created: ts(g.creationDate), expiry, expired: expiry != null && expiry < now, social: Boolean(g.socialLogin), devices: (g.devicesMac || []).length, maxClients: Number(g.maxNumberOfClients) || 0
  };
}

function vlanPool(v, netNames) { return { id: v.id, name: v.name || '', members: (v.vlanMembers || []).join(', '), networks: (v.wifiNetworkIds || []).length, networkNames: (v.wifiNetworkIds || []).map((i) => netNames.get(i)).filter(Boolean).join(', ') }; }

function identityGroup(g) { return { id: g.id, name: g.name || '', identities: Number(g.identityCount) || 0, networks: Number(g.networkCount) || 0, dpsk: g.dpskPoolId ? 'DPSK' : '', macReg: g.macRegistrationPoolId ? 'MAC registration' : '', property: g.propertyId ? 'Property' : '', autoCleanup: Boolean(g.autoCleanupEnabled) }; }

// One row per AP radio, carrying the AP's venue / group so it can be grouped like everything else.
function radioRows(aps) { return aps.flatMap((a) => (a.radios || []).map((r) => ({ ...r, apId: a.id, apName: a.name, venueId: a.venueId, venue: a.venue, apGroup: a.apGroup, status: a.status }))); }

module.exports = { switchEvent, bandName, radioRows, ts, network, dpskPool, dpskPass, guest, vlanPool, identityGroup, normStatus, normSeverity, ap, sw, client, alarm, port, wfcProfile, uptimeSeconds };
