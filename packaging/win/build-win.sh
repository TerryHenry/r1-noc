#!/usr/bin/env bash
# Build the Windows distribution from any machine with Node.js ≥ 24:  packaging/win/build-win.sh
#   dist/R1-NOC-Wall-<ver>-win-x64.zip        portable: unzip anywhere, run R1-NOC-Wall.exe
#   dist/R1-NOC-Wall-<ver>-win-x64-setup.exe  per-user installer (needs NSIS' makensis, or Docker which is used to run it)
# R1-NOC-Wall.exe is Node.js with the small launcher embedded (a "single executable application"); the app itself stays in the app\ folder.
# NOTE: the exe is not code-signed, so Windows SmartScreen shows "unknown publisher" once (More info → Run anyway).
set -euo pipefail
cd "$(dirname "$0")/../.."
VER=$(node -p "require('./package.json').version"); NODE_VER=${NODE_VER:-$(node -v)}
[ "$(node -v)" = "$NODE_VER" ] || { echo "The host Node ($(node -v)) must be the same version as the bundled one ($NODE_VER): the embedded blob is version-specific." >&2; exit 1; }
CACHE=packaging/.cache; mkdir -p "$CACHE" dist; W="$CACHE/win-build"; rm -rf "$W"; mkdir -p "$W/stage/app"
echo "== release package"; npm run -s package >/dev/null
Z="$CACHE/node-win-x64.zip"
if [ ! -f "$Z" ] || [ "$(cat "$CACHE/node-win.version" 2>/dev/null)" != "$NODE_VER" ]; then
  echo "== downloading Node $NODE_VER (win-x64)"; curl -fL --progress-bar -o "$Z" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" | grep "node-$NODE_VER-win-x64.zip" | awk '{print $1"  '"$Z"'"}' | shasum -a 256 -c -; echo "$NODE_VER" > "$CACHE/node-win.version"
fi
unzip -q -j "$Z" "node-$NODE_VER-win-x64/node.exe" -d "$W"
echo "== embedding the launcher"
cp packaging/win/launcher.js "$W/"; echo '{"main":"launcher.js","output":"sea.blob","disableExperimentalSEAWarning":true,"useCodeCache":false,"useSnapshot":false}' > "$W/sea.json"
( cd "$W" && node --experimental-sea-config sea.json >/dev/null )
python3 packaging/win/pe_prepare.py "$W/node.exe" "$W/R1-NOC-Wall.exe"
npx --yes postject "$W/R1-NOC-Wall.exe" NODE_SEA_BLOB "$W/sea.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 >/dev/null
cp "$W/R1-NOC-Wall.exe" "$W/stage/"; tar -xzf "dist/r1-noc-$VER.tgz" -C "$W/stage/app" --strip-components=1
cat > "$W/stage/README-Windows.txt" <<R
R1 NOC Wall $VER for Windows
============================
1. Double-click R1-NOC-Wall.exe. A console window opens (minimise it - closing it stops the wall).
   The first time, your browser opens the editor; enter your RUCKUS One API details under "R1 connection".
   Windows Firewall may ask to allow it - allow "Private networks" so other computers can open the wall.
2. Wall:   http://localhost:8080/   (the port is shown in the window; it moves to 8081... if 8080 is busy)
   Editor: http://localhost:8080/admin
3. Start automatically: use install-autostart.cmd (portable zip) or tick the option in the installer.
4. Updates: in the editor, "Software update" installs a new release file in place. Your settings are kept in
   %LOCALAPPDATA%\R1 NOC Wall\data (portable zip: the data folder next to the exe).
SmartScreen: the exe is unsigned. If Windows says "unknown publisher": More info, then Run anyway.
R
cp "$W/stage/README-Windows.txt" "$W/readme.tmp"
# portable zip
P="$W/portable/R1 NOC Wall"; mkdir -p "$P"; cp -R "$W/stage/." "$P/"; : > "$P/portable.txt"
printf '@echo off\r\nreg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "R1 NOC Wall" /t REG_SZ /d "\\"%%~dp0R1-NOC-Wall.exe\\"" /f\r\necho R1 NOC Wall will start when you sign in.\r\npause\r\n' > "$P/install-autostart.cmd"
printf '@echo off\r\nreg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "R1 NOC Wall" /f\r\necho Removed.\r\npause\r\n' > "$P/uninstall-autostart.cmd"
ZIP="dist/R1-NOC-Wall-$VER-win-x64.zip"; rm -f "$ZIP"; ( cd "$W/portable" && zip -qr "$OLDPWD/$ZIP" "R1 NOC Wall" )
( cd dist && shasum -a 256 "R1-NOC-Wall-$VER-win-x64.zip" | tee "R1-NOC-Wall-$VER-win-x64.zip.sha256" )
NSIS=""
if command -v makensis >/dev/null; then NSIS="local"
elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker image inspect r1noc-nsis >/dev/null 2>&1 || printf 'FROM debian:bookworm-slim\nRUN apt-get update -qq && apt-get install -y -qq nsis >/dev/null && rm -rf /var/lib/apt/lists/*\n' | docker build -q -t r1noc-nsis - >/dev/null
  NSIS="docker"
fi
if [ -n "$NSIS" ]; then
  echo "== installer ($NSIS makensis)"; EXE="dist/R1-NOC-Wall-$VER-win-x64-setup.exe"
  if [ "$NSIS" = local ]; then makensis -V1 -DVERSION="$VER" -DSTAGE="$PWD/$W/stage" -DOUTFILE="$PWD/$EXE" packaging/win/installer.nsi
  else docker run --rm -v "$PWD":/w -w /w r1noc-nsis makensis -V1 -DVERSION="$VER" -DSTAGE="/w/$W/stage" -DOUTFILE="/w/$EXE" packaging/win/installer.nsi; fi
  ( cd dist && shasum -a 256 "R1-NOC-Wall-$VER-win-x64-setup.exe" | tee "R1-NOC-Wall-$VER-win-x64-setup.exe.sha256" )
else echo "(no makensis or Docker — skipped the installer)"; fi
