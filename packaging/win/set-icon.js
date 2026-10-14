'use strict';
// Gives the Windows exe its icon and "R1 NOC Wall" file properties (so Task Manager / Explorer don't say "Node.js").
//   node set-icon.js <in.exe> <icon.ico> <out.exe> [resedit-module-dir]
const fs = require('node:fs');
const path = require('node:path');
const [inExe, ico, outExe, dir] = process.argv.slice(2);
(async () => {
  const ResEdit = await require(dir ? path.join(path.resolve(dir), 'node_modules', 'resedit', 'cjs.cjs') : 'resedit/cjs').load();   // resedit is an ES module
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(inExe));
  const res = ResEdit.NtExecutableResource.from(exe);
  const icons = ResEdit.Data.IconFile.from(fs.readFileSync(ico)).icons.map((i) => i.data);
  const existing = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = existing.length ? existing[0].id : 1, lang = existing.length ? existing[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, icons);
  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vis.length) {
    const vi = vis[0]; const v = (process.env.APP_VERSION || '0.0.0').split('.').map(Number); vi.setFileVersion(v[0] || 0, v[1] || 0, v[2] || 0, 0); vi.setProductVersion(v[0] || 0, v[1] || 0, v[2] || 0, 0);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: 'R1 NOC Wall', ProductName: 'R1 NOC Wall', InternalName: 'R1-NOC-Wall', OriginalFilename: 'R1-NOC-Wall.exe', CompanyName: '', LegalCopyright: 'MIT License' });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe); fs.writeFileSync(outExe, Buffer.from(exe.generate()));
  console.log(`icon group ${groupId}: ${icons.length} sizes; version info ${vis.length ? 'updated' : 'absent'}`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
