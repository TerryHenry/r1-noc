#!/usr/bin/env bash
# Build the R1 NOC Wall virtual appliance:  packaging/ova/build-ova.sh   →   dist/R1-NOC-Wall-<version>.ova
# Needs Docker (any host architecture; the amd64 image is built under emulation on Apple Silicon — allow ~30–60 min) and curl.
set -euo pipefail
cd "$(dirname "$0")/../.."
VER=$(node -p "require('./package.json').version"); NODE_VER=${NODE_VER:-v24.19.0}; DISK_SIZE=${DISK_SIZE:-8G}
CACHE=packaging/.cache; mkdir -p "$CACHE" dist
echo "== release package"; npm run -s package >/dev/null; cp "dist/r1-noc-$VER.tgz" "$CACHE/"
NODE_TAR="$CACHE/node-linux-x64.tar.xz"
if [ ! -f "$NODE_TAR" ] || [ "$(cat "$CACHE/node.version" 2>/dev/null)" != "$NODE_VER" ]; then
  echo "== downloading Node $NODE_VER (linux-x64)"
  curl -fL --progress-bar -o "$NODE_TAR" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" | grep "node-$NODE_VER-linux-x64.tar.xz" | awk '{print $1"  '"$NODE_TAR"'"}' | shasum -a 256 -c -
  echo "$NODE_VER" > "$CACHE/node.version"
fi
echo "== builder image"; docker build -q --platform linux/amd64 -t r1noc-ova-builder packaging/ova/builder >/dev/null
echo "== building the disk (this is the slow part)"
mkdir -p "$CACHE/out"; docker volume create r1noc-ova-work >/dev/null
docker run --rm --privileged --platform linux/amd64 -e VER="$VER" -e DISK_SIZE="$DISK_SIZE" \
  -v r1noc-ova-work:/work -v "$PWD/packaging/ova/guest:/guest:ro" -v "$PWD/packaging/ova/make-image.sh:/make-image.sh:ro" -v "$PWD/$CACHE:/cache:ro" -v "$PWD/$CACHE/out:/out" \
  r1noc-ova-builder bash /make-image.sh
echo "== OVA"; python3 packaging/ova/mkovf.py "$CACHE/out/disk.vmdk" "dist/R1-NOC-Wall-$VER.ova" "$VER" "${DISK_SIZE%G}"
( cd dist && shasum -a 256 "R1-NOC-Wall-$VER.ova" | tee "R1-NOC-Wall-$VER.ova.sha256" )
