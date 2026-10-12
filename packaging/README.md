# Packaging

Everything here builds from the committed source; outputs land in `dist/` (git-ignored). Each script downloads the pinned Node.js release
(`NODE_VER`, default `v24.19.0`) and checks its SHA-256.

| Script | Output | Needs |
|---|---|---|
| `npm run package` | `dist/r1-noc-<ver>.tgz` — the release file used by *Software update* | Node, `tar` |
| `packaging/ova/build-ova.sh` | `dist/R1-NOC-Wall-<ver>.ova` — virtual appliance (Debian 12, x86-64, BIOS + UEFI) | Docker (privileged containers), ~10 GB disk, 30–60 min under emulation on Apple silicon |
| `packaging/ova/test-boot.sh [bios\|uefi]` | boots the built disk under QEMU and checks HTTP/HTTPS | Docker |
| `packaging/mac/build-mac.sh` | `dist/R1 NOC Wall.app` + `R1-NOC-Wall-<ver>-mac.dmg` — universal menu-bar app with Node bundled | macOS + Xcode command-line tools |
| `packaging/win/build-win.sh` | `R1-NOC-Wall-<ver>-win-x64.zip` (portable) and `…-setup.exe` (per-user installer) | Node (same version as bundled), Docker or `makensis` for the installer |

Release checklist: bump `version` in `package.json`, update `CHANGELOG.md`, commit, run the scripts, publish the files with their `.sha256`.

## What each artifact is
- **Appliance** — `ova/make-image.sh` runs in a privileged `linux/amd64` container: it partitions a raw disk (GPT: BIOS-boot, EFI, ext4), `debootstrap`s Debian 12, installs GRUB for both BIOS and UEFI, installs the app to `/opt/r1-noc` (owned by the service user, so in-app upgrades work), and converts the disk to a stream-optimized VMDK; `ova/mkovf.py` wraps it in an OVF + manifest. Files copied into the guest are in `ova/guest/`.
- **macOS app** — `mac/main.swift` is a menu-bar launcher that runs the bundled Node and the app from `~/Library/Application Support/R1 NOC Wall/app` (seeded from the bundle), restarts it after in-app upgrades, and stops it when it quits. Ad-hoc signed, not notarized.
- **Windows** — `R1-NOC-Wall.exe` is Node.js with `win/launcher.js` embedded as a single-executable application; the app itself stays in `app\`. Not Authenticode-signed.
