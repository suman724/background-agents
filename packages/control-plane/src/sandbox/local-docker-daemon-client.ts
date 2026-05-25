/**
 * Typed HTTP client for the local sandbox daemon (scripts/dev/sandbox-daemon.mjs).
 *
 * The daemon runs on the contributor's host and wraps `docker`. The control
 * plane runs inside workerd, which cannot exec subprocesses, so it drives
 * docker via this HTTP shim. Bearer-authed against LOCAL_DOCKER_DAEMON_SECRET.
 */

import { createLogger } from "../logger";

const log = createLogger("local-docker-daemon-client");

const TIMEOUT_CREATE_MS = 90_000;
const TIMEOUT_START_MS = 60_000;
const TIMEOUT_STOP_MS = 60_000;
const TIMEOUT_GET_MS = 15_000;
const TIMEOUT_REMOVE_MS = 30_000;

export interface LocalDockerDaemonConfig {
  /** Daemon base URL (e.g. http://localhost:9000) */
  daemonUrl: string;
  /** Bearer secret matching the daemon's LOCAL_DOCKER_DAEMON_SECRET */
  daemonSecret: string;
}

export interface LocalDockerCreateParams {
  sandboxId: string;
  sessionId: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  ports: {
    codeServer?: boolean;
    ttyd?: boolean;
    tunnel: number[];
  };
}

export interface LocalDockerCreateResponse {
  containerId: string;
  status: string;
  portMappings: Record<string, number>;
}

export interface LocalDockerInspectResponse {
  exists: boolean;
  status: string;
  portMappings: Record<string, number>;
}

export interface LocalDockerStartResponse {
  status: string;
  portMappings: Record<string, number>;
}

/** Thrown when the daemon reports a container no longer exists. */
export class LocalDockerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDockerNotFoundError";
  }
}

/** Thrown for non-404 daemon errors. Carries HTTP status for classification. */
export class LocalDockerApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "LocalDockerApiError";
  }
}

export class LocalDockerDaemonClient {
  private readonly baseUrl: string;

  constructor(public readonly config: LocalDockerDaemonConfig) {
    if (!config.daemonUrl) {
      throw new Error("LocalDockerDaemonClient requires daemonUrl");
    }
    if (!config.daemonSecret) {
      throw new Error("LocalDockerDaemonClient requires daemonSecret");
    }
    this.baseUrl = config.daemonUrl.replace(/\/+$/, "");
  }

  async createSandbox(params: LocalDockerCreateParams): Promise<LocalDockerCreateResponse> {
    const startMs = Date.now();
    try {
      return await this.request<LocalDockerCreateResponse>(
        "POST",
        "/sandboxes",
        TIMEOUT_CREATE_MS,
        params
      );
    } finally {
      log.info("local-docker.create_sandbox", {
        duration_ms: Date.now() - startMs,
        sandbox_id: params.sandboxId,
      });
    }
  }

  async getSandbox(containerId: string): Promise<LocalDockerInspectResponse> {
    return this.request<LocalDockerInspectResponse>(
      "GET",
      `/sandboxes/${encodeURIComponent(containerId)}`,
      TIMEOUT_GET_MS
    );
  }

  async startContainer(containerId: string): Promise<LocalDockerStartResponse> {
    return this.request<LocalDockerStartResponse>(
      "POST",
      `/sandboxes/${encodeURIComponent(containerId)}/start`,
      TIMEOUT_START_MS
    );
  }

  async stopContainer(containerId: string): Promise<void> {
    await this.request<void>(
      "POST",
      `/sandboxes/${encodeURIComponent(containerId)}/stop`,
      TIMEOUT_STOP_MS
    );
  }

  async removeContainer(containerId: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/sandboxes/${encodeURIComponent(containerId)}`,
      TIMEOUT_REMOVE_MS
    );
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    timeoutMs: number,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.daemonSecret}`,
        },
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);

      if (response.status === 404) {
        const text = await response.text();
        throw new LocalDockerNotFoundError(text || `Not found: ${path}`);
      }
      if (!response.ok) {
        const text = await response.text();
        throw new LocalDockerApiError(text || response.statusText, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      }
      return undefined as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function createLocalDockerDaemonClient(
  config: LocalDockerDaemonConfig
): LocalDockerDaemonClient {
  return new LocalDockerDaemonClient(config);
}
