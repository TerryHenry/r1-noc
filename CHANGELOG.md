# Changelog

## 0.2.1
- **Editor sign-in**: a login page (`/login`) with user name and password instead of the long `?key=` address. On the virtual appliance the machine's **`noc` console login** works; elsewhere create an account in the editor (*Editor login*). Sessions, lockout after repeated failures, sign-out.
- The appliance console banner and menu no longer lead with the key address (the key still works for scripts).
- Existing appliances: update the app from the editor, then run `sudo bash /opt/r1-noc/scripts/appliance-auth.sh` once.

## 0.2.0
- **MSP mode** — one API application per customer tenant; customer filter on every widget; customer-named alerts; `?customer=` walls.
- **Client experience analytics** (experimental) — connection success by stage, time to connect, incidents, top applications/SSIDs/APs/clients, failures by SSID/AP/client maker, roaming, client signal, AP uptime, per-venue.
- **HTTPS and certificate management** — self-signed certificates, CSR generation, install a CA-signed certificate, redirect, HSTS, expiry alert.
- **Backup and restore** — configuration-only (credential-free) or full encrypted backups; automatic daily copy; restore with a safety snapshot.
- **In-place upgrade** from a downloaded release file, with a start-up test, automatic backup of the old version and one-click rollback.
- Renamed to **R1 NOC Wall**.

## 0.1.0
- First version: configurable wall dashboards, alerts and notifications, ticker, reports, layout designer.
