#!/usr/bin/env node
/*
 * Sandbox daemon — small HTTP shim used by the local-docker SandboxProvider.
 *
 * The control plane runs inside workerd, which cannot exec subprocesses. This
 * daemon runs on the host, drives `docker` on the daemon's behalf, and is
 * authed with a shared secret (LOCAL_DOCKER_DAEMON_SECRET) read from
 * packages/control-plane/.dev.vars or the SANDBOX_DAEMON_SECRET env var.
 *
 * Binds 127.0.0.1 only. Never exposed to the network.
 *
 * API (matches the docs/LOCAL_DEVELOPMENT_PLAN.md §4.2 contract):
 *   GET    /health                              — no auth, returns { ok: true }
 *   POST   /sandboxes                           — create + start container
 *   GET    /sandboxes/:containerId              — inspect (status, exists, portMappings)
 *   POST   /sandboxes/:containerId/start        — restart a stopped container
 *   POST   /sandboxes/:containerId/stop         — stop without removing
 *   DELETE /sandboxes/:containerId              — remove
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, normalize } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..");
const DEV_VARS_PATH = join(REPO_ROOT, "packages", "control-plane", ".dev.vars");

const PORT = Number(process.env.SANDBOX_DAEMON_PORT) || 9000;
const IMAGE_TAG = process.env.SANDBOX_IMAGE_TAG || "openinspect/sandbox-runtime:dev";
const DOCKER_BIN = process.env.DOCKER_BIN || "docker";
const DOCKER_TIMEOUT_MS = 30_000;
const REQUEST_BODY_LIMIT_BYTES = 256 * 1024;

function readSecret() {
  if (process.env.SANDBOX_DAEMON_SECRET) return process.env.SANDBOX_DAEMON_SECRET;
  if (process.env.LOCAL_DOCKER_DAEMON_SECRET) return process.env.LOCAL_DOCKER_DAEMON_SECRET;
  try {
    const content = readFileSync(DEV_VARS_PATH, "utf8");
    const match = content.match(/^LOCAL_DOCKER_DAEMON_SECRET=(.+)$/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

const SECRET = readSecret();
if (!SECRET) {
  console.error(
    "[sandbox-daemon] LOCAL_DOCKER_DAEMON_SECRET not found in env or " +
      DEV_VARS_PATH +
      ". Run: npm run dev:bootstrap"
  );
  process.exit(1);
}

function runDocker(args, { timeoutMs = DOCKER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(Object.assign(new Error(stderr.trim() || `docker exited ${code}`), { code }));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function containerName(sandboxId) {
  return `openinspect-sandbox-${sandboxId}`;
}

async function inspectContainer(idOrName) {
  try {
    const { stdout } = await runDocker(["inspect", idOrName]);
    const parsed = JSON.parse(stdout);
    return parsed[0] ?? null;
  } catch (err) {
    if (err.code === 1) return null; // not found
    throw err;
  }
}

function portMappingsFromInspect(info) {
  const ports = info?.NetworkSettings?.Ports || {};
  const result = {};
  for (const [containerPort, bindings] of Object.entries(ports)) {
    if (!bindings || bindings.length === 0) continue;
    const internal = parseInt(containerPort.split("/")[0], 10);
    const hostPort = parseInt(bindings[0].HostPort, 10);
    if (Number.isFinite(internal) && Number.isFinite(hostPort)) {
      result[internal] = hostPort;
    }
  }
  return result;
}

// Host paths we refuse to mount, even read-only. Adjusting any of these would
// give the in-container agent escalation routes (read SSH keys, replace
// kernel modules, etc.). Narrow and conservative — anything specific to this
// project's threat model belongs here.
const FORBIDDEN_MOUNT_PREFIXES = [
  "/etc",
  "/var",
  "/proc",
  "/sys",
  "/boot",
  "/dev",
  "/root/.ssh",
];

function resolveHostPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new HttpError(400, "mounts[].hostPath must be a non-empty string");
  }
  let expanded = rawPath;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = join(homedir(), expanded.slice(1).replace(/^\//, ""));
  }
  const absolute = resolve(expanded);
  const norm = normalize(absolute);
  for (const banned of FORBIDDEN_MOUNT_PREFIXES) {
    if (norm === banned || norm.startsWith(banned + "/")) {
      throw new HttpError(400, `mounts[].hostPath refused (forbidden prefix ${banned}): ${rawPath}`);
    }
  }
  try {
    statSync(norm);
  } catch {
    throw new HttpError(400, `mounts[].hostPath does not exist on host: ${norm}`);
  }
  return norm;
}

function buildMountArgs(mounts) {
  if (!Array.isArray(mounts)) return [];
  const args = [];
  for (const mount of mounts) {
    const hostPath = resolveHostPath(mount?.hostPath);
    if (typeof mount?.containerPath !== "string" || !mount.containerPath.startsWith("/")) {
      throw new HttpError(400, "mounts[].containerPath must be an absolute path");
    }
    const flag = mount.readOnly === false ? "rw" : "ro";
    args.push("-v", `${hostPath}:${mount.containerPath}:${flag}`);
  }
  return args;
}

async function createSandbox({ sandboxId, sessionId, env: envVars, labels, ports, mounts }) {
  if (!sandboxId) throw new HttpError(400, "sandboxId required");
  const args = [
    "run",
    "-d",
    "--name",
    containerName(sandboxId),
    "--label",
    `openinspect_session_id=${sessionId ?? ""}`,
    "--add-host=host.docker.internal:host-gateway",
  ];
  for (const [key, value] of Object.entries(labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }
  if (ports?.codeServer) args.push("-p", "0:8080");
  if (ports?.ttyd) args.push("-p", "0:8081");
  for (const containerPort of ports?.tunnel ?? []) {
    if (Number.isInteger(containerPort) && containerPort > 0) {
      args.push("-p", `0:${containerPort}`);
    }
  }
  for (const [key, value] of Object.entries(envVars ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  // Validate + add mounts before image tag. Errors here bubble as 400 before
  // we touch docker.
  args.push(...buildMountArgs(mounts));
  args.push(IMAGE_TAG);

  const { stdout } = await runDocker(args, { timeoutMs: 60_000 });
  const containerId = stdout.trim();
  const info = await inspectContainer(containerId);
  return {
    containerId,
    status: info?.State?.Status ?? "running",
    portMappings: portMappingsFromInspect(info),
  };
}

async function startContainer(containerId) {
  await runDocker(["start", containerId]);
  const info = await inspectContainer(containerId);
  return {
    status: info?.State?.Status ?? "running",
    portMappings: portMappingsFromInspect(info),
  };
}

async function stopContainer(containerId) {
  await runDocker(["stop", containerId], { timeoutMs: 60_000 });
  return { status: "stopped" };
}

async function inspectStatus(containerId) {
  const info = await inspectContainer(containerId);
  if (!info) return { exists: false, status: "missing", portMappings: {} };
  return {
    exists: true,
    status: info.State?.Status ?? "unknown",
    portMappings: portMappingsFromInspect(info),
  };
}

async function removeContainer(containerId) {
  await runDocker(["rm", "-f", containerId]);
  return { deleted: true };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > REQUEST_BODY_LIMIT_BYTES) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return false;
  return header.slice(7) === SECRET;
}

function send(res, status, body) {
  const payload = body == null ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function route(req, res, url) {
  const path = url.pathname;
  // GET /health — no auth
  if (req.method === "GET" && path === "/health") {
    return send(res, 200, { ok: true });
  }
  if (!authorized(req)) {
    return send(res, 401, { error: "unauthorized" });
  }

  if (req.method === "POST" && path === "/sandboxes") {
    const body = await readJsonBody(req);
    const result = await createSandbox(body);
    return send(res, 201, result);
  }

  const idMatch = path.match(/^\/sandboxes\/([^/]+)(?:\/(start|stop))?$/);
  if (idMatch) {
    const [, containerId, action] = idMatch;
    if (req.method === "GET" && !action) {
      return send(res, 200, await inspectStatus(containerId));
    }
    if (req.method === "POST" && action === "start") {
      return send(res, 200, await startContainer(containerId));
    }
    if (req.method === "POST" && action === "stop") {
      return send(res, 200, await stopContainer(containerId));
    }
    if (req.method === "DELETE" && !action) {
      return send(res, 200, await removeContainer(containerId));
    }
  }

  send(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  const start = Date.now();
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  let status = 500;
  try {
    await route(req, res, url);
    status = res.statusCode;
  } catch (err) {
    status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) send(res, status, { error: message });
    if (status === 500) console.error("[sandbox-daemon] error:", err);
  } finally {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        status,
        duration_ms: Date.now() - start,
      })
    );
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sandbox-daemon] listening on http://localhost:${PORT}`);
});

const shutdown = () => {
  console.log("[sandbox-daemon] shutting down");
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
