import { Container, getContainer } from "@cloudflare/containers";

// Lifecycle model (Cloudflare Containers): nothing runs until a request
// arrives; the Worker starts an instance on demand, the instance sleeps
// after `sleepAfter` of inactivity. /cf-containers is the control surface:
//
//   GET  /cf-containers                 control page (lifecycle + kernel)
//   POST /cf-containers/start|stop|restart|status
//                                       container instance lifecycle
//   POST /cf-containers/code            coding instruction, forwarded to
//                                       agent/code/run (see below)
//   *    /cf-containers/agent/<path>    proxied to the in-container agent
//                                       (container-agent.py on port 8080):
//     GET  agent/status                 system + kernel artifact status,
//                                       tailscale / cloudflared / apache /
//                                       muse_code
//     POST agent/kernel/boot-test       QEMU boot smoke test of the bzImage
//     POST agent/tailscale/start|stop   tailscaled (userspace networking)
//     POST agent/cloudflared/start|stop cloudflared tunnel run
//     POST agent/apache/start|stop      Apache httpd (source build, :8081)
//     POST agent/code/run               one coding instruction, run by
//                                       Muse Code through its Python
//                                       SDK (Muse Session Protocol)
//
// This fork (muse-code-test) adds Muse Code to the musevm-kernel image:
// the Worker takes a coding instruction at POST /cf-containers/code and
// the in-container agent runs it headlessly on Muse Code, returning the
// agent's messages as JSON. Muse Code auth inside the container is the
// META_API_KEY secret, forwarded via KernelContainer.envVars below.
//
// The image carries the minimized kernel artifact (bzImage + its .config,
// reassembled and SHA-256-verified at image build time) plus the kernel
// build toolchain and QEMU. The container never boots that kernel as its
// host kernel; the bzImage is cargo and test subject.
//
// Access control: if the CONTROL_TOKEN secret is set (wrangler secret put
// CONTROL_TOKEN), it acts as an HMAC-SHA256 key: every control API request
// must carry X-Timestamp and X-Signature = HMAC(key, "<METHOD>\n<path>\n
// <timestamp>"), verified with crypto.subtle.verify; timestamps more than
// 300 s off are rejected. The secret itself is never sent. Without it the
// page is open to anyone who knows the URL — put the Worker behind
// Cloudflare Access before using this beyond experiments.
export class KernelContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";

  // Forward an allowlist of Worker env entries (vars and secrets) into the
  // container process environment. Without this, values set with
  // `wrangler secret put` / [vars] never reach the agent inside the
  // container, and tailscaled / cloudflared stay unconfigured.
  // Secrets are forwarded as values only; they are never logged here.
  //
  // This is assigned in the constructor, NOT via a `get envVars()`
  // accessor: in @cloudflare/containers the base class declares
  // `envVars = {}` as a class field, whose initializer defines an own
  // property on the instance and permanently shadows a subclass getter —
  // a getter here would silently always yield {} (verified against
  // 0.3.7). A plain assignment after super() replaces that {}.
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const out: Record<string, string> = {};
    for (const k of [
      "TS_AUTHKEY",
      "TS_HOSTNAME",
      "TS_LOGIN_SERVER",
      "TUNNEL_TOKEN",
      "APACHE_TUNNEL_HOSTNAME",
      "META_API_KEY",
    ] as const) {
      const v = env[k];
      if (v) out[k] = v;
    }
    this.envVars = out;
  }

  async startContainer() {
    await this.start();
    return this.getState();
  }

  async stopContainer() {
    await this.stop();
    let state = await this.getState();
    if (state.status !== "stopped") {
      // stop() signals the entrypoint and waits for a graceful exit; an
      // instance whose processes linger can stay "healthy" indefinitely.
      // Escalate to destroy(), which force-terminates the instance.
      await this.destroy();
      state = await this.getState();
    }
    return state;
  }

  async restartContainer() {
    await this.stop();
    const state = await this.getState();
    if (state.status !== "stopped") {
      await this.destroy();
    }
    await this.start();
    return this.getState();
  }

  async containerState() {
    return this.getState();
  }
}

interface Env {
  KERNEL_CONTAINER: DurableObjectNamespace<KernelContainer>;
  CONTROL_TOKEN?: string;
  // Forwarded into the container (see KernelContainer.envVars):
  TS_AUTHKEY?: string;
  TS_HOSTNAME?: string;
  TS_LOGIN_SERVER?: string;
  TUNNEL_TOKEN?: string;
  APACHE_TUNNEL_HOSTNAME?: string;
  // Muse Code auth inside the container (agent/code/run):
  META_API_KEY?: string;
}

const INSTANCE = "main";

const CONTROL_PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cf-containers — muse-code-test</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 44rem; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  .row { display: flex; gap: 0.5rem; margin: 0.75rem 0; flex-wrap: wrap; }
  button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-green { background: transparent; border: 2px solid #1a7f37; color: #1a7f37; font-weight: 600; }
  .btn-yellow { background: transparent; border: 2px solid #bf8700; color: #9a6700; font-weight: 600; }
  .btn-fill-green { background: #b7ebc0; border: 2px solid #1a7f37; color: #14532d; font-weight: 600; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 10; }
  .modal-overlay[hidden] { display: none; }
  .modal-box { background: #fff; color: #111; padding: 1.25rem 1.5rem; border-radius: 8px; max-width: 24rem; width: calc(100% - 3rem); }
  @media (prefers-color-scheme: dark) { .modal-box { background: #1c1c1e; color: #eee; } }
  pre { background: #8882; padding: 1rem; overflow-x: auto; min-height: 3.5rem; white-space: pre-wrap; }
  input { width: 100%; padding: 0.4rem; margin-top: 0.25rem; }
  label { font-size: 0.85rem; opacity: 0.8; }
  .note { font-size: 0.85rem; opacity: 0.75; }
</style>
</head>
<body>
<h1>cf-containers — muse-code-test</h1>

<h2>HTTPS ヘルスチェック</h2>
<p class="note">このページと同じオリジンの /health を HTTPS で叩き、ステータスと応答時間を表示する。</p>
<div class="row">
  <button id="hc-btn">再チェック</button>
</div>
<pre id="out-hc">…</pre>

<h2>コンテナ本体</h2>
<div class="row">
  <button id="btn-start" data-confirm="コンテナを起動" data-call="POST /cf-containers/start #out-main">起動</button>
  <button id="btn-stop" data-confirm="コンテナを停止" data-call="POST /cf-containers/stop #out-main">停止</button>
  <button id="btn-restart" data-confirm="コンテナを再起動" data-call="POST /cf-containers/restart #out-main">再起動</button>
  <button data-call="POST /cf-containers/status #out-main">状態を更新</button>
</div>
<pre id="out-main">…</pre>

<h2>Tailscale</h2>
<p class="note">tailscaled は userspace-networking モード（この環境には /dev/net/tun がないため）。接続にはコンテナ側の環境変数 TS_AUTHKEY が必要。</p>
<div class="row">
  <button data-call="GET /cf-containers/agent/status #out-ts">状態を取得</button>
  <button id="btn-ts-start" data-confirm="tailscaled を起動" data-call="POST /cf-containers/agent/tailscale/start #out-ts">tailscaled 起動</button>
  <button id="btn-ts-stop" data-confirm="tailscaled を停止" data-call="POST /cf-containers/agent/tailscale/stop #out-ts">tailscaled 停止</button>
</div>
<pre id="out-ts">…</pre>

<h2>Cloudflared トンネル</h2>
<p class="note">起動にはコンテナ側の環境変数 TUNNEL_TOKEN が必要（cloudflared tunnel run --token）。</p>
<div class="row">
  <button data-call="GET /cf-containers/agent/status #out-cf">状態を取得</button>
  <button id="btn-cf-start" data-confirm="cloudflared を起動" data-call="POST /cf-containers/agent/cloudflared/start #out-cf">cloudflared 起動</button>
  <button id="btn-cf-stop" data-confirm="cloudflared を停止" data-call="POST /cf-containers/agent/cloudflared/stop #out-cf">cloudflared 停止</button>
</div>
<pre id="out-cf">…</pre>

<h2>Apache httpd</h2>
<p class="note">Apache は localhost:8081 で待ち受け、トンネルの公開ホスト名（APACHE_TUNNEL_HOSTNAME）はそこへ割り当てる。トークン方式の場合はダッシュボード側で同じ割り当てを行う。CGI と SSI（#exec 可）が有効で、確認用に /test.shtml と /cgi-bin/test.cgi が入っている。</p>
<div class="row">
  <button data-call="GET /cf-containers/agent/status #out-ap">状態を取得</button>
  <button id="btn-ap-start" data-confirm="Apache を起動" data-call="POST /cf-containers/agent/apache/start #out-ap">Apache 起動</button>
  <button id="btn-ap-stop" data-confirm="Apache を停止" data-call="POST /cf-containers/agent/apache/stop #out-ap">Apache 停止</button>
</div>
<pre id="out-ap">…</pre>

<h2>Muse Code</h2>
<p class="note">コンテナ内の Muse Code にコーディング指示を1件実行させる（Python SDK 経由、Muse Session Protocol）。認証はコンテナ側の環境変数 META_API_KEY が必要。作業ディレクトリは既定で ~/muse-code-workspace、権限プロファイルは :unrestricted（サンドボックスと承認プロンプトなし）。状態表示は /agent/status の muse_code 節。</p>
<div class="row">
  <button data-call="GET /cf-containers/agent/status #out-code">状態を取得</button>
</div>
<pre id="out-code">…</pre>
<label>指示（instruction）
  <textarea id="code-input" rows="4" style="width: 100%; padding: 0.4rem; margin-top: 0.25rem;"></textarea>
</label>
<div class="row">
  <button id="btn-code-run">指示を実行</button>
</div>
<pre id="out-code-run">…</pre>

<h2>カーネル成果物</h2>
<p class="note">イメージに組み込まれた最小化カーネル（bzImage）の状態。サイズと SHA-256（SHA256SUMS との照合結果）を表示する。</p>
<div class="row">
  <button data-call="GET /cf-containers/agent/status #out-kernel">状態を取得</button>
</div>
<pre id="out-kernel">…</pre>

<h2>ブートテスト（QEMU）</h2>
<p class="note">bzImage を QEMU（TCG エミュレーション）で起動し、シリアル出力を確認する。イメージ内にルートファイルシステムは無いため、正常なカーネルは VFS のルートマウントで panic して止まる。その panic に到達することが成功の目印（最大90秒）。</p>
<div class="row">
  <button data-confirm="ブートテストを実行" data-call="POST /cf-containers/agent/kernel/boot-test #out-boot">ブートテストを実行</button>
</div>
<pre id="out-boot">…</pre>

<h2>システム（コンテナ内）</h2>
<p class="note">uptime・ロードアベレージ・メモリ（free相当）・ディスク（df相当、ルートFS）。</p>
<div class="row">
  <button data-call="GET /cf-containers/agent/status #out-sys">状態を取得</button>
</div>
<pre id="out-sys">…</pre>

<div id="modal" class="modal-overlay" hidden>
  <div class="modal-box">
    <p id="modal-msg"></p>
    <div class="row">
      <button id="modal-yes">はい</button>
      <button id="modal-no">いいえ</button>
    </div>
  </div>
</div>

<label>CONTROL_TOKEN（署名鍵・ブラウザ内でのみ使用し、送信されません）
  <input id="token" type="password" autocomplete="off">
</label>

<script>
  async function authHeaders(method, path) {
    const secret = document.getElementById('token').value;
    if (!secret) return {};
    const ts = String(Math.floor(Date.now() / 1000));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(method + '\\n' + path + '\\n' + ts));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { 'X-Timestamp': ts, 'X-Signature': hex };
  }
  async function call(spec) {
    const [method, path, outSel] = spec.split(' ');
    const out = document.querySelector(outSel);
    const headers = await authHeaders(method, path);
    out.textContent = method + ' ' + path + ' …';
    try {
      const res = await fetch(path, { method, headers });
      out.textContent = 'HTTP ' + res.status + '\\n' + await res.text();
    } catch (e) {
      out.textContent = String(e);
    }
  }
  function confirmModal(label) {
    return new Promise((resolve) => {
      const modal = document.getElementById('modal');
      document.getElementById('modal-msg').textContent = label + 'しますか？';
      modal.hidden = false;
      const yes = document.getElementById('modal-yes');
      const no = document.getElementById('modal-no');
      const cleanup = () => {
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
      };
      const onYes = () => { modal.hidden = true; cleanup(); resolve(true); };
      const onNo = () => { modal.hidden = true; cleanup(); resolve(false); };
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
    });
  }
  function setPair(start, stop, status) {
    if (!start || !stop) return;
    start.classList.remove('btn-green', 'btn-fill-green');
    stop.classList.remove('btn-yellow');
    start.disabled = false; stop.disabled = false;
    if (status === 'running' || status === 'healthy') {
      start.classList.add('btn-fill-green');
      start.disabled = true;
      stop.classList.add('btn-yellow');
    } else if (status === 'stopped') {
      start.classList.add('btn-green');
      stop.disabled = true;
    }
  }
  function applyContainerState(status) {
    const start = document.getElementById('btn-start');
    const stop = document.getElementById('btn-stop');
    const restart = document.getElementById('btn-restart');
    setPair(start, stop, status);
    if (restart) restart.disabled = (status === 'stopped');
  }
  function applyDaemonStates(text) {
    let j;
    try { j = JSON.parse(text.slice(text.indexOf('{'))); } catch (e) { return; }
    if (j.tailscale) setPair(document.getElementById('btn-ts-start'), document.getElementById('btn-ts-stop'), j.tailscale.daemon);
    if (j.cloudflared) setPair(document.getElementById('btn-cf-start'), document.getElementById('btn-cf-stop'), j.cloudflared.process);
    if (j.apache) setPair(document.getElementById('btn-ap-start'), document.getElementById('btn-ap-stop'), j.apache.process);
  }
  async function refreshDaemonStates() {
    const headers = await authHeaders('GET', '/cf-containers/agent/status');
    try {
      const res = await fetch('/cf-containers/agent/status', { headers });
      applyDaemonStates(await res.text());
    } catch (e) {}
  }
  const mainOut = document.getElementById('out-main');
  new MutationObserver(() => {
    const m = /"status"\\s*:\\s*"([a-z_]+)"/.exec(mainOut.textContent || '');
    if (m) applyContainerState(m[1]);
  }).observe(mainOut, { childList: true, characterData: true, subtree: true });
  for (const id of ['out-ts', 'out-cf', 'out-ap']) {
    const el = document.getElementById(id);
    if (el) new MutationObserver(() => applyDaemonStates(el.textContent || '')).observe(el, { childList: true, characterData: true, subtree: true });
  }
  for (const btn of document.querySelectorAll('button[data-call]')) {
    btn.addEventListener('click', async () => {
      const label = btn.dataset.confirm;
      if (label) {
        const ok = await confirmModal(label);
        if (!ok) {
          const outSel = btn.dataset.call.split(' ')[2];
          const out = outSel ? document.querySelector(outSel) : null;
          if (out) out.textContent = 'キャンセルしました';
          return;
        }
      }
      await call(btn.dataset.call);
      if (btn.dataset.call.indexOf('POST /cf-containers/agent/') === 0) refreshDaemonStates();
    });
  }
  async function health() {
    const out = document.getElementById('out-hc');
    const url = location.origin + '/health';
    const t0 = performance.now();
    try {
      const res = await fetch(url);
      const ms = Math.round(performance.now() - t0);
      out.textContent = 'GET ' + url + '\\nHTTP ' + res.status + ' (' + ms + ' ms)\\nbody: ' + (await res.text()).trim();
    } catch (e) {
      out.textContent = 'GET ' + url + '\\nerror: ' + String(e);
    }
  }
  async function runCode() {
    const out = document.getElementById('out-code-run');
    const instruction = document.getElementById('code-input').value.trim();
    if (!instruction) { out.textContent = '指示が空です'; return; }
    const ok = await confirmModal('Muse Code で指示を実行');
    if (!ok) { out.textContent = 'キャンセルしました'; return; }
    const headers = await authHeaders('POST', '/cf-containers/code');
    headers['content-type'] = 'application/json';
    out.textContent = 'POST /cf-containers/code …';
    try {
      const res = await fetch('/cf-containers/code', { method: 'POST', headers, body: JSON.stringify({ instruction }) });
      out.textContent = 'HTTP ' + res.status + '\\n' + await res.text();
    } catch (e) {
      out.textContent = String(e);
    }
  }
  document.getElementById('btn-code-run').addEventListener('click', runCode);
  document.getElementById('hc-btn').addEventListener('click', health);
  health();
  call('POST /cf-containers/status #out-main');
  call('GET /cf-containers/agent/status #out-ts');
  call('GET /cf-containers/agent/status #out-code');
  call('GET /cf-containers/agent/status #out-kernel');
</script>
</body>
</html>
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/cf-containers") {
      return new Response(CONTROL_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname.startsWith("/cf-containers/")) {
      if (env.CONTROL_TOKEN) {
        const ts = request.headers.get("X-Timestamp");
        const sigHex = request.headers.get("X-Signature");
        let ok = false;
        if (ts && sigHex && /^[0-9a-f]{64}$/.test(sigHex)) {
          const now = Math.floor(Date.now() / 1000);
          if (Math.abs(now - Number(ts)) <= 300) {
            const enc = new TextEncoder();
            const key = await crypto.subtle.importKey(
              "raw", enc.encode(env.CONTROL_TOKEN),
              { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
            );
            const sig = new Uint8Array(
              sigHex.match(/../g)!.map((h) => parseInt(h, 16)),
            );
            ok = await crypto.subtle.verify(
              "HMAC", key, sig,
              enc.encode(`${request.method}\n${url.pathname}\n${ts}`),
            );
          }
        }
        if (!ok) {
          return new Response("unauthorized\n", { status: 401 });
        }
      }
      const stub = getContainer(env.KERNEL_CONTAINER, INSTANCE);
      const action = url.pathname.slice("/cf-containers/".length);

      // Coding instruction: POST /cf-containers/code with a JSON body
      // {"instruction": "...", "workspace": "..."?} runs one instruction
      // on the in-container Muse Code via the agent's /agent/code/run.
      // Same stopped-gate as the agent API below: dispatching an
      // instruction must never (re)start an explicitly stopped instance.
      if (action === "code") {
        if (request.method !== "POST") {
          return new Response("method not allowed\n", { status: 405 });
        }
        const st = (await stub.containerState()) as { status?: string } | null;
        if (st && st.status === "stopped") {
          return Response.json(
            { error: "container is stopped", hint: "start it from the container panel first" },
            { status: 503 },
          );
        }
        const target = new URL(request.url);
        target.pathname = "/agent/code/run";
        return stub.fetch(new Request(target.toString(), request));
      }

      // In-container agent API: forward verbatim — but only while the
      // instance is up. Fetching the stub would otherwise (re)start the
      // instance, which silently undoes an explicit stop: the control
      // page's own status refreshes kept waking the container back up.
      // The lifecycle panel is the one place that starts it.
      if (action.startsWith("agent/")) {
        const st = (await stub.containerState()) as { status?: string } | null;
        if (st && st.status === "stopped") {
          return Response.json(
            { error: "container is stopped", hint: "start it from the container panel first" },
            { status: 503 },
          );
        }
        const target = new URL(request.url);
        target.pathname = "/" + action;
        return stub.fetch(new Request(target.toString(), request));
      }

      try {
        let state: unknown;
        switch (action) {
          case "start":
            state = await stub.startContainer();
            break;
          case "stop":
            state = await stub.stopContainer();
            break;
          case "restart":
            state = await stub.restartContainer();
            break;
          case "status":
            state = await stub.containerState();
            break;
          default:
            return new Response("unknown action\n", { status: 404 });
        }
        return Response.json({ action, state });
      } catch (err) {
        return Response.json(
          { action, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    const container = getContainer(env.KERNEL_CONTAINER, INSTANCE);
    return container.fetch(request);
  },
};
