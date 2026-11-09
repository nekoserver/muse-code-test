# Root filesystem for the minimized kernel (7.3.1)

Scheme (decided 2026-11-04): **virtio-blk + btrfs** — `root=/dev/vda`.

## Status: boot-to-shell verified (2026-11-04, QEMU TCG, local)

Both stages were exercised with the built 7.3.1 bzImage under QEMU
(`run-qemu.py` drives the serial console and checks for markers):

1. **Stage 1 — initramfs** (`initramfs/init`, busybox `/init`):
   `/init` ran as PID 1, mounted devtmpfs/proc/sysfs, and dropped to an
   interactive shell; commands executed on the console and the machine
   powered off cleanly (`reboot: Power down`).
2. **Stage 2 — btrfs root** (`build-rootfs.sh`): the kernel mounted the
   btrfs image from virtio-blk (`VFS: Mounted root (btrfs filesystem)`,
   `/dev/root on / type btrfs (rw,...)`), ran the rootfs `/sbin/init`,
   and reached an interactive **bash** shell on the console
   (`ROOTFS_SHELL_OK`, `uname -r` → `7.3.1`), then powered off cleanly.

The image is published in `7.3.1/` next to the bzImage (gzip +
Base64 chunks, like the kernel): `rootfs-7.3.1.img.gz.b64.part-00..02`
with `SHA256SUMS.rootfs`. Reassemble and boot:

```sh
cd 7.3.1
cat rootfs-7.3.1.img.gz.b64.part-* | base64 -d > rootfs-7.3.1.img.gz
sha256sum -c SHA256SUMS.rootfs
gzip -d rootfs-7.3.1.img.gz
```

Hashes: the `.img.gz` is
`62a72ab2a28bc1abe4bac4aef18461a1c39d3fc1164d8a31f7a70616acb65b93`;
the decompressed 256 MiB `rootfs-7.3.1.img` is
`186902379e30d4c069ca19e2e1d615a32108c48f81cbe3322e2cac9d3c21de7d`.
`build-rootfs.sh` regenerates an equivalent image locally. The
container image does not embed the rootfs — a container cannot boot
this kernel as its host kernel; the rootfs is for a VM or machine the
user controls.

## Contents of the rootfs (milestone scope)

- `/sbin/init` — shell script: mounts proc/sysfs/devtmpfs, sets the
  hostname, reports, and execs interactive bash on the console.
  No static device nodes are needed: with `CONFIG_DEVTMPFS_MOUNT=y`
  the kernel mounts devtmpfs on `/dev` right after the root mount,
  before opening `/dev/console` for init.
- bash + its shared libraries (the shell of the parity baseline).
- busybox (static) with applet links for the core utilities
  (sh, mount, uname, ls, cat, dmesg, poweroff, ...).
- Layout: usrmerge (`/bin`, `/sbin`, `/lib` are symlinks), `/src` as the
  future kernel-build work area.

## Honest scope notes

- This is a **boot-verification assembly**: bash and busybox are taken
  from the host / distribution packages, not built from source. The
  pseudo-Gentoo from-source userland remains the end-state; the daemon
  set (tailscaled, cloudflared, Apache, container agent) is not in this
  rootfs yet — it lands with the userland selection decisions.
- QEMU here is TCG emulation (no KVM), same as the container boot test.
- `bash: cannot set terminal process group` on the console is expected
  for a shell started this way (no session/job-control setup yet) and
  is harmless for this milestone.

## Files

- `build-rootfs.sh` — assemble the tree and pack it with
  `mkfs.btrfs --rootdir` (no loop mount needed).
- `initramfs/init` — stage-1 initramfs `/init`.
- `run-qemu.py` — serial-console test driver (marker-based, sends shell
  commands after `TO_SHELL`, captures the log).
