#!/usr/bin/env python3
"""Container agent for the musevm-kernel image.

Serves a small HTTP API on port 8080 (the port the Worker proxies to) so the
/cf-containers page can see and control what runs inside the container:

  GET  /agent/status            aggregate status: system stats, kernel
                                artifact, tailscale / cloudflared / apache
  POST /agent/kernel/boot-test  boot the bzImage under QEMU (TCG emulation,
                                no KVM here) with a serial console and
                                classify how far it got. There is no root
                                filesystem in the image, so a healthy kernel
                                ends at the VFS root-mount panic — reaching
                                that panic is the success signal.
  POST /agent/tailscale/start   start tailscaled (userspace networking) and,
                                if TS_AUTHKEY is set, `tailscale up` with it
  POST /agent/tailscale/stop    stop tailscaled
  POST /agent/cloudflared/start start `cloudflared tunnel run` (needs
                                TUNNEL_TOKEN in the environment)
  POST /agent/cloudflared/stop  stop cloudflared
  POST /agent/apache/start      start Apache httpd (source build, :8081)
  POST /agent/apache/stop       stop Apache httpd
  POST /agent/code/run          run one coding instruction through Muse
                                Code, driven by its Python SDK over the
                                Muse Session Protocol. JSON body:
                                {"instruction": "...", "workspace": "..."
                                (optional)}. Spawns a fresh `muse serve`
                                host per request, sends one turn, and
                                returns the agent's messages. Auth inside
                                the container is META_API_KEY (forwarded by
                                the Worker); the session runs under the
                                MUSE_CODE_PERMISSION_PROFILE permission
                                profile (default ":unrestricted": no
                                sandbox or approval prompts — this route
                                is only reachable through the Worker's
                                HMAC-gated control API).

The kernel artifact status reports the bzImage baked into the image
(presence, size, SHA-256 vs SHA256SUMS, config path, QEMU version).

tailscaled runs with --tun=userspace-networking: Cloudflare Containers do
not provide /dev/net/tun, so kernel-mode WireGuard is unavailable and only
outbound / proxied traffic through the userspace stack works. State lives
under $HOME so the agent runs unprivileged.
"""

import asyncio
import hashlib
import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
TS_STATE = os.path.join(HOME, "tailscaled.state")
TS_SOCK = os.path.join(HOME, "tailscaled.sock")
PORT = int(os.environ.get("AGENT_PORT", "8080"))
KERNEL_VERSION = os.environ.get("KERNEL_VERSION", "7.3.1")
KERNEL_DIR = f"/opt/musevm-kernel/{KERNEL_VERSION}"
BZIMAGE = os.path.join(KERNEL_DIR, "bzImage")
CONFIG = os.path.join(KERNEL_DIR, f"config-{KERNEL_VERSION}-minimized")
SUMS = os.path.join(KERNEL_DIR, "SHA256SUMS")
BOOT_TEST_TIMEOUT = 90

procs = {"tailscaled": None, "cloudflared": None, "apache": None}

HTTPD = "/usr/local/apache2/bin/httpd"
APACHE_PORT = 8081


def run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except Exception as e:  # noqa: BLE001 - report anything to the caller
        return -1, str(e)


def alive(name):
    p = procs[name]
    return p is not None and p.poll() is None


def stop(name):
    p = procs[name]
    if p is None or p.poll() is not None:
        procs[name] = None
        return {"stopped": False, "reason": "not running"}
    p.terminate()
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()
    procs[name] = None
    return {"stopped": True}


# --- tailscale ---------------------------------------------------------------

def tailscale_status():
    rc, ver = run(["tailscale", "version"])
    version = ver.splitlines()[0] if ver else None
    if not alive("tailscaled"):
        return {"daemon": "stopped", "version": version,
                "token_configured": bool(os.environ.get("TS_AUTHKEY"))}
    rc, out = run(["tailscale", "--socket", TS_SOCK, "status", "--json"])
    if rc != 0:
        return {"daemon": "running", "version": version, "error": out}
    try:
        st = json.loads(out)
    except ValueError:
        return {"daemon": "running", "version": version, "unparsed": out}
    self_ = st.get("Self") or {}
    return {
        "daemon": "running",
        "version": version,
        "backend_state": st.get("BackendState"),
        "host": self_.get("HostName"),
        "dns_name": self_.get("DNSName"),
        "tailscale_ips": self_.get("TailscaleIPs"),
        "health": st.get("Health"),
        "token_configured": bool(os.environ.get("TS_AUTHKEY")),
    }


def tailscale_start():
    if alive("tailscaled"):
        return {"started": False, "reason": "already running"}
    procs["tailscaled"] = subprocess.Popen(
        ["tailscaled", "--tun=userspace-networking",
         f"--state={TS_STATE}", f"--socket={TS_SOCK}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    key = os.environ.get("TS_AUTHKEY")
    if key:
        hostname = os.environ.get("TS_HOSTNAME") or "musevm-kernel"
        args = ["tailscale", "--socket", TS_SOCK, "up",
                f"--auth-key={key}", f"--hostname={hostname}",
                "--accept-routes=false"]
        server = os.environ.get("TS_LOGIN_SERVER")
        if server:
            args.append(f"--login-server={server}")
        rc, out = run(args, timeout=30)
        return {"started": True, "up_rc": rc, "up_output": out}
    return {"started": True, "up": "skipped: TS_AUTHKEY not set"}


# --- cloudflared ---------------------------------------------------------------

def cloudflared_status():
    rc, ver = run(["cloudflared", "--version"])
    return {
        "process": "running" if alive("cloudflared") else "stopped",
        "version": ver.splitlines()[0] if ver else None,
        "token_configured": bool(os.environ.get("TUNNEL_TOKEN")),
    }


def cloudflared_start():
    if alive("cloudflared"):
        return {"started": False, "reason": "already running"}
    token = os.environ.get("TUNNEL_TOKEN")
    if not token:
        return {"started": False, "reason": "TUNNEL_TOKEN not set"}
    procs["cloudflared"] = subprocess.Popen(
        ["cloudflared", "tunnel", "run", "--token", token],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return {"started": True}


# --- Apache httpd ---------------------------------------------------------------

def apache_status():
    rc, ver = run([HTTPD, "-v"])
    hostname = os.environ.get("APACHE_TUNNEL_HOSTNAME")
    if os.environ.get("TUNNEL_TOKEN"):
        mode = "token (ingress assigned in the Cloudflare dashboard)"
    elif os.path.exists(os.path.join(HOME, ".cloudflared", "config.yml")):
        mode = "local config (~/.cloudflared/config.yml)"
    else:
        mode = "unassigned"
    return {
        "process": "running" if alive("apache") else "stopped",
        "version": ver.splitlines()[0] if ver else None,
        "listen": f"http://localhost:{APACHE_PORT}",
        "features": ["cgi (mod_cgid)", "ssi with #exec (Options Includes)"],
        "smoke_tests": ["/test.shtml", "/cgi-bin/test.cgi"],
        "tunnel": {"hostname": hostname, "mode": mode,
                   "service": f"http://localhost:{APACHE_PORT}"},
    }


def apache_start():
    if alive("apache"):
        return {"started": False, "reason": "already running"}
    procs["apache"] = subprocess.Popen(
        [HTTPD, "-DFOREGROUND"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return {"started": True, "listen": f"http://localhost:{APACHE_PORT}"}


# --- Muse Code ---------------------------------------------------------------

CODE_WORKSPACE = os.path.join(HOME, "muse-code-workspace")
CODE_PROFILE = os.environ.get("MUSE_CODE_PERMISSION_PROFILE", ":unrestricted")
CODE_TIMEOUT = int(os.environ.get("MUSE_CODE_TIMEOUT", "1200"))


def muse_code_status():
    rc, ver = run(["muse", "--version"])
    sdk_version = None
    try:
        from importlib import metadata

        sdk_version = metadata.version("muse-code-sdk")
    except Exception:  # noqa: BLE001 - absence is itself the report
        sdk_version = None
    return {
        "version": ver.splitlines()[0] if ver else None,
        "sdk_version": sdk_version,
        "api_key_present": bool(os.environ.get("META_API_KEY")),
        "workspace": CODE_WORKSPACE,
        "permission_profile": CODE_PROFILE,
        "timeout_s": CODE_TIMEOUT,
    }


async def _code_turn(instruction, workspace):
    from muse_code import (
        MuseClient,
        MuseClientSpawnOptions,
        PermissionProfileNotApplied,
        SendUserTurnOptions,
        StartSessionOptions,
    )

    client = await MuseClient.spawn(MuseClientSpawnOptions(
        muse_bin="muse",
        args=["serve"],
        client_info={"name": "muse_code_test_container_agent",
                     "version": "1.0.0"},
    ))
    try:
        # require_permission_profile makes the client prove the profile
        # was applied; a host that does not report the committed selection
        # fails that proof even when the pick was applied (seen with Muse
        # Code 1.4.12), so fall back to an unverified start.
        try:
            session = await client.start_session(StartSessionOptions(
                workspace_root=workspace,
                permission_profile=CODE_PROFILE,
                require_permission_profile=True,
            ))
        except PermissionProfileNotApplied:
            session = await client.start_session(StartSessionOptions(
                workspace_root=workspace,
                permission_profile=CODE_PROFILE,
            ))
        turn = await session.send_user_turn(SendUserTurnOptions(
            input=[{"type": "text", "text": instruction}],
            composer_input=instruction,
        ))

        latest = {}
        order = []

        async def _collect():
            async for item in turn.items():
                iid = item.get("itemId")
                if iid is None:
                    continue
                if iid not in latest:
                    order.append(iid)
                latest[iid] = item

        collect = asyncio.create_task(_collect())
        try:
            outcome = await asyncio.wait_for(turn.completed,
                                             timeout=CODE_TIMEOUT)
        except asyncio.TimeoutError:
            collect.cancel()
            return {"ran": False,
                    "reason": f"turn did not finish within {CODE_TIMEOUT}s",
                    "session_id": session.session_id}
        try:
            await asyncio.wait_for(collect, timeout=5)
        except Exception:  # noqa: BLE001 - outcome already settled the turn
            collect.cancel()

        messages = []
        kinds = {}
        for iid in order:
            item = latest[iid]
            kind = item.get("kind")
            kinds[kind] = kinds.get(kind, 0) + 1
            if kind == "agentMessage" and item.get("status") == "completed":
                text = item.get("message")
                if text:
                    messages.append(text)
        result = {
            "ran": True,
            "session_id": session.session_id,
            "outcome": getattr(outcome, "kind", None),
            "items": kinds,
            "output": "\n\n".join(messages),
        }
        params = getattr(outcome, "params", None)
        if isinstance(params, dict):
            result["terminal"] = params.get("terminal")
            if params.get("error"):
                result["error"] = params["error"]
        return result
    finally:
        await client.close()


def code_run(payload):
    instruction = (payload or {}).get("instruction")
    if not isinstance(instruction, str) or not instruction.strip():
        return {"ran": False,
                "reason": "instruction (non-empty string) is required"}
    workspace = (payload or {}).get("workspace") or CODE_WORKSPACE
    if not os.path.isabs(workspace):
        workspace = os.path.join(HOME, workspace)
    try:
        os.makedirs(workspace, exist_ok=True)
    except OSError as e:
        return {"ran": False, "reason": f"workspace unusable: {e}"}
    started = time.time()
    try:
        result = asyncio.run(_code_turn(instruction.strip(), workspace))
    except Exception as e:  # noqa: BLE001 - report anything to the caller
        return {"ran": False, "reason": f"{type(e).__name__}: {e}",
                "workspace": workspace}
    result["duration_s"] = round(time.time() - started, 1)
    result["workspace"] = workspace
    result["permission_profile"] = CODE_PROFILE
    result["api_key_present"] = bool(os.environ.get("META_API_KEY"))
    return result


# --- kernel artifact ---------------------------------------------------------------

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def kernel_status():
    st = {"version": KERNEL_VERSION, "dir": KERNEL_DIR,
          "config": CONFIG if os.path.exists(CONFIG) else None}
    if not os.path.exists(BZIMAGE):
        st["bzImage"] = None
        return st
    expected = None
    try:
        with open(SUMS) as f:
            for line in f:
                parts = line.split()
                if len(parts) == 2 and parts[1].endswith("bzImage"):
                    expected = parts[0]
    except OSError:
        pass
    actual = sha256_of(BZIMAGE)
    rc, qver = run(["qemu-system-x86_64", "--version"])
    st["bzImage"] = {
        "path": BZIMAGE,
        "size_bytes": os.path.getsize(BZIMAGE),
        "sha256_expected": expected,
        "sha256_actual": actual,
        "sha256_ok": (expected == actual) if expected else None,
    }
    st["qemu_version"] = qver.splitlines()[0] if qver else None
    return st


def boot_test():
    if not os.path.exists(BZIMAGE):
        return {"ran": False, "reason": "bzImage not present in image"}
    cmd = ["qemu-system-x86_64",
           "-machine", "accel=tcg", "-m", "512",
           "-kernel", BZIMAGE,
           "-append", "console=ttyS0 panic=-1",
           "-nographic", "-no-reboot", "-display", "none"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=BOOT_TEST_TIMEOUT)
        out, timed_out = r.stdout + r.stderr, False
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"").decode(errors="replace")
               + (e.stderr or b"").decode(errors="replace"))
        timed_out = True
    banner = f"Linux version {KERNEL_VERSION}" in out
    vfs_panic = "VFS: Unable to mount root fs" in out or "end Kernel panic" in out
    if vfs_panic:
        verdict = ("booted: kernel initialized and reached the root-filesystem "
                   "mount, which panics as expected (no rootfs in image)")
    elif banner:
        verdict = "partial: kernel banner seen, root-mount point not reached"
    else:
        verdict = "failed: kernel banner not seen"
    return {"ran": True, "timed_out": timed_out, "banner_seen": banner,
            "reached_root_mount": vfs_panic, "verdict": verdict,
            "output_tail": out[-2000:]}


# --- system ---------------------------------------------------------------

def system_status():
    import shutil

    up = None
    try:
        with open("/proc/uptime") as f:
            secs = float(f.read().split()[0])
        d, rem = divmod(int(secs), 86400)
        h, rem = divmod(rem, 3600)
        m, _ = divmod(rem, 60)
        up = {"seconds": int(secs), "human": f"{d}d {h}h {m}m" if d else f"{h}h {m}m"}
    except OSError:
        pass
    load = None
    try:
        with open("/proc/loadavg") as f:
            p = f.read().split()
        load = {"1m": float(p[0]), "5m": float(p[1]), "15m": float(p[2])}
    except OSError:
        pass
    mem = None
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                info[k.strip()] = int(v.split()[0])  # kB
        mem = {
            "total_mb": info.get("MemTotal", 0) // 1024,
            "available_mb": info.get("MemAvailable", 0) // 1024,
            "free_mb": info.get("MemFree", 0) // 1024,
            "swap_total_mb": info.get("SwapTotal", 0) // 1024,
            "swap_free_mb": info.get("SwapFree", 0) // 1024,
        }
    except OSError:
        pass
    disk = None
    try:
        u = shutil.disk_usage("/")
        disk = {"total_gb": round(u.total / 2**30, 2),
                "used_gb": round(u.used / 2**30, 2),
                "free_gb": round(u.free / 2**30, 2),
                "mount": "/"}
    except OSError:
        pass
    return {"uptime": up, "loadavg": load, "memory": mem, "disk_root": disk}


ROUTES = {
    ("POST", "/agent/tailscale/start"): lambda: tailscale_start(),
    ("POST", "/agent/tailscale/stop"): lambda: stop("tailscaled"),
    ("POST", "/agent/cloudflared/start"): lambda: cloudflared_start(),
    ("POST", "/agent/cloudflared/stop"): lambda: stop("cloudflared"),
    ("POST", "/agent/apache/start"): lambda: apache_start(),
    ("POST", "/agent/apache/stop"): lambda: stop("apache"),
    ("POST", "/agent/kernel/boot-test"): lambda: boot_test(),
}


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/agent/status":
            self._json({"agent": "ok", "system": system_status(),
                        "env_present": {k: bool(os.environ.get(k)) for k in (
                            "TS_AUTHKEY", "TS_HOSTNAME", "TS_LOGIN_SERVER",
                            "TUNNEL_TOKEN", "APACHE_TUNNEL_HOSTNAME",
                            "META_API_KEY")},
                        "tailscale": tailscale_status(),
                        "cloudflared": cloudflared_status(),
                        "apache": apache_status(),
                        "muse_code": muse_code_status(),
                        "kernel": kernel_status()})
        elif self.path == "/":
            self._json({"agent": "ok",
                        "hint": "control UI lives on the Worker at /cf-containers"})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/agent/code/run":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                payload = json.loads(raw or b"{}")
            except ValueError:
                self._json({"error": "invalid JSON body"}, 400)
                return
            self._json(code_run(payload))
            return
        fn = ROUTES.get(("POST", self.path))
        if fn is None:
            self._json({"error": "not found"}, 404)
            return
        self._json(fn())

    def log_message(self, *args):  # keep stdout quiet
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
