# Tools needed to assemble the appliance disk (runs privileged, linux/amd64).
FROM debian:bookworm
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      debootstrap parted gdisk e2fsprogs dosfstools util-linux qemu-utils xz-utils ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/*
