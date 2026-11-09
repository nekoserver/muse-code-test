#!/bin/sh
# Assemble the minimal root filesystem tree and pack it as a btrfs image.
#
# Milestone scope: boot the minimized kernel from virtio-blk
# (root=/dev/vda) to a bash shell on the serial console. Userland is the
# smallest honest set for that: a shell-script /sbin/init, bash (the
# current shell, per the parity baseline), and busybox for the core
# utilities. Binaries are taken from the host / distribution packages
# for this boot-verification assembly; the from-source userland build
# is the later refinement in the plan.
#
# Usage: build-rootfs.sh [image-size]   (default 256M)
set -eu

RF="$HOME/workspace/kernel/rootfs"
TC="$HOME/workspace/kernel/.toolchain/root"
TREE="$RF/tree"
IMG="$RF/out/rootfs-7.3.1.img"
SIZE="${1:-256M}"

export LD_LIBRARY_PATH="$TC/usr/lib/x86_64-linux-gnu:$TC/lib/x86_64-linux-gnu"

rm -rf "$TREE"
mkdir -p "$TREE"/usr/bin "$TREE"/usr/sbin "$TREE"/usr/lib/x86_64-linux-gnu \
         "$TREE"/lib64 "$TREE"/etc "$TREE"/proc "$TREE"/sys "$TREE"/dev \
         "$TREE"/run "$TREE"/tmp "$TREE"/root "$TREE"/mnt "$TREE"/src
chmod 1777 "$TREE"/tmp
ln -s usr/bin "$TREE"/bin
ln -s usr/sbin "$TREE"/sbin
ln -s usr/lib "$TREE"/lib

# bash + the shared libraries it needs (paths as the ELF loader sees them)
cp /bin/bash "$TREE"/usr/bin/bash
for lib in $(ldd /bin/bash | awk '/=> \// {print $3}'); do
    case "$lib" in
        /lib64/ld-linux-*) cp "$lib" "$TREE"/lib64/ ;;
        *) cp "$lib" "$TREE"/usr/lib/x86_64-linux-gnu/ ;;
    esac
done
cp /lib64/ld-linux-x86-64.so.2 "$TREE"/lib64/ 2>/dev/null || true

# busybox (static) + applet links
cp "$TC"/usr/bin/busybox "$TREE"/usr/bin/busybox
for app in sh mount umount uname poweroff ls cat mkdir hostname dmesg \
           grep echo printf sleep sync rm cp mv ln; do
    ln -s busybox "$TREE"/usr/bin/"$app"
done

# init: shell script — mounts the virtual filesystems, reports, and
# execs an interactive bash on the console.
cat > "$TREE"/usr/sbin/init <<'EOS'
#!/bin/sh
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sysfs /sys 2>/dev/null
mount -t devtmpfs devtmpfs /dev 2>/dev/null
hostname musevm-kernel
echo "ROOTFS_INIT_OK kernel=$(uname -r)"
mount | grep ' on / '
echo "TO_SHELL"
exec /bin/bash -i
EOS
chmod 755 "$TREE"/usr/sbin/init

cat > "$TREE"/etc/passwd <<'EOF'
root:x:0:0:root:/root:/bin/bash
EOF
echo "musevm-kernel" > "$TREE"/etc/hostname

# No static device nodes: this container forbids mknod, and with
# CONFIG_DEVTMPFS_MOUNT=y the kernel mounts devtmpfs on /dev right
# after mounting the root filesystem, before it opens /dev/console
# for init — so the console node comes from devtmpfs.

rm -f "$IMG"
truncate -s "$SIZE" "$IMG"
"$TC"/sbin/mkfs.btrfs -f -L musevm-root --rootdir "$TREE" "$IMG"
echo "built: $IMG"
