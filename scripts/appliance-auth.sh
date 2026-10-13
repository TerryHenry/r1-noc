#!/bin/bash
# Appliance only — enables signing in to the editor with the machine's `noc` password.
# New appliances already have this. On an appliance installed before version 0.2.1 — or before 0.3.5 (which refuses web sign-in until the console
# password has been changed) — after updating the app run once:
#     sudo bash /opt/r1-noc/scripts/appliance-auth.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || exec sudo bash "$0" "$@"
SRC="$(cd "$(dirname "$0")" && pwd)/r1-noc-authcheck"
[ -f "$SRC" ] || { echo "Cannot find $SRC (update the app to 0.2.1 first)"; exit 1; }
install -o root -g root -m 0755 "$SRC" /usr/local/sbin/r1-noc-authcheck
[ -f /etc/r1-noc-auth-users ] || echo noc > /etc/r1-noc-auth-users
printf 'r1noc ALL=(root) NOPASSWD: /usr/local/sbin/r1-noc-authcheck *\n' > /etc/sudoers.d/r1-noc-auth; chmod 0440 /etc/sudoers.d/r1-noc-auth; visudo -cf /etc/sudoers.d/r1-noc-auth >/dev/null
mkdir -p /etc/systemd/system/r1-noc.service.d
printf '[Service]\nNoNewPrivileges=false\nEnvironment=NOC_AUTH_HELPER=/usr/local/sbin/r1-noc-authcheck\n' > /etc/systemd/system/r1-noc.service.d/auth.conf
systemctl daemon-reload; systemctl restart r1-noc
echo "Done. Open https://<address>/admin and sign in as noc (with the password you set at the console)."
