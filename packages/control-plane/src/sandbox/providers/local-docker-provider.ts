/**
 * Local-Docker sandbox provider — drives docker on the host through the
 * sandbox daemon (scripts/dev/sandbox-daemon.mjs). Used only in local dev.
 *
 * Modeled on DaytonaSandboxProvider: persistent-resume + explicit-stop, no
 * snapshots / restore / warm pool.
 */

import { computeHmacHex, MAX_TUNNEL_PORTS, type SandboxSettings } from "@open-inspect/shared";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  LocalDockerApiError,
  LocalDockerNotFoundError,
  type LocalDockerCreateParams,
  type LocalDockerDaemonClient,
} from "../local-docker-daemon-client";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
} from "../provider";

const log = createLogger("local-docker-provider");

const CODE_SERVER_PORT = 8080;
const TTYD_PROXY_PORT = 8081;
const DEFAULT_TUNNEL_HOST = "localhost";

export interface LocalDockerProviderConfig {
  scmProvider: SourceControlProviderName;
  /** HMAC secret for deriving code-server passwords (typically LOCAL_DOCKER_DAEMON_SECRET). */
  codeServerPasswordSecret: string;
  /** Host name used in tunnel URLs returned to the browser. Defaults to "localhost". */
  tunnelHost?: string;
}

export class LocalDockerSandboxProvider implements SandboxProvider {
  readonly name = "local-docker";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: LocalDockerDaemonClient,
    private readonly providerConfig: LocalDockerProviderConfig,
    private readonly getCloneToken: () => Promise<string | null>
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const envVars = await this.buildEnvVars(config);
      const labels = this.buildLabels(config);
      const ports = this.buildPortsRequest(config);

      const params: LocalDockerCreateParams = {
        sandboxId: config.sandboxId,
        sessionId: config.sessionId,
        env: envVars,
        labels,
        ports,
      };

      const response = await this.client.createSandbox(params);

      const { codeServerUrl, codeServerPassword, tunnelUrls } = await this.buildTunnelUrls(
        response.portMappings,
        config.sandboxId,
        config.codeServerEnabled,
        config.sandboxSettings
      );

      return {
        sandboxId: config.sandboxId,
        providerObjectId: response.containerId,
        status: response.status,
        createdAt: Date.now(),
        codeServerUrl,
        codeServerPassword,
        tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create local-docker sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      const inspect = await this.client.getSandbox(config.providerObjectId);
      if (!inspect.exists) {
        return {
          success: false,
          error: "Container no longer exists",
          shouldSpawnFresh: true,
        };
      }

      const started = await this.client.startContainer(config.providerObjectId);

      let codeServerUrl: string | undefined;
      let codeServerPassword: string | undefined;
      let tunnelUrls: Record<string, string> | undefined;
      try {
        const tunnels = await this.buildTunnelUrls(
          started.portMappings,
          config.sandboxId,
          config.codeServerEnabled,
          config.sandboxSettings
        );
        codeServerUrl = tunnels.codeServerUrl;
        codeServerPassword = tunnels.codeServerPassword;
        tunnelUrls = tunnels.tunnelUrls;
      } catch (tunnelError) {
        log.warn("local-docker.resume_tunnel_urls_failed", {
          sandbox_id: config.sandboxId,
          error: tunnelError instanceof Error ? tunnelError.message : String(tunnelError),
        });
      }

      return {
        success: true,
        providerObjectId: config.providerObjectId,
        codeServerUrl,
        codeServerPassword,
        tunnelUrls,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to resume local-docker sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      await this.client.stopContainer(config.providerObjectId);
      return { success: true };
    } catch (error) {
      // Container already gone — daemon returns either 404 or 500 from
      // `docker stop` failing. Either way, the goal (stopped/absent) holds.
      if (
        error instanceof LocalDockerNotFoundError ||
        (error instanceof LocalDockerApiError && error.status === 500)
      ) {
        log.info("local-docker.stop_ignored_missing", {
          session_id: config.sessionId,
          provider_object_id: config.providerObjectId,
        });
        return { success: true };
      }
      throw this.classifyError("Failed to stop local-docker sandbox", error);
    }
  }

  // -----------------------------------------------------------------------
  // Env var assembly
  // -----------------------------------------------------------------------

  private async buildEnvVars(config: CreateSandboxConfig): Promise<Record<string, string>> {
    const cloneToken = await this.getCloneToken();

    // Start with user env vars (repo secrets), then overlay system vars so
    // system values always win.
    const envVars: Record<string, string> = { ...(config.userEnvVars ?? {}) };

    const sessionConfig: Record<string, string> = {
      session_id: config.sessionId,
      repo_owner: config.repoOwner,
      repo_name: config.repoName,
      provider: config.provider,
      model: config.model,
    };
    if (config.branch) {
      sessionConfig.branch = config.branch;
    }

    Object.assign(envVars, {
      PYTHONUNBUFFERED: "1",
      SANDBOX_ID: config.sandboxId,
      // The sandbox runs inside Docker; localhost there is the container
      // itself, not the workerd dev server on the host. Rewrite to
      // host.docker.internal so the bridge can reach the host CP.
      CONTROL_PLANE_URL: rewriteForDockerHostNetworking(config.controlPlaneUrl),
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      SESSION_CONFIG: JSON.stringify(sessionConfig),
    });

    if (config.codeServerEnabled) {
      envVars.CODE_SERVER_PASSWORD = await this.deriveCodeServerPassword(config.sandboxId);
    }

    if (config.agentSlackNotifyEnabled) {
      envVars.AGENT_SLACK_NOTIFY_ENABLED = "true";
    }

    if (this.providerConfig.scmProvider === "gitlab") {
      envVars.VCS_HOST = "gitlab.com";
      envVars.VCS_CLONE_USERNAME = "oauth2";
    } else {
      envVars.VCS_HOST = "github.com";
      envVars.VCS_CLONE_USERNAME = "x-access-token";
    }

    if (cloneToken) {
      envVars.VCS_CLONE_TOKEN = cloneToken;
      if (this.providerConfig.scmProvider === "github") {
        envVars.GITHUB_APP_TOKEN = cloneToken;
        envVars.GITHUB_TOKEN = cloneToken;
      }
    }

    return envVars;
  }

  private buildLabels(config: CreateSandboxConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_repo: `${config.repoOwner}/${config.repoName}`,
      openinspect_expected_sandbox_id: config.sandboxId,
    };
  }

  private buildPortsRequest(config: CreateSandboxConfig): LocalDockerCreateParams["ports"] {
    const tunnel = resolveTunnelPorts(config.sandboxSettings?.tunnelPorts).filter(
      (p) => p !== CODE_SERVER_PORT && p !== TTYD_PROXY_PORT
    );
    return {
      codeServer: !!config.codeServerEnabled,
      ttyd: false,
      tunnel,
    };
  }

  private async buildTunnelUrls(
    portMappings: Record<string, number>,
    sandboxId: string,
    codeServerEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    tunnelUrls?: Record<string, string>;
  }> {
    const host = this.providerConfig.tunnelHost ?? DEFAULT_TUNNEL_HOST;

    let codeServerUrl: string | undefined;
    let codeServerPassword: string | undefined;
    if (codeServerEnabled) {
      const hostPort = portMappings[String(CODE_SERVER_PORT)] ?? portMappings[CODE_SERVER_PORT];
      if (hostPort) {
        codeServerUrl = `http://${host}:${hostPort}`;
        codeServerPassword = await this.deriveCodeServerPassword(sandboxId);
      }
    }

    const tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts).filter(
      (p) => p !== CODE_SERVER_PORT && p !== TTYD_PROXY_PORT
    );
    let tunnelUrls: Record<string, string> | undefined;
    if (tunnelPorts.length > 0) {
      const entries: [string, string][] = [];
      for (const port of tunnelPorts) {
        const hostPort = portMappings[String(port)] ?? portMappings[port];
        if (hostPort) {
          entries.push([String(port), `http://${host}:${hostPort}`]);
        }
      }
      if (entries.length > 0) {
        tunnelUrls = Object.fromEntries(entries);
      }
    }

    return { codeServerUrl, codeServerPassword, tunnelUrls };
  }

  private async deriveCodeServerPassword(sandboxId: string): Promise<string> {
    const digest = await computeHmacHex(
      `code-server:${sandboxId}`,
      this.providerConfig.codeServerPasswordSecret
    );
    return digest.slice(0, 32);
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof LocalDockerApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    if (error instanceof LocalDockerNotFoundError) {
      return new SandboxProviderError(`${message}: ${error.message}`, "permanent", error);
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

function rewriteForDockerHostNetworking(url: string): string {
  return url
    .replace(/(:\/\/)localhost(:|\/|$)/, "$1host.docker.internal$2")
    .replace(/(:\/\/)127\.0\.0\.1(:|\/|$)/, "$1host.docker.internal$2");
}

function resolveTunnelPorts(rawPorts: number[] | undefined): number[] {
  if (!rawPorts) return [];
  const ports: number[] = [];
  for (const value of rawPorts) {
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      ports.push(value);
    }
    if (ports.length >= MAX_TUNNEL_PORTS) break;
  }
  return ports;
}

export function createLocalDockerProvider(
  client: LocalDockerDaemonClient,
  providerConfig: LocalDockerProviderConfig,
  getCloneToken: () => Promise<string | null>
): LocalDockerSandboxProvider {
  return new LocalDockerSandboxProvider(client, providerConfig, getCloneToken);
}
