#!/usr/bin/env bash
# Build "R1 NOC Wall.app" (universal: Apple silicon + Intel, Node.js bundled) and a .dmg:  packaging/mac/build-mac.sh   →   dist/
# Needs a Mac with Xcode command-line tools (swiftc, lipo, iconutil, hdiutil) and curl. The app is ad-hoc signed (not notarized).
set -euo pipefail
cd "$(dirname "$0")/../.."
VER=$(node -p "require('./package.json').version"); NODE_VER=${NODE_VER:-v24.19.0}
CACHE=packaging/.cache; mkdir -p "$CACHE" dist; B="$CACHE/mac-build"; rm -rf "$B"; mkdir -p "$B"
APP="dist/R1 NOC Wall.app"; rm -rf "$APP"
echo "== release package"; npm run -s package >/dev/null
for A in arm64 x64; do
  T="$CACHE/node-darwin-$A.tar.gz"
  if [ ! -f "$T" ] || [ "$(cat "$CACHE/node-darwin-$A.version" 2>/dev/null)" != "$NODE_VER" ]; then
    echo "== downloading Node $NODE_VER (darwin-$A)"; curl -fL --progress-bar -o "$T" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$A.tar.gz"
    curl -fsSL "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" | grep "node-$NODE_VER-darwin-$A.tar.gz" | awk '{print $1"  '"$T"'"}' | shasum -a 256 -c -; echo "$NODE_VER" > "$CACHE/node-darwin-$A.version"
  fi
  mkdir -p "$B/n-$A"; tar -xzf "$T" -C "$B/n-$A" --strip-components=1
done
echo "== universal node"; lipo -create "$B/n-arm64/bin/node" "$B/n-x64/bin/node" -output "$B/node"
echo "== launcher (Swift, universal)"
for A in arm64 x86_64; do swiftc -O -target "$A-apple-macos12.0" -o "$B/launcher-$A" packaging/mac/main.swift; done
lipo -create "$B/launcher-arm64" "$B/launcher-x86_64" -output "$B/launcher"
echo "== icon"; swiftc -o "$B/icon" packaging/mac/icon.swift && "$B/icon" "$B/icon1024.png"
IS="$B/R1.iconset"; mkdir -p "$IS"; for s in 16 32 64 128 256 512; do sips -z $s $s "$B/icon1024.png" --out "$IS/icon_${s}x${s}.png" >/dev/null; sips -z $((s*2)) $((s*2)) "$B/icon1024.png" --out "$IS/icon_${s}x${s}@2x.png" >/dev/null; done
iconutil -c icns "$IS" -o "$B/R1.icns"
echo "== bundle"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
cp "$B/launcher" "$APP/Contents/MacOS/R1NOCWall"; cp "$B/node" "$APP/Contents/Resources/node"; cp "$B/R1.icns" "$APP/Contents/Resources/R1.icns"
tar -xzf "dist/r1-noc-$VER.tgz" -C "$APP/Contents/Resources/app" --strip-components=1
cat > "$APP/Contents/Info.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>R1 NOC Wall</string><key>CFBundleDisplayName</key><string>R1 NOC Wall</string>
  <key>CFBundleIdentifier</key><string>local.r1noc.wall</string><key>CFBundleExecutable</key><string>R1NOCWall</string>
  <key>CFBundleIconFile</key><string>R1</string><key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VER</string><key>CFBundleVersion</key><string>$VER</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/>
</dict></plist>
P
codesign --force -s - "$APP/Contents/Resources/node"; codesign --force --deep -s - "$APP"
echo "== dmg"
DMG="dist/R1-NOC-Wall-$VER-mac.dmg"; rm -f "$DMG"; S="$B/dmg"; mkdir -p "$S"; cp -R "$APP" "$S/"; ln -s /Applications "$S/Applications"
cat > "$S/READ ME FIRST.txt" <<R
Drag "R1 NOC Wall" to Applications and open it. It lives in the menu bar ("R1").
The first time, macOS may say it cannot verify the developer: right-click the app, choose Open, then Open again
(or run:  xattr -dr com.apple.quarantine "/Applications/R1 NOC Wall.app").
Your data is kept in ~/Library/Application Support/R1 NOC Wall.
R
hdiutil create -quiet -volname "R1 NOC Wall" -srcfolder "$S" -ov -format UDZO "$DMG"
( cd dist && shasum -a 256 "R1-NOC-Wall-$VER-mac.dmg" | tee "R1-NOC-Wall-$VER-mac.dmg.sha256" )
