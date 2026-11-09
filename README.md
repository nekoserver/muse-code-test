# muse-code-test

Fork of the musevm-kernel repository (copied 2026-11-10) that adds
**Muse Code** dispatch: the Worker takes a coding instruction and the
in-container Muse Code executes it.

- `POST /cf-containers/code` with JSON `{"instruction": "..."}` —
  HMAC-gated like the rest of the control API, stopped-gate applies.
  The Worker forwards it to the agent's `POST /agent/code/run`.
- `container-agent.py` spawns a fresh `muse serve` host per request and
  drives one turn through the Python SDK (`muse-code-sdk`, Muse
  Session Protocol), returning the agent's messages, the turn outcome,
  and item counts as JSON. Sessions are single-turn in this version
  (a fresh host per request; no cross-request resume yet).
- The session runs under the `:unrestricted` permission profile by
  default (no sandbox, no approval prompts; override with
  `MUSE_CODE_PERMISSION_PROFILE`). Only send instructions you trust —
  the HMAC control API is the only gate.
- Auth: the `META_API_KEY` secret must be set on this Worker
  (`wrangler secret put META_API_KEY`); it is forwarded into the
  container. Without it, runs return `terminal: failed` with an
  `authRequired` error. `GET /cf-containers/agent/status` reports the
  CLI/SDK versions and `api_key_present` under `muse_code`.
- The Muse Code native binary adds ~415 MB to the image. The SDK is
  installed version-locked to the CLI (they release in lockstep).
- Worker name is `muse-code-test` (wrangler.toml / package.json);
  TypeScript is on the 7.x line.

Everything below is inherited from musevm-kernel.

---

# musevm-kernel

Minimized Linux kernel boot images for the musevm project.

## Layout

One directory per kernel version:

```text
<version>/
  bzImage.b64.part-00 ...   bzImage, Base64-encoded, split into 2 MiB chunks
                            (the publishing path is text-only, hence Base64)
  config-<version>-minimized  the exact .config the image was built with
  SHA256SUMS                  SHA-256 of the reassembled bzImage
  rootfs-<version>.img.gz.b64.part-00 ...
                            the matching root filesystem image (btrfs,
                            for virtio-blk), gzip-compressed, Base64,
                            split the same way
  SHA256SUMS.rootfs           SHA-256 of the reassembled .img.gz
```

## Current image: 7.3.1

- Linux 7.3.1, x86_64, 1,990 enabled options, all built-in, no modules
- Kernel compression: ZSTD
- bzImage size: 13,361,664 bytes
- Device scope: virtio (net/blk/rng/balloon/vsock), btrfs, device-mapper,
  overlayfs, ext4, tmpfs, serial console, IPv4/IPv6, namespaces/cgroups
- Built 2026-11-04. Boot verification on the target is still pending.

## Reassemble

```sh
cd 7.3.1
cat bzImage.b64.part-* | base64 -d > bzImage
sha256sum -c SHA256SUMS

# root filesystem (boots to a bash shell with the bzImage above)
cat rootfs-7.3.1.img.gz.b64.part-* | base64 -d > rootfs-7.3.1.img.gz
sha256sum -c SHA256SUMS.rootfs
gzip -d rootfs-7.3.1.img.gz
qemu-system-x86_64 -enable-kvm -m 512 \
  -kernel bzImage \
  -drive file=rootfs-7.3.1.img,format=raw,if=virtio \
  -append "root=/dev/vda rw console=ttyS0" -nographic
```

## Workers + Containers

This repository is also a Cloudflare Workers + Containers project (same
structure as the musevm repository):

- `wrangler.toml` — Worker `musevm-kernel-worker`, container class
  `KernelContainer`, basic instance, Durable Object binding.
- `Dockerfile` — multi-stage: stage 1 reassembles and SHA-256-verifies the
  bzImage from the chunks above; the final image (Debian trixie-slim)
  carries the verified artifact at `/opt/musevm-kernel/<version>/`, the
  kernel build toolchain, QEMU for boot testing, and the agent-managed
  daemons (tailscaled 1.104.5, cloudflared 2026.10.7, Apache httpd 2.4.69
  built from source on :8081).
- `src/index.ts` — Worker with a `/cf-containers` control page: container
  start/stop/restart/status, kernel artifact status, a QEMU boot
  smoke test (the image has no root filesystem, so reaching the VFS
  root-mount panic is the success signal), and Tailscale / cloudflared /
  Apache panels with status and start/stop (daemon secrets TS_AUTHKEY
  and TUNNEL_TOKEN are set per-Worker with `wrangler secret put`).
  Optional `CONTROL_TOKEN` secret enables HMAC-signed control API access.
- `container-agent.py` — in-container agent on port 8080 backing the
  control page.
- `SPEC.musevm-kernel.SETUP.md` — full setup spec and deploy checklist.

Connect this repository in Workers Builds (Worker name
`musevm-kernel-worker`, root directory = repo root, deploy command
`npx wrangler deploy`, production branch `main`) and pushes to `main`
build and deploy the container automatically.

## Root filesystem (virtio-blk + btrfs)

`rootfs/` holds the recipe for the kernel's own root filesystem
(decided scheme: virtio-blk + btrfs, `root=/dev/vda`): a shell-script
init, bash, and busybox, packed with `mkfs.btrfs --rootdir`. Boot to an
interactive shell was verified under QEMU on 2026-11-04; see
`rootfs/README.md` for the details. The image itself (256 MiB,
~3.1 MB gzipped) is published in `7.3.1/` as Base64 chunks next to
the bzImage, so the boot pair can be downloaded together.
