#!/bin/bash
# Runs INSIDE the privileged linux/amd64 builder container. Produces /out/disk.raw (GPT: BIOS-boot + EFI + ext4 root; boots under BIOS and UEFI).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
IMG=/work/disk.raw; SIZE=${DISK_SIZE:-8G}; M=/mnt/target
mkdir -p /work $M; truncate -s "$SIZE" "$IMG"
LOOP=$(losetup -f --show -P "$IMG"); LB=$(basename "$LOOP")
cleanup() { set +e; for m in dev/pts dev proc sys boot/efi ""; do umount -l "$M/$m" 2>/dev/null; done; losetup -d "$LOOP" 2>/dev/null; }
trap cleanup EXIT
parted -s "$LOOP" mklabel gpt mkpart bios 1MiB 3MiB set 1 bios_grub on mkpart esp fat32 3MiB 259MiB set 2 esp on mkpart root ext4 259MiB 100%
for n in 1 2 3; do IFS=: read -r maj min < "/sys/block/$LB/${LB}p$n/dev"; rm -f "${LOOP}p$n"; mknod "${LOOP}p$n" b "$maj" "$min"; done   # no udev in a container
mkfs.vfat -F32 -n EFI "${LOOP}p2" >/dev/null; mkfs.ext4 -q -L r1noc-root -F "${LOOP}p3"
mount "${LOOP}p3" $M; mkdir -p $M/boot/efi; mount "${LOOP}p2" $M/boot/efi

echo "== debootstrap"
debootstrap --arch=amd64 --variant=minbase --components=main \
  --include=systemd,systemd-sysv,systemd-timesyncd,dbus,udev,kmod,iproute2,iputils-ping,ca-certificates,openssl,curl,tar,gzip,xz-utils,less,nano,sudo,whiptail,tzdata,locales,procps,fdisk,cloud-guest-utils,e2fsprogs,openssh-server,open-vm-tools,unattended-upgrades,netbase,systemd-resolved,gdisk \
  bookworm $M http://deb.debian.org/debian >/work/debootstrap.log 2>&1 || { tail -20 /work/debootstrap.log; exit 1; }
for d in dev proc sys; do mount --bind /$d $M/$d; done; mount --bind /dev/pts $M/dev/pts
UUID_ROOT=$(blkid -s UUID -o value "${LOOP}p3")
cat > $M/etc/fstab <<F
LABEL=r1noc-root / ext4 errors=remount-ro 0 1
LABEL=EFI /boot/efi vfat umask=0077 0 2
F
echo r1-noc-wall > $M/etc/hostname; printf '127.0.0.1 localhost\n127.0.1.1 r1-noc-wall\n' > $M/etc/hosts
cat > $M/etc/apt/sources.list <<'F'
deb http://deb.debian.org/debian bookworm main
deb http://deb.debian.org/debian bookworm-updates main
deb http://security.debian.org/debian-security bookworm-security main
F
rm -f $M/etc/resolv.conf; cp /etc/resolv.conf $M/etc/resolv.conf   # the chroot needs DNS for apt
echo 'Acquire::Retries "6";' > $M/etc/apt/apt.conf.d/80retries
echo "== kernel + bootloader"
chroot $M /bin/bash -euxc '
  apt-get update -qq
  echo "grub-pc grub-pc/install_devices multiselect" | debconf-set-selections
  apt-get install -y --no-install-recommends linux-image-amd64 initramfs-tools grub-pc grub-efi-amd64-bin os-prober- >/dev/null
  sed -i "s/^GRUB_CMDLINE_LINUX=.*/GRUB_CMDLINE_LINUX=\"net.ifnames=0 biosdevname=0 console=tty0 console=ttyS0,115200n8\"/; s/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=2/" /etc/default/grub
  grep -q GRUB_TERMINAL /etc/default/grub || echo "GRUB_TERMINAL=\"console serial\"
GRUB_SERIAL_COMMAND=\"serial --speed=115200\"" >> /etc/default/grub
  grub-install --target=i386-pc '"$LOOP"'
  grub-install --target=x86_64-efi --efi-directory=/boot/efi --removable --no-nvram
  update-grub
' > /work/grub.log 2>&1 || { tail -30 /work/grub.log; exit 1; }
grep -q "root=" $M/boot/grub/grub.cfg && sed -i "s#root=/dev/loop[0-9]*p3#root=UUID=$UUID_ROOT#g" $M/boot/grub/grub.cfg
grep -c "root=UUID=$UUID_ROOT" $M/boot/grub/grub.cfg >/dev/null || { echo "grub.cfg has no UUID root"; grep -n "linux " $M/boot/grub/grub.cfg | head; exit 1; }

echo "== app + runtime"
tar -xJf /cache/node-linux-x64.tar.xz -C /tmp && install -m 0755 /tmp/node-*-linux-x64/bin/node $M/usr/local/bin/node
mkdir -p $M/opt/r1-noc $M/var/lib/r1-noc $M/usr/local/share/r1-noc
tar -xzf "/cache/r1-noc-$VER.tgz" -C $M/opt/r1-noc --strip-components=1
G=/guest
install -m 0755 $G/r1-noc-firstboot $G/r1-noc-cert $G/r1-noc-banner $G/r1-noc-config $M/usr/local/sbin/
install -m 0644 $G/r1-noc.service $G/r1-noc-firstboot.service $G/r1-noc-banner.service $G/r1-noc-banner.timer $M/etc/systemd/system/
install -o root -g root -m 0755 $M/opt/r1-noc/scripts/r1-noc-authcheck $M/usr/local/sbin/r1-noc-authcheck
echo noc > $M/etc/r1-noc-auth-users
printf 'r1noc ALL=(root) NOPASSWD: /usr/local/sbin/r1-noc-authcheck *\n' > $M/etc/sudoers.d/r1-noc-auth; chmod 0440 $M/etc/sudoers.d/r1-noc-auth
install -m 0644 $G/10-ethernet.network $M/usr/local/share/r1-noc/10-ethernet.network
install -D -m 0644 $G/10-ethernet.network $M/etc/systemd/network/10-ethernet.network
echo "== users, services, cleanup"
chroot $M /bin/bash -euxc '
  sed -i "s/^# *en_US.UTF-8/en_US.UTF-8/" /etc/locale.gen; locale-gen >/dev/null; echo "LANG=en_US.UTF-8" > /etc/default/locale
  ln -sf /usr/share/zoneinfo/UTC /etc/localtime; echo UTC > /etc/timezone
  useradd --system --home-dir /var/lib/r1-noc --shell /usr/sbin/nologin r1noc
  chown -R r1noc:r1noc /opt/r1-noc /var/lib/r1-noc
  useradd -m -s /bin/bash -G sudo,systemd-journal noc; echo "noc:noc" | chpasswd; chage -d 0 noc
  passwd -l root
  systemctl enable systemd-networkd systemd-resolved systemd-timesyncd r1-noc r1-noc-firstboot r1-noc-banner.timer open-vm-tools unattended-upgrades >/dev/null 2>&1 || true
  systemctl disable ssh >/dev/null 2>&1 || true
  ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
  # getty: show /etc/issue on the serial console too
  systemctl enable serial-getty@ttyS0.service >/dev/null 2>&1 || true
  rm -f /etc/ssh/ssh_host_*; : > /etc/machine-id; rm -f /var/lib/dbus/machine-id
  apt-get clean; rm -rf /var/lib/apt/lists/* /var/cache/apt/* /tmp/* /var/log/*.log /var/log/apt /usr/share/doc/* /usr/share/man/*
' > /work/config.log 2>&1 || { tail -30 /work/config.log; exit 1; }
echo "R1 NOC Wall appliance. Run: sudo r1-noc-config" > $M/etc/motd
/bin/bash -c "cat > $M/etc/issue <<'F'

  R1 NOC Wall — starting up…  (the addresses to use appear here once the network is up)

F"
sync; for m in dev/pts dev proc sys; do umount -l $M/$m; done
fstrim -v $M/ || true; fstrim -v $M/boot/efi || true
umount $M/boot/efi; umount $M
echo "== convert"
mkdir -p /out; qemu-img convert -f raw -O vmdk -o subformat=streamOptimized,adapter_type=lsilogic "$IMG" /out/disk.vmdk
ls -lh /out
