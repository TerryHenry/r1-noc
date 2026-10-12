#!/usr/bin/env bash
# Boot-test the freshly built appliance disk under QEMU (software emulation, so it is slow: allow several minutes).
#   packaging/ova/test-boot.sh [bios|uefi]
# Checks that the machine boots, the app answers over HTTP (redirect) and HTTPS, and prints the console banner.
set -euo pipefail
MODE=${1:-bios}
docker run --rm --platform linux/arm64 -e MODE="$MODE" -v r1noc-ova-work:/work debian:bookworm-slim bash -c '
set -e
apt-get update -qq >/dev/null; apt-get install -y -qq qemu-system-x86 ovmf curl >/dev/null 2>&1
FW=""; [ "$MODE" = uefi ] && FW="-bios /usr/share/ovmf/OVMF.fd"
qemu-system-x86_64 -machine q35 -cpu max -m 2048 -smp 2 $FW -nographic -serial file:/work/serial.log -monitor none \
  -drive file=/work/disk.raw,format=raw,if=none,id=d0,snapshot=on -device virtio-scsi-pci -device scsi-hd,drive=d0 \
  -netdev user,id=n0,hostfwd=tcp::5080-:80,hostfwd=tcp::5443-:443 -device e1000,netdev=n0 &
Q=$!; trap "kill $Q 2>/dev/null" EXIT
for i in $(seq 1 120); do
  sleep 5
  if curl -sk -m 4 https://127.0.0.1:5443/api/config -o /work/cfg.json 2>/dev/null && grep -q layout /work/cfg.json; then echo "HTTPS UP after ~$((i*5))s"; break; fi
done
echo "--- https config:"; head -c 120 /work/cfg.json; echo
echo "--- http (should redirect to https):"; curl -s -m 5 -o /dev/null -w "%{http_code} -> %{redirect_url}\n" -H "Host: 10.0.2.15" http://127.0.0.1:5080/ || true
echo "--- console (last lines):"; tr -d "\r" < /work/serial.log | grep -v "^\s*$" | tail -22
'
