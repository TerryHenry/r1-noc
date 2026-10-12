#!/usr/bin/env bash
# Scripted console login + inspection of the built appliance under QEMU:  packaging/ova/test-deep.sh [bios|uefi]
set -euo pipefail
docker run --rm --platform linux/arm64 -v r1noc-ova-work:/work -v "$PWD/packaging/ova/test-login.py:/t.py:ro" debian:bookworm-slim bash -c '
apt-get update -qq >/dev/null; apt-get install -y -qq qemu-system-x86 ovmf curl python3-pexpect >/dev/null 2>&1; python3 /t.py '"${1:-bios}"''
