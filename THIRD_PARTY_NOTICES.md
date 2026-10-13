# Third-party software

R1 NOC Wall itself is MIT-licensed (see [LICENSE](LICENSE)) and has **no npm dependencies**. The ready-made downloads include (or are built with) the following third-party software.

| Component | Where | License |
|---|---|---|
| **Node.js** (runtime, <https://nodejs.org>) | bundled in the macOS app, the Windows `R1-NOC-Wall.exe` / installer / zip, and the virtual appliance | MIT (full text in `NODE_LICENSE.txt` / `/usr/share/doc/nodejs/copyright`; Node.js also bundles OpenSSL, V8, ICU, zlib and others under their own permissive licenses — see Node's `LICENSE`) |
| **Debian GNU/Linux 12 "bookworm"** (operating system) | virtual appliance (`.ova`) | A collection of free-software packages, mostly GPL / LGPL / BSD / MIT, including the Linux kernel (GPL-2.0), systemd (LGPL-2.1+), GRUB (GPL-3.0+), OpenSSH (BSD), sudo (ISC), open-vm-tools (LGPL-2.1), OpenSSL (Apache-2.0). Each package's license is in `/usr/share/doc/<package>/copyright` inside the VM. |
| **postject** | used at build time to embed the launcher in the Windows `.exe` | MIT |
| **NSIS** | used at build time to create the Windows installer (its small runtime stub is part of `…-setup.exe`) | zlib/libpng-style license |

**Source code for the GPL / LGPL components of the appliance** is available from Debian: <https://www.debian.org/distrib/packages> (source packages) and <https://snapshot.debian.org>. The exact package versions are those installed in the VM (`dpkg -l`); if you cannot obtain a source package, open an issue and it will be provided.

"RUCKUS" and "RUCKUS One" are trademarks of their respective owner. This is an unofficial, independent project and is not affiliated with or endorsed by RUCKUS / CommScope.
