#!/usr/bin/env python3
"""Drive a QEMU serial-console boot test for the minimized kernel.

Usage: run-qemu.py <qemu-args-file> <script-file> <log-file> [timeout]

qemu-args-file: one extra QEMU argument per line (kernel/initrd/drive
are added by the caller via the file as well — this script only appends
the fixed machine/console options).
script-file: lines to send to the shell, sent one at a time after the
marker "TO_SHELL" appears in the serial output; if the marker never
appears, lines are sent after 60 s regardless.
Exits 0 when QEMU exits on its own (poweroff) before the timeout.
"""
import os
import select
import subprocess
import sys
import time

TC = os.path.expanduser("~/workspace/kernel/.toolchain/root")
QEMU = os.path.join(TC, "usr/bin/qemu-system-x86_64")
ENV = dict(os.environ)
ENV["LD_LIBRARY_PATH"] = (
    f"{TC}/usr/lib/x86_64-linux-gnu:{TC}/lib/x86_64-linux-gnu"
)

args_file, script_file, log_file = sys.argv[1], sys.argv[2], sys.argv[3]
timeout = int(sys.argv[4]) if len(sys.argv) > 4 else 240

extra = [l.strip() for l in open(args_file) if l.strip()]
cmds = [l.rstrip("\n") for l in open(script_file) if l.strip()]

cmd = [QEMU, "-machine", "accel=tcg", "-m", "512", "-nic", "none",
       "-L", os.path.join(TC, "usr/share/seabios"),
       "-L", os.path.join(TC, "usr/share/qemu"),
       "-display", "none", "-serial", "stdio", "-monitor", "none",
       "-no-reboot"] + extra

log = open(log_file, "wb")
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.STDOUT, env=ENV)
buf = b""
sent = False
deadline = time.time() + timeout
try:
    while time.time() < deadline:
        if p.poll() is not None:
            # drain whatever the guest printed on its way out
            try:
                while True:
                    chunk = os.read(p.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    log.write(chunk)
            except OSError:
                pass
            break
        r, _, _ = select.select([p.stdout], [], [], 1.0)
        if r:
            chunk = os.read(p.stdout.fileno(), 65536)
            if not chunk:
                break
            log.write(chunk)
            log.flush()
            buf += chunk
            if not sent and (b"TO_SHELL" in buf
                             or time.time() > deadline - timeout + 60):
                for c in cmds:
                    p.stdin.write((c + "\n").encode())
                    p.stdin.flush()
                    time.sleep(0.7)
                sent = True
finally:
    log.close()
    if p.poll() is None:
        p.kill()
        print("TIMEOUT: qemu killed")
        sys.exit(2)
print(f"qemu exited rc={p.returncode}")
sys.exit(0)
