# musevm-kernel container image: the minimized kernel artifact plus the
# toolchain and test tooling around it.
#
# The bzImage is stored in this repository as Base64 chunks (the publishing
# path is text-only). Stage 1 reassembles it and verifies SHA256SUMS; the
# final image carries only the verified bzImage and its .config, not the
# chunks.
#
# Related packages, and why they are here:
#   kernel build (Documentation/process/changes.rst): build-essential,
#     flex, bison, bc, gawk, perl, libelf-dev, libssl-dev, dwarves (pahole),
#     cpio, xz-utils, zstd, kmod, rsync, libncurses-dev (menuconfig)
#     — gawk and zstd are easy to miss: kbuild needs gawk for
#       modules.builtin.ranges and the zstd CLI for CONFIG_KERNEL_ZSTD.
#   boot test: qemu-system-x86 runs the bzImage under TCG emulation
#     (no KVM in this environment) for a serial-console smoke test.
#   daemons (same set and pins as the musevm image, agent-managed):
#     tailscale/tailscaled 1.104.5 (static tarball), cloudflared 2026.10.7
#     (pinned binary), Apache httpd 2.4.69 built from source on :8081
#     with CGI/SSI smoke tests — the agent reports their state and
#     start/stop from the /cf-containers page.
#   runtime: python3 runs the container agent; procps/psmisc/less are the
#     minimal inspection userland; curl/git/ca-certificates fetch sources.
#   muse code (this fork, muse-code-test): Meta's terminal coding agent,
#     installed with the official one-line installer, plus its Python SDK
#     (muse-code-sdk, version-locked to the CLI) so the container agent
#     can take coding instructions from the Worker and run them headlessly
#     over the Muse Session Protocol. The native binary is ~415 MB.
#
# Nothing here boots the kernel as the host kernel — Cloudflare Containers
# always run on Cloudflare's kernel. The bzImage is cargo + test subject.

FROM debian:trixie-slim AS artifact
ARG KERNEL_VERSION=7.3.1
COPY ${KERNEL_VERSION}/ /artifact/
RUN cd /artifact \
    && cat bzImage.b64.part-* | base64 -d > bzImage \
    && sha256sum -c SHA256SUMS \
    && rm bzImage.b64.part-*

FROM debian:trixie-slim
ARG KERNEL_VERSION=7.3.1
ENV DEBIAN_FRONTEND=noninteractive
ENV KERNEL_VERSION=${KERNEL_VERSION}

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        flex bison bc gawk perl \
        libelf-dev libssl-dev dwarves \
        cpio xz-utils zstd kmod rsync \
        libncurses-dev \
        libapr1-dev libaprutil1-dev libpcre2-dev zlib1g-dev \
        qemu-system-x86 \
        procps psmisc less vim-tiny python3 python3-pip \
        ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# Verified kernel artifact: /opt/musevm-kernel/<version>/{bzImage,config-*,SHA256SUMS}
COPY --from=artifact /artifact/ /opt/musevm-kernel/${KERNEL_VERSION}/

# --- Tunnel / mesh clients --------------------------------------------------
# Same pins as the musevm image. cloudflared: outbound-only tunnel
# connector. tailscale: static tarball (tailscale CLI + tailscaled),
# pinned at 1.104.5 — above the 1.104.4 floor that fixed the Tailworm
# SSH-forwarding issues (TS-2026-014..017). In containers without
# /dev/net/tun, tailscaled needs --tun=userspace-networking; it cannot
# offer inbound or subnet routing there.
ARG CLOUDFLARED_VERSION=2026.10.7
ARG TAILSCALE_VERSION=1.104.5
RUN curl -fsSL -o /usr/local/bin/cloudflared \
        "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    && chmod +x /usr/local/bin/cloudflared \
    && curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" \
        | tar -xz -C /usr/local/bin --strip-components=1 \
            "tailscale_${TAILSCALE_VERSION}_amd64/tailscale" \
            "tailscale_${TAILSCALE_VERSION}_amd64/tailscaled"

# --- Apache httpd, built from source -----------------------------------------
# Same version and official SHA-512 pin as the musevm image. Built against
# the system APR/PCRE. Listens on 8081 (unprivileged; the agent owns 8080)
# and is the service the cloudflared tunnel assignment points at:
#   <APACHE_TUNNEL_HOSTNAME> -> http://localhost:8081
ARG HTTPD_VERSION=2.4.70
ARG HTTPD_SHA512=5998908195bd99e719714befbcf328b98012625c5848e8ca34509e15ad5faff61a4c7575cccc43dae3c79f6a66bb89b7ed67d730e65ca9dabf5f6b8c33fbcf09
RUN curl -fsSL -o /tmp/httpd.tar.gz \
        "https://downloads.apache.org/httpd/httpd-${HTTPD_VERSION}.tar.gz" \
    && echo "${HTTPD_SHA512}  /tmp/httpd.tar.gz" | sha512sum -c - \
    && tar -xzf /tmp/httpd.tar.gz -C /tmp \
    && cd "/tmp/httpd-${HTTPD_VERSION}" \
    && ./configure --prefix=/usr/local/apache2 \
         --with-apr=/usr --with-apr-util=/usr --with-pcre=/usr/bin/pcre2-config \
         --enable-so --enable-ssl --enable-rewrite --enable-headers \
         --enable-proxy --enable-proxy-http \
         --enable-cgi --enable-cgid --enable-include \
    && make -j"$(nproc)" \
    && make install \
    && sed -i \
         -e 's/^Listen 80$/Listen 8081/' \
         -e 's/^#ServerName www.example.com:80/ServerName localhost/' \
         -e 's/Options Indexes FollowSymLinks/Options Indexes FollowSymLinks Includes/' \
         -e 's/Options None/Options ExecCGI/' \
         -e 's/^#AddHandler cgi-script .cgi/AddHandler cgi-script .cgi .pl/' \
         -e 's/^#AddType text\/html .shtml/AddType text\/html .shtml/' \
         -e 's/^#AddOutputFilter INCLUDES .shtml/AddOutputFilter INCLUDES .shtml/' \
         /usr/local/apache2/conf/httpd.conf \
    && grep -q '^LoadModule cgid_module' /usr/local/apache2/conf/httpd.conf \
       || echo 'LoadModule cgid_module modules/mod_cgid.so' >> /usr/local/apache2/conf/httpd.conf \
    && grep -q '^LoadModule include_module' /usr/local/apache2/conf/httpd.conf \
       || echo 'LoadModule include_module modules/mod_include.so' >> /usr/local/apache2/conf/httpd.conf \
    && rm -rf /tmp/httpd.tar.gz "/tmp/httpd-${HTTPD_VERSION}"

# CGI / SSI smoke tests: /test.shtml exercises SSI #exec, /cgi-bin/test.cgi
# exercises CGI. SSI exec works because htdocs has `Options Includes`
# (not IncludesNOEXEC); CGI works via ScriptAlias + `Options ExecCGI`.
COPY web/test.shtml /usr/local/apache2/htdocs/test.shtml
COPY --chmod=755 web/test.cgi /usr/local/apache2/cgi-bin/test.cgi

# Container agent: the long-running process for Cloudflare Containers.
# Serves the status/control API on 8080 that the Worker's /cf-containers
# page talks to (kernel artifact status, QEMU boot smoke test, the three
# daemons' state and start/stop, system).
COPY --chmod=755 container-agent.py /usr/local/bin/container-agent.py

# --- Muse Code ---------------------------------------------------------------
# Official installer; MUSE_INSTALL_DIR puts the launcher and the native
# binary (~415 MB at 1.4.14) in /usr/local/bin so the unprivileged agent
# user can run them. The Python SDK releases in lockstep with the CLI
# (muse-code-sdk X.Y.Z pairs with Muse Code X.Y.Z), so the SDK version
# is read back from the CLI that was just installed rather than pinned
# here by hand. Runtime auth is the META_API_KEY environment variable,
# forwarded by the Worker (see src/index.ts envVars); without it, turns
# fail at the host and the agent reports api_key_present=false.
RUN curl -fsSL https://dev.meta.ai/install.sh | MUSE_INSTALL_DIR=/usr/local/bin bash \
    && pip install --break-system-packages --no-cache-dir \
        "muse-code-sdk==$(muse --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)" \
    && muse --version

RUN useradd -m -s /bin/bash builder
USER builder
WORKDIR /src

CMD ["/usr/local/bin/container-agent.py"]
