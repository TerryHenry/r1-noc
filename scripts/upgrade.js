#!/usr/bin/env node
'use strict';
// Offline in-place upgrade (server stopped or running):
//   node scripts/upgrade.js r1-noc-0.3.0.tgz [--yes] [--allow-downgrade]     install a downloaded release
//   node scripts/upgrade.js --rollback                                         go back to the previous version
// Your data/ folder and .env are never touched. Restart the app afterwards.
const fs = require('node:fs');
const upgrade = require('../lib/upgrade');
const args = process.argv.slice(2); const flag = (f) => args.includes(f); const file = args.find((a) => !a.startsWith('--'));
(async () => {
  if (flag('--rollback')) { const r = await upgrade.rollback(); console.log(`Rolled back ${r.from} → ${r.to}. Restart the app.`); return; }
  if (!file || !fs.existsSync(file)) { console.error('Usage: node scripts/upgrade.js <release.tgz|.zip> [--yes] [--allow-downgrade]   or   --rollback'); process.exit(1); }
  const plan = await upgrade.inspect(file);
  console.log(`Package ${plan.file}\n  version ${plan.version} (installed: ${plan.current}, ${plan.relation})\n  sha256  ${plan.sha256}\n  replaces: ${plan.entries.join(', ')}`);
  if (!plan.nodeOk) throw new Error(`Needs Node.js ${plan.nodeNeeds}`);
  if (!flag('--yes')) { const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout }); const a = await new Promise((r) => rl.question('Install it? [y/N] ', r)); rl.close(); if (!/^y/i.test(a)) { upgrade.discard(plan.id); console.log('Cancelled.'); return; } }
  console.log('Testing the new version in a throw-away instance…');
  const r = await upgrade.apply(plan.id, { allowOlder: flag('--allow-downgrade') });
  console.log(`Upgraded ${r.from} → ${r.to}. Previous version saved as data/upgrade/previous/${r.backup}. Restart the app now.`);
})().catch((e) => { console.error('Upgrade failed:', e.message); process.exit(1); });
