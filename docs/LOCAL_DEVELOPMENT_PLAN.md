# Local Development Plan — Run All Three Layers on a Laptop

**Status:** Approved plan. Not yet implemented. **Owner of execution:** TBD (to be picked up by a
fresh agent). **Original design conversation:** May 2026.

---

## 0. Handoff Context (read this first)

You are picking up an approved plan to make Open-Inspect runnable end-to-end on a developer's
laptop. The user (project maintainer) has already approved the architectural choices below; do
**not** re-litigate them.

### What you need to know about this project before starting

The next two subsections give you the full mental model. Read both before touching code — this
section is self-contained.

---

#### Project primer — the three tiers

Open-Inspect is an open-source background-coding-agent system inspired by Ramp's Inspect.
Single-tenant by design (shared GitHub App, no per-user repo ACL). Repo structure:

```
packages/
  shared/         — TypeScript types shared across CP, web, bots. Build first.
  control-plane/  — Cloudflare Workers + Durable Objects. The brain.
  web/            — Next.js 16 / React 19 dashboard, NextAuth GitHub OAuth.
  slack-bot/      — Hono Worker. Out of scope v1.
  github-bot/     — Hono Worker. Out of scope v1.
  linear-bot/     — Hono Worker. Out of scope v1.
  modal-infra/    — Python. Modal sandbox lifecycle + HTTP API. Production data plane.
  daytona-infra/  — Python scripts for seeding Daytona snapshots.
  sandbox-runtime/— Python. Runs INSIDE the sandbox: supervisor, bridge, tools, skills.
terraform/        — Production deployment (Cloudflare + Modal). Don't touch for v1.
docs/             — User-facing docs.
```

**Tier 1 — Clients.** Web UI is the only v1 client. It hits the control plane via REST for state and
WebSocket for the live session event stream. Authenticated via NextAuth (GitHub OAuth).

**Tier 2 — Control plane** (Cloudflare Workers). Key pieces:

- **Session Durable Object** (one per session,
  `packages/control-plane/src/session/durable-object.ts`, class `SessionDO`). Holds SQLite session
  state (messages, events, artifacts, participants, sandbox metadata). Owns the WebSocket hub
  between sandbox and clients. Drives sandbox lifecycle.
- **Scheduler Durable Object** (cron + automation matching). Required as a binding but not actively
  exercised by v1 flows.
- **D1 database** (cross-session state: session index, repo metadata, encrypted secrets,
  automations, MCP registry, users). 20 migrations under `terraform/d1/migrations/` numbered
  `0001_*.sql` through `0020_*.sql`. Compatible with `wrangler d1 migrations apply`.
- **Routes** under `packages/control-plane/src/routes/`: repos, secrets, automations, MCP servers,
  analytics, etc.
- **Sandbox provider abstraction** under `packages/control-plane/src/sandbox/`. This is the key
  extension seam for v1 (you're adding a third provider).

**Tier 3 — Data plane.** A sandboxed Linux dev environment per session. Production has two backends:

- **Modal** — snapshot/restore semantics. `packages/modal-infra/` exposes HMAC-authed HTTP endpoints
  (`api-create-sandbox`, `api-snapshot-sandbox`, `api-restore-sandbox`, etc.). Control plane calls
  them via `ModalClient`.
- **Daytona** — persistent stop/resume semantics. Control plane calls Daytona's REST API directly
  via `DaytonaRestClient`. **This is the closest model for the Docker provider you're building** —
  both use persistent containers that get stopped on inactivity and resumed, with no filesystem
  snapshots.

Inside each sandbox, several processes run:

- **Supervisor** (`packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py`, PID 1): boots the
  sandbox, runs git sync, runs optional repo hooks (`.openinspect/setup.sh`,
  `.openinspect/start.sh`), starts OpenCode, starts the bridge, monitors restarts.
- **OpenCode** (the coding agent harness): `opencode serve --port 4096` — speaks HTTP + SSE for
  prompt streaming.
- **Bridge** (`packages/sandbox-runtime/src/sandbox_runtime/bridge.py`): WebSocket up to the control
  plane Session DO, HTTP+SSE down to OpenCode. Translates between the two protocols, handles
  ACK/replay for critical events.
- **Sidecars** (optional): code-server (browser VS Code), ttyd + ttyd-proxy (web terminal).

---

#### The two contracts that matter for this work

The whole system holds together via two stable contracts. Don't change either.

**Contract A — `SandboxProvider` interface** (`packages/control-plane/src/sandbox/provider.ts`,
around line 365). Declares capabilities (`supportsSnapshots`, `supportsRestore`, `supportsWarm`,
`supportsPersistentResume`, `supportsExplicitStop`) plus methods:

```typescript
export interface SandboxProvider {
  readonly name: string;
  readonly capabilities: SandboxProviderCapabilities;
  createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult>;
  restoreFromSnapshot?(config: RestoreConfig): Promise<RestoreResult>;
  resumeSandbox?(config: ResumeConfig): Promise<ResumeResult>;
  takeSnapshot?(config: SnapshotConfig): Promise<SnapshotResult>;
  stopSandbox?(config: StopConfig): Promise<StopResult>;
}
```

Errors classified as `transient` vs `permanent` via `SandboxProviderError` (same file, ~line 278).
The DO calls a circuit-breaker on permanent errors.

Provider is chosen at runtime via `env.SANDBOX_PROVIDER` in `createLifecycleManager()` at
`packages/control-plane/src/session/durable-object.ts:~551`. Resolved by
`resolveSandboxBackendName()` in `packages/control-plane/src/sandbox/provider-name.ts`.

**For v1**, you implement `createSandbox`, `resumeSandbox`, `stopSandbox`. You omit
`restoreFromSnapshot` and `takeSnapshot` entirely (declare the capabilities false). Same shape as
`DaytonaSandboxProvider` — model after it.

**Contract B — Bridge ↔ Session DO WebSocket protocol.** The bridge inside the sandbox connects to
`wss://<cp>/sessions/<session_id>/ws?type=sandbox` with `Authorization: Bearer <sandbox_auth_token>`
and `X-Sandbox-ID: <id>`. Events and commands are defined in `packages/shared/src/types/`. **You
don't need to change anything here for v1** — the sandbox runtime is unchanged. You only need to
make sure the Docker container can reach the control plane URL you give it
(`http://host.docker.internal:8787` on the v1 setup).

---

#### Things that frequently bite people

- **Build `@open-inspect/shared` first** before any TS package that depends on it
  (`npm run build -w @open-inspect/shared`).
- **Durations:** Python uses **seconds**, TypeScript uses **milliseconds**. Encode the unit in the
  name (`timeout_seconds`, `timeoutMs`). Never bare `timeout`.
- **Each default duration constant defined exactly once.** Extract and import; don't duplicate the
  literal.
- **GitHub App private keys must be PKCS#8** on Cloudflare Workers
  (`openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt`).
- **`NEXT_PUBLIC_*` env vars are inlined at Next.js build time.** They must be present when
  `npm run dev -w @open-inspect/web` is started, not just at runtime.
- **`wrangler dev` with Durable Objects + SQLite** uses local SQLite files under `--persist-to` (v1
  default: `.wrangler/state/` at repo root). Don't commit this directory.
- The existing `packages/control-plane/wrangler.jsonc` is **test-only** (used by `Dockerfile.test`
  and integration tests). Leave it alone. Add a new `wrangler.dev.jsonc`.
- Modal: production deploy is `modal deploy deploy.py`, never `src/app.py` directly. **Irrelevant
  for v1** since you're not touching Modal.

---

#### Files you'll spend the most time reading (not modifying)

| Path                                                                                         | Why                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/control-plane/src/sandbox/provider.ts`                                             | The interface you're implementing.                                                                                           |
| `packages/control-plane/src/sandbox/providers/daytona-provider.ts`                           | The template you're copying — persistent stop/resume, same capability shape.                                                 |
| `packages/control-plane/src/sandbox/daytona-rest-client.ts`                                  | The HTTP-client pattern your daemon client will follow.                                                                      |
| `packages/control-plane/src/session/durable-object.ts` (esp. `createLifecycleManager` ~:551) | Where you wire the new provider in.                                                                                          |
| `packages/control-plane/src/types.ts`                                                        | The `Env` type — where new env vars get declared.                                                                            |
| `packages/modal-infra/src/images/base.py`                                                    | The image definition you mirror in your Dockerfile.                                                                          |
| `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py`                                 | The supervisor that runs inside your container; understand it so you know what env vars it expects.                          |
| `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`                                     | The bridge that connects back to the control plane; useful to know what `CONTROL_PLANE_URL` it dials and what failures mean. |

### Decisions already locked in (do not change without asking)

| Question                                                       | Decision                                                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| How does data plane run locally?                               | **Docker containers** via new `LocalDockerSandboxProvider`.                                                                            |
| Should bots run locally in v1?                                 | **No.** Sessions only from the web UI.                                                                                                 |
| Secret handling?                                               | **Auto-generate** dev secrets on first run; document placeholders for ones that can't be auto-generated (GitHub App, OAuth, LLM keys). |
| Sandbox image size?                                            | ~3-4 GB is fine. Faithfully mirror the Modal base image.                                                                               |
| Where do local SQLite files live?                              | Repo root `.wrangler/state/`. Allow overrides via the `--persist-to` flag.                                                             |
| Sandbox concurrency cap?                                       | Unbounded for now.                                                                                                                     |
| Webhook deliveries from real SaaS (GitHub/Sentry) to local CP? | **Out of scope for v1.** In backlog (§7).                                                                                              |

### Scope of v1

A contributor clones the repo, runs `npm run dev`, opens `http://localhost:3000`, logs in via GitHub
OAuth, and starts a session against a configured GitHub repository. The session spawns a Docker
container locally. The agent works in the container, streams events back over WebSocket through the
local control plane, and posts a PR to a real GitHub repo using the contributor's OAuth token.

No Cloudflare account, no Modal account, no Daytona account.

### Style ground rules

- This codebase uses **seconds in Python, milliseconds in TypeScript**, with the unit encoded in the
  variable name (`timeout_seconds` / `timeoutMs`). Don't introduce bare `timeout`.
- Each default duration value is defined exactly once in a named constant. Don't restate it in
  comments.
- Don't add features beyond what's listed here. No speculative abstractions, no "future-proofing."
- Build `@open-inspect/shared` first whenever you change shared types.
- See `CLAUDE.md` at the repo root for the full conventions.

---

## 1. Architecture (target state)

```
Browser
  │  HTTP + WS
  ▼
localhost:3000  (Next.js web, `npm run dev -w @open-inspect/web`)
  │  REST + WS
  ▼
localhost:8787  (Cloudflare control plane, `wrangler dev` against workerd)
  │  HTTP
  ▼
localhost:9000  (Sandbox Daemon — small Node HTTP shim that wraps `docker`)
  │  docker run / start / stop / inspect
  ▼
openinspect-sandbox-<sid>  (Docker container, image: openinspect/sandbox-runtime:dev)
  │  WS to host.docker.internal:8787/sessions/<sid>/ws?type=sandbox
  └─────────────────── back to control plane
```

The local data plane uses **persistent resume** semantics (like Daytona), not snapshots. A sandbox
container is created on first prompt, stopped on inactivity, and resumed (`docker start`) on the
next prompt against the same container.

---

## 2. Phase 1 — Control plane locally (~half-day)

### 2.1 Files to create

| Path                                        | Purpose                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `scripts/dev/bootstrap.sh`                  | Idempotent bootstrap: generates `.dev.vars` and `.env.local` on first run; safe to re-run. |
| `scripts/dev/migrate.sh`                    | Wraps `wrangler d1 migrations apply DB --local`.                                           |
| `packages/control-plane/wrangler.dev.jsonc` | Dev-mode wrangler config (separate from existing test-only `wrangler.jsonc`).              |
| `packages/control-plane/.dev.vars.example`  | Template, committed; shows every field.                                                    |
| `packages/control-plane/.gitignore`         | Ensure `.dev.vars`, `.wrangler/` are ignored.                                              |

### 2.2 `bootstrap.sh` behavior

On first run only (skip if files exist), write:

**`packages/control-plane/.dev.vars`** — wrangler reads this automatically:

- `TOKEN_ENCRYPTION_KEY` — `openssl rand -base64 32`
- `REPO_SECRETS_ENCRYPTION_KEY` — `openssl rand -base64 32`
- `INTERNAL_CALLBACK_SECRET` — `openssl rand -hex 32`
- `DEPLOYMENT_NAME=local-dev`
- `WORKER_URL=http://localhost:8787`
- `WEB_APP_URL=http://localhost:3000`
- `SCM_PROVIDER=github`
- `SANDBOX_PROVIDER=local-docker`
- `LOG_LEVEL=debug`
- `LOCAL_DOCKER_DAEMON_URL=http://localhost:9000`
- `LOCAL_DOCKER_DAEMON_SECRET` — `openssl rand -hex 32`
- Placeholders (with explanatory comments) for: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8 —
  see `CLAUDE.md` gotcha), `GITHUB_APP_INSTALLATION_ID`

**`packages/web/.env.local`** — Next.js standard:

- `NEXTAUTH_URL=http://localhost:3000`
- `NEXTAUTH_SECRET` — `openssl rand -base64 32`
- `CONTROL_PLANE_URL=http://localhost:8787`
- `NEXT_PUBLIC_WS_URL=ws://localhost:8787` (inlined at build; **must be present before
  `npm run dev`**)
- `INTERNAL_CALLBACK_SECRET` — same value as CP's
- `UNSAFE_ALLOW_ALL_USERS=true` — dev only
- `NEXT_PUBLIC_SANDBOX_PROVIDER=local-docker`
- `NEXT_PUBLIC_SCM_PROVIDER=github`
- Placeholders for: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`

After writing, print a "Next steps" block telling the user to fill in the GitHub App + OAuth
placeholders (with links).

### 2.3 `wrangler.dev.jsonc` shape

```jsonc
{
  "name": "open-inspect-control-plane-dev",
  "main": "src/index.ts",
  "compatibility_date": "2024-12-30",
  "vars": {
    // Non-secret defaults; secrets come from .dev.vars
  },
  "durable_objects": {
    "bindings": [
      { "name": "SESSION", "class_name": "SessionDO" },
      { "name": "SCHEDULER", "class_name": "SchedulerDO" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SessionDO"] },
    { "tag": "v2", "new_sqlite_classes": ["SchedulerDO"] },
  ],
  "d1_databases": [
    {
      "binding": "DB",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "database_name": "open-inspect-local",
    },
  ],
  "kv_namespaces": [{ "binding": "REPOS_CACHE", "id": "local-dev" }],
  "r2_buckets": [{ "binding": "MEDIA_BUCKET", "bucket_name": "open-inspect-media-local" }],
}
```

The `database_id` is a dummy in local mode — wrangler ignores it and uses a local SQLite file under
`.wrangler/state/`.

### 2.4 Root `package.json` scripts (Phase 1 subset)

```
"dev:bootstrap": "./scripts/dev/bootstrap.sh",
"dev:migrate": "./scripts/dev/migrate.sh",
"dev:control-plane": "wrangler dev --config packages/control-plane/wrangler.dev.jsonc --persist-to .wrangler/state --port 8787 --cwd packages/control-plane"
```

### 2.5 Verification gate (Phase 1 exit criterion)

- `npm run dev:bootstrap` produces `.dev.vars` and `.env.local`; re-running it is a no-op.
- `npm run dev:migrate` applies all 20 migrations against the local D1.
- `npm run dev:control-plane` starts workerd on `:8787`; `curl http://localhost:8787/health` returns
  200 (verify whatever the actual health endpoint is — search `routes/` for it).
- `.wrangler/state/` is gitignored.

**Do not move to Phase 2 until these all pass.**

---

## 3. Phase 2 — Web UI (~30 min)

Mostly already documented in `docs/SETUP_GUIDE.md` Path A. The only new piece is the `dev:web`
script and confirming the auto-generated `.env.local` from Phase 1 is sufficient.

### 3.1 Files to create / modify

- Add to root `package.json`:
  ```
  "dev:web": "npm run dev -w @open-inspect/web"
  ```
- Document GitHub OAuth App setup in `docs/LOCAL_DEVELOPMENT.md` (write this doc in Phase 4):
  1. Visit https://github.com/settings/applications/new
  2. Homepage URL: `http://localhost:3000`
  3. Authorization callback URL: `http://localhost:3000/api/auth/callback/github`
  4. Paste Client ID + Secret into `packages/web/.env.local`.

### 3.2 Verification gate

- `npm run dev:control-plane` running in one terminal, `npm run dev:web` in another.
- Browser loads `http://localhost:3000`.
- GitHub OAuth completes; user lands on the dashboard.
- Dashboard fetches an (empty) session list from `http://localhost:8787` without errors in the
  browser console or workerd logs.

---

## 4. Phase 3 — Local data plane via Docker (~2-3 days)

This is the bulk of the work. **Do this in sub-phases and verify each one** rather than building
everything before testing.

### 4.1 Sub-phase 3A — Sandbox Docker image

**Goal:** A Docker image equivalent to the Modal base image, runnable standalone for verification.

**Source of truth to mirror:** `packages/modal-infra/src/images/base.py` (read it carefully; it's
about 200 lines).

**Files to create:**

| Path                                     | Purpose                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sandbox-runtime/Dockerfile`    | Multi-stage Dockerfile equivalent to the Modal base.                                                                              |
| `packages/sandbox-runtime/.dockerignore` | Exclude `__pycache__`, tests, etc.                                                                                                |
| `scripts/dev/build-sandbox-image.sh`     | `docker build -t openinspect/sandbox-runtime:dev -f packages/sandbox-runtime/Dockerfile .` (run from repo root for COPY context). |

**Dockerfile contents (faithful mirror — do not omit anything):**

- Base: `python:3.12-slim`
- APT install:
  `git curl build-essential ca-certificates gnupg openssh-client jq unzip ffmpeg libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2`
- GitHub CLI via keyring (script lines in `base.py`)
- Node.js 22 LTS via NodeSource
- pnpm via `npm install -g pnpm`
- Bun via official installer script
- Python: `pip install uv httpx websockets 'pydantic>=2.0' 'PyJWT[crypto]'`
- OpenCode + plugin: `npm install -g opencode-ai@1.14.41 @opencode-ai/plugin@1.14.41`
- Pre-staged plugin deps into `/app/opencode-deps/` (see `base.py` for the exact files)
- code-server 4.109.5 .deb from GitHub releases
- ttyd 1.7.7 binary from GitHub releases (with SHA256 verification — match exactly)
- agent-browser: `npm install -g agent-browser@0.21.2 && agent-browser install`
- COPY `packages/sandbox-runtime/src/sandbox_runtime/` → `/app/sandbox_runtime/`
- ENV:
  - `HOME=/root`
  - `NODE_ENV=development`
  - `PNPM_HOME=/root/.local/share/pnpm`
  - `PYTHONPATH=/app`
  - `NODE_PATH=/usr/lib/node_modules`
  - `PATH` extended with Bun, pnpm, `/usr/local/bin`
- ENTRYPOINT: `["python", "-m", "sandbox_runtime.entrypoint"]`

**Sub-phase 3A verification (do this before writing the provider):**

```
docker run --rm -e SANDBOX_ID=test -e REPO_OWNER= -e REPO_NAME= \
  openinspect/sandbox-runtime:dev
```

The supervisor should boot, log `supervisor.start`, and exit cleanly when missing CP URL (it
gracefully skips bridge). If it crashes, fix the Dockerfile before continuing.

### 4.2 Sub-phase 3B — Sandbox Daemon

**Goal:** A tiny Node HTTP server that the control plane (in workerd, which cannot `exec`) calls to
drive Docker on the host.

**File to create:** `scripts/dev/sandbox-daemon.mjs` (single file, ~250 LoC).

**API the daemon exposes** (all POST, all bearer-authed with `LOCAL_DOCKER_DAEMON_SECRET`):

| Path                                 | Body                                                                                                               | Returns                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `POST /sandboxes`                    | `{ sandboxId, sessionId, env: {...}, labels: {...}, ports: { codeServer?: bool, ttyd?: bool, tunnel: number[] } }` | `{ containerId, status, portMappings: { 8080: 12345, ... } }` |
| `POST /sandboxes/:containerId/start` | —                                                                                                                  | `{ status }`                                                  |
| `POST /sandboxes/:containerId/stop`  | —                                                                                                                  | `{ status }`                                                  |
| `GET /sandboxes/:containerId`        | —                                                                                                                  | `{ status, exists, portMappings }`                            |
| `DELETE /sandboxes/:containerId`     | —                                                                                                                  | `{ deleted }`                                                 |
| `GET /health`                        | —                                                                                                                  | `{ ok: true }` (no auth)                                      |

**Implementation notes:**

- Use Node's built-in `child_process.spawn` to call `docker`.
- `POST /sandboxes` runs:
  ```
  docker run -d \
    --name openinspect-sandbox-<sandboxId> \
    --label openinspect_session_id=<sessionId> \
    --add-host=host.docker.internal:host-gateway \
    -p 0:8080  (code-server, if requested — let Docker pick host port) \
    -p 0:8081  (ttyd-proxy, if requested) \
    -p 0:<port> for each tunnel port \
    -e KEY=VALUE for every env entry \
    openinspect/sandbox-runtime:dev
  ```
- After create, run `docker inspect` to capture the actual host port mappings; return them.
- Read auth secret from env var `SANDBOX_DAEMON_SECRET` at startup; reject requests without matching
  `Authorization: Bearer <secret>`.
- Log every request to stdout (the orchestrator script will surface this).
- Listen on `localhost:9000` only — never bind to 0.0.0.0.

**Add to root `package.json`:**

```
"dev:sandbox-daemon": "SANDBOX_DAEMON_SECRET=$(cat packages/control-plane/.dev.vars | grep LOCAL_DOCKER_DAEMON_SECRET | cut -d= -f2) node scripts/dev/sandbox-daemon.mjs"
```

(Or write a small wrapper script that reads `.dev.vars` more robustly.)

**Sub-phase 3B verification:**

- Start daemon: `npm run dev:sandbox-daemon`.
- Manually `curl -X POST` against `/sandboxes` with a synthetic payload.
- Confirm a container starts, port mappings come back, and you can `curl localhost:<port>` against
  it.
- Confirm `/health` works without auth and the other endpoints reject unauthenticated requests.

### 4.3 Sub-phase 3C — `LocalDockerSandboxProvider`

**Goal:** The provider class that the control-plane DO uses, modeled on `DaytonaSandboxProvider`.

**Files to create:**

| Path                                                                         | Purpose                                 |
| ---------------------------------------------------------------------------- | --------------------------------------- |
| `packages/control-plane/src/sandbox/local-docker-daemon-client.ts`           | Typed HTTP client for the daemon.       |
| `packages/control-plane/src/sandbox/providers/local-docker-provider.ts`      | Implements `SandboxProvider`.           |
| `packages/control-plane/src/sandbox/providers/local-docker-provider.test.ts` | Unit tests with a mocked daemon client. |

**Files to modify:**

- `packages/control-plane/src/sandbox/provider-name.ts` — add `"local-docker"` to the
  `SandboxBackendName` union; update `resolveSandboxBackendName`.
- `packages/control-plane/src/session/durable-object.ts` (around line 551, in
  `createLifecycleManager`) — add a branch for `"local-docker"`: reads `env.LOCAL_DOCKER_DAEMON_URL`
  and `env.LOCAL_DOCKER_DAEMON_SECRET`, instantiates client + provider.
- `packages/control-plane/src/sandbox/index.ts` — export the new provider.
- `packages/control-plane/src/types.ts` — add `LOCAL_DOCKER_DAEMON_URL` and
  `LOCAL_DOCKER_DAEMON_SECRET` to `Env` (both optional).

**Provider capabilities (exact):**

```typescript
capabilities = {
  supportsSnapshots: false,
  supportsRestore: false,
  supportsWarm: false,
  supportsPersistentResume: true,
  supportsExplicitStop: true,
};
```

**Methods to implement** (omit unsupported ones entirely — the interface has them as optional):

- `createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult>`
  - Assemble env vars by mirroring `DaytonaSandboxProvider`'s `buildEnvVars()` (around
    `daytona-provider.ts:194`). Critical entries:
    - `PYTHONUNBUFFERED=1`, `SANDBOX_ID`, `CONTROL_PLANE_URL`, `SANDBOX_AUTH_TOKEN`, `REPO_OWNER`,
      `REPO_NAME`
    - `SESSION_CONFIG` (JSON with `session_id`, `repo_owner`, `repo_name`, `provider`, `model`,
      optional `branch`, optional `mcp_servers`)
    - `VCS_HOST`, `VCS_CLONE_USERNAME`, `VCS_CLONE_TOKEN`, `GITHUB_TOKEN` (or GitLab variants)
    - `CODE_SERVER_PASSWORD` (HMAC-derived) if `codeServerEnabled`
    - `AGENT_SLACK_NOTIFY_ENABLED` if applicable
    - Plus `config.userEnvVars` overlaid first (so system values override user values)
  - **Critical:** set `CONTROL_PLANE_URL=http://host.docker.internal:8787` for sandbox→host
    networking. On Linux this requires the `--add-host` flag, which the daemon already adds.
  - POST `/sandboxes` to the daemon; return:
    - `sandboxId` (the input id)
    - `providerObjectId` (the Docker container ID returned by the daemon)
    - `status` ("running" once the container is up — match the literal strings used elsewhere)
    - `createdAt`
    - `codeServerUrl` (build from the host port the daemon mapped, e.g. `http://localhost:<port>`)
    - `tunnelUrls` (map of internal port → `http://localhost:<host_port>`)
- `resumeSandbox(config: ResumeConfig): Promise<ResumeResult>`
  - `GET /sandboxes/<providerObjectId>` to check existence.
  - If 404 or `exists: false`: return `{ success: false, shouldSpawnFresh: true }` (matches
    Daytona's behavior at `daytona-provider.ts:~120`).
  - Else `POST /sandboxes/<id>/start`. Re-fetch port mappings (they may differ after restart).
    Return `{ success: true, providerObjectId, codeServerUrl?, tunnelUrls? }`.
- `stopSandbox(config: StopConfig): Promise<StopResult>`
  - `POST /sandboxes/<providerObjectId>/stop`. Return `{ success: true }`.

**Error classification:**

- Daemon network failures (ECONNREFUSED, timeout) → `SandboxProviderError` with
  `errorType: "transient"`.
- Daemon 401/403 (bad secret) → `"permanent"`.
- Daemon 404 (container gone) → handled inline (return `shouldSpawnFresh`).
- Daemon 5xx → `"transient"`.
- See `SandboxProviderError.fromFetchError` helper in `provider.ts:~278` for the pattern.

**Tests:**

- Cover the three happy paths (create, resume, stop).
- Cover daemon 404 on resume → `shouldSpawnFresh: true`.
- Cover daemon unreachable → transient error.
- Mock the daemon client with vitest fakes (don't spin up a real daemon in unit tests).

### 4.4 Verification gate (Phase 3 exit criterion)

End-to-end flow works:

1. `npm run dev:sandbox-daemon`, `npm run dev:control-plane`, `npm run dev:web` all running.
2. From the web UI, create a session against a test GitHub repo.
3. `docker ps` shows `openinspect-sandbox-<sid>` running.
4. The bridge connects to the control plane (observe in workerd logs:
   `bridge.connect outcome=success`).
5. Send a simple prompt ("list files in the repo"). Tokens stream back to the UI.
6. Stop the session from the UI; container stops but is not removed.
7. Send another prompt to the same session; container restarts (`docker ps -a` shows it
   transitioning); prompt completes successfully (resume path).
8. Ask the agent to create a PR. Verify it appears on GitHub attributed to the OAuth user.

---

## 5. Phase 4 — Orchestration & docs (~half-day)

### 5.1 One-command dev orchestration

Add `concurrently` as a root devDependency.

**Root `package.json` additions:**

```json
{
  "scripts": {
    "dev": "npm run dev:bootstrap && npm run dev:build:sandbox && npm run dev:migrate && concurrently -n daemon,cp,web -c blue,green,yellow 'npm:dev:sandbox-daemon' 'npm:dev:control-plane' 'npm:dev:web'",
    "dev:bootstrap": "./scripts/dev/bootstrap.sh",
    "dev:build:sandbox": "./scripts/dev/build-sandbox-image.sh",
    "dev:migrate": "./scripts/dev/migrate.sh",
    "dev:sandbox-daemon": "node scripts/dev/sandbox-daemon.mjs",
    "dev:control-plane": "wrangler dev --config packages/control-plane/wrangler.dev.jsonc --persist-to .wrangler/state --port 8787 --cwd packages/control-plane",
    "dev:web": "npm run dev -w @open-inspect/web"
  }
}
```

Bootstrap and migrate are idempotent — safe to run on every `npm run dev`. Build-sandbox is cached
by Docker layers; bumping the image is opt-in via `npm run dev:build:sandbox`.

### 5.2 Documentation

**New file: `docs/LOCAL_DEVELOPMENT.md`** (user-facing — write it last, after everything works).

Outline:

1. **What this gives you** — three layers on localhost, Docker sandboxes, real GitHub integration.
2. **Prerequisites** — Docker Desktop / engine (or equivalent), Node 22, Python 3.12, Wrangler CLI
   (or `npx wrangler`), `openssl`.
3. **One-time setup**
   - Create dev GitHub OAuth App (steps from §3.1).
   - Create dev GitHub App for repo cloning (steps including private key conversion to PKCS#8, which
     is a documented gotcha in `CLAUDE.md`).
   - Set `ANTHROPIC_API_KEY` (or your chosen LLM provider key) — explain where it goes (`.dev.vars`
     if injected into sandboxes via user env, or directly as a sandbox env var depending on actual
     wiring; verify during implementation).
4. **Run it** — `npm run dev`, open `http://localhost:3000`.
5. **Troubleshooting**
   - Docker not running → daemon errors.
   - Port 3000/8787/9000 already in use.
   - `host.docker.internal` not resolving on Linux (the `--add-host=host-gateway` flag should handle
     this; document workarounds for older Docker).
   - GitHub App private key not in PKCS#8.
   - `.wrangler/state/` got corrupted → `rm -rf .wrangler/state && npm run dev:migrate`.
6. **What's intentionally not included** — bots, webhook deliveries from real SaaS. Link to §7
   backlog.

**Modify `README.md`** — add a "Quick start (local dev)" section linking to
`docs/LOCAL_DEVELOPMENT.md`. Keep the existing deployment-focused sections untouched.

**Modify `docs/SETUP_GUIDE.md`** — add a "Path C: Run everything locally" section that just points
to `docs/LOCAL_DEVELOPMENT.md`.

### 5.3 Verification gate (final)

- A fresh clone of the repo + `npm install && npm run dev` (after filling the 5 placeholders)
  produces a working stack.
- All four phases' individual verification gates still pass.
- `npm run lint && npm run typecheck && npm test` all clean (don't introduce regressions).

---

## 6. Cross-cutting requirements

### 6.1 Don't break existing flows

- The existing `wrangler.jsonc` is consumed by integration tests (`Dockerfile.test`,
  `vitest.integration.config.ts`). Leave it alone. Add a new `wrangler.dev.jsonc` for dev — don't
  rename or merge.
- The existing Modal and Daytona providers must keep working. The new provider is purely additive.
- All new env vars in `types.ts` must be optional (no `env.LOCAL_DOCKER_DAEMON_URL!`).

### 6.2 Build order

`@open-inspect/shared` is imported by control-plane and web. If you change anything in
`packages/shared/`, run `npm run build -w @open-inspect/shared` first.

### 6.3 Conventions you must follow

- TypeScript durations: milliseconds, suffix with `Ms`. Daemon HTTP timeouts: define as named
  constants (e.g. `DAEMON_REQUEST_TIMEOUT_MS = 30_000`).
- No backward-compat shims. If you change something, change it cleanly.
- No comments explaining _what_ code does. Only _why_, and only when non-obvious.
- No new abstractions for hypothetical future providers. Implement only what `local-docker` needs.

### 6.4 Testing

- New provider needs unit tests (mock the daemon client).
- The daemon itself is hard to unit-test in isolation; an integration test that builds the image and
  spins up a real container is nice-to-have but not required for v1.
- Don't write tests that depend on `docker` being available in CI — gate any such tests behind a
  `DOCKER_AVAILABLE` env flag or skip them on CI for now.

---

## 7. Backlog (v2+)

These are explicitly **out of scope** for v1. Capture them here so they don't get lost.

1. **Webhook deliveries from real SaaS to local CP.** Today, a local control plane can't receive
   GitHub App webhooks (for auto PR review), Sentry alerts, Slack events, etc. v2 work: document a
   `cloudflared` tunnel pattern; possibly add a `npm run dev:tunnel` script that starts a tunnel and
   prints the public URL contributors paste into their dev GitHub App settings.

2. **Bots locally.** Each bot (slack-bot, github-bot, linear-bot) could be added to the
   `concurrently` group with its own wrangler.dev.jsonc and tunnel. Roughly half a day per bot.
   Blocked on (1).

3. **Snapshot support for the Docker provider.** Could use `docker commit` + `docker save` to mimic
   Modal's snapshot/restore. Adds image-cache hygiene complexity. Not needed for v1; resume
   semantics are sufficient.

4. **Sandbox concurrency cap.** Today unbounded. If contributors complain about laptop meltdown, add
   a cap (e.g. 5) in the daemon with proper 429 handling in the provider.

5. **Warm pool support.** Modal pre-warms sandboxes. Docker startup is fast enough on local that
   this probably isn't worth implementing.

6. **CI sandbox image build.** Right now the image is built on-demand on the contributor's machine.
   Could push `openinspect/sandbox-runtime:dev` to a registry from CI so contributors pull instead
   of building.

7. **Daytona-style auto-stop on inactivity for local containers.** The Daytona provider relies on
   Daytona's server to auto-stop. The local daemon could implement this with a periodic sweep.

8. **Slim sandbox image variant.** A ~500MB no-browser image for contributors who don't need
   agent-browser / visual verification.

9. **Web UI affordances.** Surface "running in local Docker" in the UI; show container ID, expose
   `docker logs` link.

10. **GitLab support locally.** Mirror the GitHub App flow. Out of scope until someone needs it.

---

## 8. Quick reference — file inventory

### Files to create

```
scripts/dev/bootstrap.sh
scripts/dev/migrate.sh
scripts/dev/build-sandbox-image.sh
scripts/dev/sandbox-daemon.mjs
packages/control-plane/wrangler.dev.jsonc
packages/control-plane/.dev.vars.example
packages/sandbox-runtime/Dockerfile
packages/sandbox-runtime/.dockerignore
packages/control-plane/src/sandbox/local-docker-daemon-client.ts
packages/control-plane/src/sandbox/providers/local-docker-provider.ts
packages/control-plane/src/sandbox/providers/local-docker-provider.test.ts
docs/LOCAL_DEVELOPMENT.md
```

### Files to modify

```
package.json                                                  (root — add dev scripts + concurrently)
packages/control-plane/.gitignore                             (add .dev.vars, .wrangler/)
packages/control-plane/src/types.ts                           (add 2 optional env vars)
packages/control-plane/src/sandbox/provider-name.ts           (add "local-docker" to union)
packages/control-plane/src/sandbox/index.ts                   (export new provider)
packages/control-plane/src/session/durable-object.ts          (~line 551 — new branch in createLifecycleManager)
README.md                                                     (link to LOCAL_DEVELOPMENT.md)
docs/SETUP_GUIDE.md                                           (add Path C reference)
```

### Files NOT to touch

```
packages/control-plane/wrangler.jsonc                         (test-only config — leave alone)
packages/control-plane/Dockerfile.test                        (CI test infra)
packages/modal-infra/**                                       (production Modal backend)
packages/daytona-infra/**                                     (production Daytona backend)
packages/control-plane/src/sandbox/providers/modal-provider.ts
packages/control-plane/src/sandbox/providers/daytona-provider.ts
packages/sandbox-runtime/src/**                               (sandbox runtime itself — don't change behavior)
terraform/**                                                  (production deployment)
```

---

## 9. Closing notes for the executing agent

- Work the phases in order. Each phase's verification gate is non-negotiable before moving on.
- When you hit ambiguity not covered here, **ask the maintainer** rather than guessing. Examples:
  - Exact health endpoint URL on the control plane (search `routes/` for it).
  - Exact name of the LLM API key env var convention (check how Modal/Daytona currently inject
    `ANTHROPIC_API_KEY`).
  - Whether to map `MEDIA_BUCKET` to a real local R2 emulation or stub it (likely stub for v1).
- Read the memory directory at the start; it has the project context you'll lack.
- This document is the source of truth. If you discover the plan is wrong, update this document in
  the same PR as your fix, and call it out in the PR description.
