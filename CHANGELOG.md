# Changelog

## 0.3.2
- **Switching events** (new widget group + **Switch events** preset): *flapping ports*, port link changes, spanning-tree state changes, err-disable events, a recent-events list, noisiest switches/venues and events per hour — derived from the app's own port polling (sampled every few minutes; the log is kept 7 days) — plus *loops detected*, *port-flap* and *TCP SYN flood* incidents and a switching-incident list from R1's analytics service. Works per venue and per customer; three new alert metrics.

## 0.3.1
- **One connection panel.** *R1 connection* now starts with a switch — *One RUCKUS One account* / *MSP — one key for all my customers* / *MSP — a separate key for each customer* — and shows only the fields for the chosen mode. The separate *Customers (MSP)* panel is gone. Existing installs keep working (the mode is worked out from what you had configured).

## 0.3.0
- **MSP account mode** — one API key created in the MSP's own account lists every customer (`/tenants/query`) and reads each one through R1's *delegated access* (`x-rks-tenantid`). No per-customer keys needed (they still work alongside it). Untick customers you don't want on the wall.
- **Fleet statistics across all customers**: a *Customer* dimension on clients, APs, radios, switches, ports, alarms, DPSK, guests and networks (84 generated widgets: counts, throughput, traffic, signal, PoE… by customer, and over time by customer), fleet KPIs and totals, offline/throughput rankings, and an **MSP fleet statistics** preset.
- **MSP rankings, health and trends**: customer health score (with breakdown), AP availability, load, signal, firmware lag and versions, licenses vs devices, connection-experience and incident rankings, busiest venues, and per-customer trend lines; presets *MSP rankings*, *MSP trends*, *MSP fleet detail*.
- New MSP widgets and presets: **MSP licensing** (nearest account/trial expiry, licenses per customer, MSP subscriptions, trial watch), Account and Licenses columns on the Customers overview; alert metrics for account expiry and expiring subscriptions.

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
