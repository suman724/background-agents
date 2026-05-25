# Local Development

Run the whole Open-Inspect stack — control plane, web UI, and sandboxed coding agent — entirely on
your laptop. No Cloudflare, Modal, or Daytona account required.

For a one-page command reference, see [RUN_LOCALLY.md](./RUN_LOCALLY.md). This document is the
longer "I've never seen this repo" walkthrough.

## What you get

After this guide:

- `npm run dev` boots all three local services with prefixed colored output:
  - the **sandbox daemon** on `:9000` (thin Node shim wrapping `docker` for the control plane)
  - the **control plane** on `:8787` (Cloudflare Workers via `wrangler dev`, local D1)
  - the **web UI** on `:3000` (Next.js dev)
- Sessions created from the dashboard spawn real Docker containers running the same sandbox runtime
  that production uses.
- Agents clone via your GitHub App, work in the container, stream events back to the UI, and post
  PRs as the OAuth-signed-in user.

## Prerequisites

| Tool            | Version              | Notes                                                                                         |
| --------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| Node.js         | `22+`                | A `.nvmrc` is committed; `nvm use` picks it up. `npm install` warns on older majors.          |
| npm             | bundled with Node 22 | —                                                                                             |
| Docker          | recent               | `docker ps` must work without `sudo`. Docker Desktop, Colima, or a host daemon are all fine.  |
| Python          | `3.12+`              | Only for `packages/modal-infra/` and `packages/sandbox-runtime/` work — not for the dev loop. |
| `openssl`       | any                  | One-time, for the GitHub App private-key conversion.                                          |
| ~6 GB free disk | —                    | The sandbox image is ~4.5 GB on arm64, ~3.5 GB on amd64.                                      |

## One-time setup

The dev loop needs four credentials. Two we can auto-generate; two need a real GitHub App and OAuth
App. Plan on ~15 minutes the first time.

### 1. Clone and install

```bash
git clone https://github.com/<you>/background-agents
cd background-agents
nvm use            # picks up .nvmrc → Node 22
npm install
```

### 2. Generate dev secrets and apply local D1 migrations

```bash
npm run dev:bootstrap
```

This is **idempotent**: it generates `packages/control-plane/.dev.vars` and
`packages/web/.env.local` with random secrets on first run, no-ops afterward. Then:

```bash
npm run dev:migrate
```

Applies all migrations under `terraform/d1/migrations/` to the local SQLite under
`.wrangler/state/`.

### 3. Create a dev **GitHub OAuth App** (for user sign-in)

Used by NextAuth so the dashboard can sign in users via GitHub.

1. Open https://github.com/settings/applications/new
2. Fill in:
   - **Application name:** `open-inspect-local-<yourname>` (must be globally unique)
   - **Homepage URL:** `http://localhost:3000`
   - **Authorization callback URL:** `http://localhost:3000/api/auth/callback/github` (exactly this)
3. Click **Register application**.
4. Generate a client secret on the next page.
5. Paste both into `packages/web/.env.local`:
   ```
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   ```

### 4. Create a dev **GitHub App** (for repo clones, PR creation, `/repos` listing)

Used by the control plane to mint installation tokens that the sandbox uses for git operations.

1. Open https://github.com/settings/apps/new
2. Fill in:
   - **GitHub App name:** something unique like `open-inspect-local-<yourname>-app`
   - **Homepage URL:** `http://localhost:3000`
   - **Webhook → Active:** **uncheck it**. (Local control plane isn't reachable from github.com.
     Webhooks are out of scope for v1 local dev.)
3. Under **Repository permissions** set:
   - **Contents:** Read & write
   - **Pull requests:** Read & write
   - Leave everything else at "No access".
4. **Where can this GitHub App be installed?** → "Only on this account".
5. Click **Create GitHub App**.
6. On the app's settings page:
   - Copy the **App ID** (top of the page).
   - Click **Generate a private key**. A `.pem` file downloads.
7. **Convert the key to PKCS#8** (Cloudflare Workers' Web Crypto can't import the default PKCS#1
   form):
   ```bash
   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
     -in <downloaded>.pem \
     -out open-inspect.pkcs8.pem
   ```
   Verify it starts with `-----BEGIN PRIVATE KEY-----` (no `RSA`). All `*.pem` files are gitignored.
8. In the app's left sidebar, click **Install App**, install it on your account, choose "All
   repositories" or specific ones.
9. Note the **Installation ID** from the resulting URL
   (`https://github.com/settings/installations/NNNNNNNN`).
10. Paste all three into `packages/control-plane/.dev.vars`:
    ```
    GITHUB_APP_ID=...
    GITHUB_APP_INSTALLATION_ID=...
    GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
    ...
    -----END PRIVATE KEY-----"
    ```
    The multi-line key value is intentionally quoted — wrangler's `.dev.vars` parser accepts
    dotenv-style quoted multi-line values.

### 5. Pick a sandbox provider

`bootstrap.sh` defaults `SANDBOX_PROVIDER=local-docker`, which is the right value for this guide. If
your `.dev.vars` says `modal` or `daytona` from a previous setup, flip it:

```bash
sed -i 's/^SANDBOX_PROVIDER=.*/SANDBOX_PROVIDER=local-docker/' packages/control-plane/.dev.vars
```

### 6. LLM credentials

The agent inside the sandbox needs to talk to an LLM provider. Two paths:

#### Recommended: OAuth via OpenCode `auth.json` mount

Lets the in-sandbox OpenCode use your existing ChatGPT Plus/Pro subscription via OAuth. No static
API keys — works under org policies that forbid them.

```bash
# 1. Install OpenCode on the dev box (same version pinned in the sandbox image).
sudo npm install -g opencode-ai@1.14.41

# 2. Authenticate. Pick "OpenAI" → "ChatGPT Pro/Plus (headless)" if you're on an
#    SSH-only box without a browser. The headless flow prints a URL + code; visit
#    the URL on your laptop, paste the code, and the dev box stores the token in
#    ~/.local/share/opencode/auth.json.
opencode auth login

# 3. Confirm the file exists.
ls -la ~/.local/share/opencode/auth.json
```

The `bootstrap.sh` script already seeds `LOCAL_DOCKER_OPENCODE_AUTH_PATH` in `.dev.vars` pointing at
that file. The `LocalDockerSandboxProvider` mounts it read-only into every sandbox at
`/root/.local/share/opencode/auth.json`, so the in-container OpenCode finds your tokens on boot.

To use OpenAI models, set the default model in **Settings → Model Preferences** to `openai/gpt-5.4`
(or any `openai/*`). Anthropic models won't work via this path — OpenCode 1.14.41 removed the Claude
Pro/Max OAuth flow per Anthropic's ToS.

#### Alternative: API key (if your org allows static keys)

The sandbox forwards any keys present in your **repo secrets** (Settings → Secrets) into the
container's env. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` there. Note that this is per-repo, not
global, so you'd repeat for each repo you test against.

## Run it

After the one-time setup above:

```bash
npm run dev
```

That single command:

1. Re-runs bootstrap + sandbox image build + D1 migrate (all idempotent and fast on warm caches).
2. Starts the sandbox daemon, control plane, and web app concurrently with `concurrently`.

You'll see three colored prefixes — `[daemon]`, `[cp]`, `[web]` — streaming side-by-side. When you
see:

```
[daemon] [sandbox-daemon] listening on http://localhost:9000
[cp]     [wrangler:info] Ready on http://0.0.0.0:8787
[web]    ✓ Ready in NNNms
```

… open http://localhost:3000, sign in via GitHub, pick a repo, and you're off.

**Ctrl-C in that terminal kills all three children cleanly.**

### Cross-machine variant

If you SSH into a dev box and want to drive the UI from a browser on a different LAN machine:

```bash
npm run dev:lan
```

This binds `wrangler` to `0.0.0.0` (`--ip 0.0.0.0`) and Next.js to all interfaces (`-H 0.0.0.0`).
For this to work end-to-end you also need to:

- Set `NEXTAUTH_URL=http://<dev-box-LAN-IP>:3000` and
  `NEXT_PUBLIC_WS_URL=ws://<dev-box-LAN-IP>:8787` in `packages/web/.env.local`.
- Set `NEXT_DEV_ALLOWED_ORIGINS=<dev-box-LAN-IP>` so Next.js 16 doesn't block cross-origin HMR /
  hydration.
- Update the **OAuth App URLs** on GitHub to use the LAN IP (not `localhost`) for both Homepage and
  Callback.

A simpler alternative if you can SSH: forward the ports instead of LAN-binding:

```bash
ssh -L 3000:localhost:3000 -L 8787:localhost:8787 <user>@<dev-box>
```

Then browse to `http://localhost:3000` on your laptop — no `.env.local` or GitHub-OAuth-URL changes
needed.

## Troubleshooting

### `npm install` warns "engine unsupported" or wrangler refuses to start

You're on Node 20 or older. Wrangler 4 needs Node 22+. Run `nvm use` (picks up the `.nvmrc`) or
`nvm install 22 && nvm alias default 22`.

### Port 3000, 8787, or 9000 is in use

Either another `npm run dev` is still running (check
`ps -ef | grep -E 'next dev|wrangler dev|sandbox-daemon'`), or another app on your machine. Stop the
conflicting process. `concurrently`'s `-k` flag means one child crash tears the others down —
sometimes that leaves leftover state if Docker can't shut down fast enough.

### `host.docker.internal` not resolving inside the sandbox

The daemon passes `--add-host=host.docker.internal:host-gateway` to every `docker run`, which works
on Docker 20.10+ Linux. On much older Docker, run
`docker network create --driver bridge --opt 'com.docker.network.bridge.host_binding_ipv4=0.0.0.0' …`
or upgrade Docker.

### GitHub App private key error: "Could not deserialize key data"

The PEM is in PKCS#1 (the default download). Re-run the `openssl pkcs8 -topk8 …` step from §4.7
above, paste the new file's contents back into `.dev.vars`. The first line must say
`-----BEGIN PRIVATE KEY-----`, **not** `-----BEGIN RSA PRIVATE KEY-----`.

### `wrangler d1 migrations apply` says "No migrations to apply!"

Migrations already ran. The local D1 lives at
`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite` — that hashed filename is
wrangler's, not a bug. If you want a true clean slate: `rm -rf .wrangler && npm run dev:migrate`.

### Page in browser keeps spinning over LAN

Next.js 16 blocks HMR/hydration from non-localhost origins by default. Either:

- Set `NEXT_DEV_ALLOWED_ORIGINS=<your-LAN-IP>` in `packages/web/.env.local`, or
- Use the SSH-tunnel approach above and keep using `http://localhost:3000`.

### `/repos` returns 500

Your GitHub App credentials are missing or wrong. Re-check `GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID`, and the PKCS#8 private key in `.dev.vars`.

### Agent says `ProviderModelNotFoundError: anthropic/...`

The sandbox doesn't have credentials for the default Anthropic model. Either switch the default
model to `openai/*` (via Settings → Model Preferences) so the OpenCode auth.json mount covers it, or
add an API key to repo secrets. See §6 above.

### `crypto.randomUUID is not a function` in browser console (LAN mode)

Was a real bug — fixed in `packages/web/src/lib/uuid.ts` (polyfill that falls back to
`crypto.getRandomValues()` for insecure contexts). If you see it, your branch is missing the fix.

## What's intentionally not included in v1

- **Bots locally** — slack-bot, github-bot, linear-bot all require public webhook URLs. v1 covers
  the web-UI-only path. ([backlog #9](https://github.com/suman724/background-agents/issues/9))
- **Webhook deliveries from real SaaS to local CP** — same reason. Document a `cloudflared` tunnel
  pattern in v2. ([#8](https://github.com/suman724/background-agents/issues/8))
- **Snapshot/restore for the local sandbox** — the local-docker provider uses persistent-resume
  only. Adequate for dev. ([#10](https://github.com/suman724/background-agents/issues/10))
- **Sandbox concurrency cap** — currently unbounded. Add one if your laptop melts.
  ([#11](https://github.com/suman724/background-agents/issues/11))

The full v1 plan lives at [LOCAL_DEVELOPMENT_PLAN.md](./LOCAL_DEVELOPMENT_PLAN.md).
