// muse-code-test-n — ultra-light Worker.
// No container, no agent, no secrets. Muse execution is consolidated
// in muse-code-wasm (receiver on muse-vm). This Worker answers health
// checks and identifies itself; everything else is a 404.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", worker: "muse-code-test-n" });
    }
    if (url.pathname === "/") {
      return new Response(
        "muse-code-test-n: ultra-light worker (no container). " +
          "Muse execution is handled by muse-code-wasm (receiver on muse-vm). " +
          "GET /health for status.\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
