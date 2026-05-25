# Sandbox runtime image used by the local-dev sandbox provider.
#
# Mirrors packages/modal-infra/src/images/base.py with one deliberate
# difference: this image is multi-arch (amd64 + arm64) because contributors
# may run on Apple Silicon or aarch64 Linux. The Modal production image is
# x86_64-only.

FROM python:3.12-slim

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

# System packages — match base.py.apt_install() exactly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      build-essential \
      ca-certificates \
      gnupg \
      openssh-client \
      jq \
      unzip \
      ffmpeg \
      libnss3 \
      libnspr4 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
      libpango-1.0-0 \
      libcairo2 \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI via the official keyring (mirrors base.py).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS via NodeSource. NodeSource ships both amd64 and arm64.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && node --version && npm --version

# pnpm globally + Bun (Bun's installer auto-detects arch).
RUN npm install -g pnpm@latest \
  && pnpm --version \
  && curl -fsSL https://bun.sh/install | bash \
  && echo 'export BUN_INSTALL="$HOME/.bun"' >> /etc/profile.d/bun.sh \
  && echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /etc/profile.d/bun.sh

# Python tools — match base.py.pip_install() exactly.
RUN pip install --no-cache-dir \
      uv \
      httpx \
      websockets \
      'pydantic>=2.0' \
      'PyJWT[crypto]'

# OpenCode CLI + plugin. Versions pinned via the same constants base.py uses
# (#567 — opencode 1.14.42+ broke the bridge's SSE replay).
ARG OPENCODE_VERSION=1.14.41
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
  && opencode --version || echo 'OpenCode installed' \
  && npm install -g @opencode-ai/plugin@${OPENCODE_VERSION} zod

# Pre-stage opencode plugin deps so the first prompt doesn't pay arborist
# reify() cost (#567).
RUN mkdir -p /app/opencode-deps \
  && printf '{"name":"opencode-tools","type":"module","dependencies":{"@opencode-ai/plugin":"%s"}}\n' "${OPENCODE_VERSION}" \
      > /app/opencode-deps/package.json \
  && cd /app/opencode-deps && npm install --ignore-scripts --no-audit --no-fund

# code-server: arch-aware .deb from GitHub releases.
ARG CODE_SERVER_VERSION=4.109.5
RUN CS_ARCH=$(if [ "$TARGETARCH" = "arm64" ]; then echo arm64; else echo amd64; fi) \
  && curl -fsSL -o /tmp/code-server.deb \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_${CS_ARCH}.deb" \
  && dpkg -i /tmp/code-server.deb \
  && rm /tmp/code-server.deb \
  && code-server --version

# ttyd: arch-aware binary from GitHub releases. SHA256 verification is skipped
# here (base.py pins the x86_64 hash only); contributors building locally trust
# their own GitHub release fetch over TLS.
ARG TTYD_VERSION=1.7.7
RUN TTYD_VARIANT=$(if [ "$TARGETARCH" = "arm64" ]; then echo aarch64; else echo x86_64; fi) \
  && curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TTYD_VARIANT}" \
  && chmod +x /usr/local/bin/ttyd \
  && ttyd --version

# agent-browser CLI + Chromium. Chrome for Testing has no Linux arm64 build,
# so on arm64 we install Debian's system chromium and let runtime callers
# point agent-browser at /usr/bin/chromium via PUPPETEER_EXECUTABLE_PATH.
# On amd64, `agent-browser install` downloads Chrome for Testing as usual.
ARG AGENT_BROWSER_VERSION=0.21.2
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
  && if [ "$TARGETARCH" = "arm64" ]; then \
       apt-get update \
       && apt-get install -y --no-install-recommends chromium \
       && rm -rf /var/lib/apt/lists/* \
       && agent-browser --version; \
     else \
       agent-browser install \
       && agent-browser --version; \
     fi

# Working dirs.
RUN mkdir -p /workspace /app/plugins /tmp/opencode

# Match base.py's .env() block.
ENV HOME=/root \
    NODE_ENV=development \
    PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.bun/bin:/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin \
    PYTHONPATH=/app \
    NODE_PATH=/usr/lib/node_modules

# Sandbox runtime code. Build context expected at the package root
# (packages/sandbox-runtime), so src/ is relative.
COPY src/sandbox_runtime/ /app/sandbox_runtime/

ENTRYPOINT ["python", "-m", "sandbox_runtime.entrypoint"]
