#!/usr/bin/env node
'use strict';
// Create / replace / remove the local editor account (use when you are locked out):
//   node scripts/passwd.js <user> <password>      node scripts/passwd.js --remove
// Run it as the user that owns data/, with the same NOC_DATA_DIR as the app.
const auth = require('../lib/auth');
const [a, b] = process.argv.slice(2);
try {
  if (a === '--remove') { auth.removeLocal(); console.log('Local editor account removed.'); }
  else if (a && b) { auth.setLocal(a, b); console.log(`Local editor account "${a}" set. Restart the app so existing sessions are dropped.`); }
  else { console.error('Usage: node scripts/passwd.js <user> <password>   |   --remove'); process.exit(1); }
} catch (e) { console.error(e.message); process.exit(1); }
