/**
 * Unit tests for LocalDockerSandboxProvider.
 *
 * Mirrors the Daytona provider's test shape: cover env-var assembly, the
 * three happy paths, the missing-container → shouldSpawnFresh path, and
 * transient-error classification from daemon unreachability.
 */

import { describe, it, expect, vi } from "vitest";
import {
  LocalDockerSandboxProvider,
  type LocalDockerProviderConfig,
} from "./local-docker-provider";
import { SandboxProviderError } from "../provider";
import type { CreateSandboxConfig, ResumeConfig, StopConfig } from "../provider";
import {
  LocalDockerApiError,
  LocalDockerNotFoundError,
  type LocalDockerCreateParams,
  type LocalDockerCreateResponse,
  type LocalDockerDaemonClient,
  type LocalDockerInspectResponse,
  type LocalDockerStartResponse,
} from "../local-docker-daemon-client";

// ==================== Mock factories ====================

function createMockClient(
  overrides: Partial<{
    createSandbox: (params: LocalDockerCreateParams) => Promise<LocalDockerCreateResponse>;
    getSandbox: (id: string) => Promise<LocalDockerInspectResponse>;
    startContainer: (id: string) => Promise<LocalDockerStartResponse>;
    stopContainer: (id: string) => Promise<void>;
    removeContainer: (id: string) => Promise<void>;
  }> = {}
): LocalDockerDaemonClient {
  return {
    config: {
      daemonUrl: "http://localhost:9000",
      daemonSecret: "test-secret",
    },
    createSandbox: vi.fn(
      async (): Promise<LocalDockerCreateResponse> => ({
        containerId: "ctr-abc",
        status: "running",
        portMappings: { "8080": 32801, "3000": 32802 },
      })
    ),
    getSandbox: vi.fn(
      async (): Promise<LocalDockerInspectResponse> => ({
        exists: true,
        status: "exited",
        portMappings: {},
      })
    ),
    startContainer: vi.fn(
      async (): Promise<LocalDockerStartResponse> => ({
        status: "running",
        portMappings: { "8080": 32811 },
      })
    ),
    stopContainer: vi.fn(async () => {}),
    removeContainer: vi.fn(async () => {}),
    ...overrides,
  } as unknown as LocalDockerDaemonClient;
}

const defaultProviderConfig: LocalDockerProviderConfig = {
  scmProvider: "github",
  codeServerPasswordSecret: "test-hmac-secret",
};

const defaultGetCloneToken = vi.fn(async () => "ghs_test_clone_token");

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "http://localhost:8787",
  sandboxAuthToken: "auth-token-abc",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

const baseResumeConfig: ResumeConfig = {
  providerObjectId: "ctr-abc",
  sessionId: "session-123",
  sandboxId: "sandbox-456",
};

const baseStopConfig: StopConfig = {
  providerObjectId: "ctr-abc",
  sessionId: "session-123",
  reason: "inactivity_timeout",
};

// ==================== createSandbox ====================

describe("LocalDockerSandboxProvider.createSandbox", () => {
  it("creates a sandbox and assembles env vars + labels + ports", async () => {
    const client = createMockClient();
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    const result = await provider.createSandbox({ ...baseCreateConfig, codeServerEnabled: true });

    expect(client.createSandbox).toHaveBeenCalledTimes(1);
    const params = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // sandbox + session identification
    expect(params.sandboxId).toBe("sandbox-456");
    expect(params.sessionId).toBe("session-123");

    // labels per plan
    expect(params.labels).toMatchObject({
      openinspect_framework: "open-inspect",
      openinspect_session_id: "session-123",
      openinspect_repo: "testowner/testrepo",
      openinspect_expected_sandbox_id: "sandbox-456",
    });

    // env vars: localhost CP URL rewritten to host.docker.internal
    expect(params.env.CONTROL_PLANE_URL).toBe("http://host.docker.internal:8787");
    expect(params.env.SANDBOX_ID).toBe("sandbox-456");
    expect(params.env.REPO_OWNER).toBe("testowner");
    expect(params.env.SANDBOX_AUTH_TOKEN).toBe("auth-token-abc");

    // SESSION_CONFIG carries the session metadata
    const sessionConfig = JSON.parse(params.env.SESSION_CONFIG);
    expect(sessionConfig).toMatchObject({
      session_id: "session-123",
      repo_owner: "testowner",
      repo_name: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
    });

    // GitHub clone token wired
    expect(params.env.VCS_HOST).toBe("github.com");
    expect(params.env.GITHUB_TOKEN).toBe("ghs_test_clone_token");
    expect(params.env.VCS_CLONE_TOKEN).toBe("ghs_test_clone_token");

    // code-server password derived because codeServerEnabled
    expect(params.env.CODE_SERVER_PASSWORD).toBeDefined();
    expect(params.env.CODE_SERVER_PASSWORD).toHaveLength(32);
    expect(params.ports.codeServer).toBe(true);

    // result shape
    expect(result.sandboxId).toBe("sandbox-456");
    expect(result.providerObjectId).toBe("ctr-abc");
    expect(result.status).toBe("running");
    expect(result.codeServerUrl).toBe("http://localhost:32801");
    expect(result.codeServerPassword).toHaveLength(32);
  });

  it("does not set CODE_SERVER_PASSWORD when codeServerEnabled is false", async () => {
    const client = createMockClient();
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    await provider.createSandbox({ ...baseCreateConfig, codeServerEnabled: false });
    const params = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(params.env.CODE_SERVER_PASSWORD).toBeUndefined();
    expect(params.ports.codeServer).toBe(false);
  });

  it("overlays system env vars over user env vars (system wins)", async () => {
    const client = createMockClient();
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    await provider.createSandbox({
      ...baseCreateConfig,
      userEnvVars: { SANDBOX_ID: "user-attempt-override", CUSTOM_USER_VAR: "hello" },
    });
    const params = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(params.env.SANDBOX_ID).toBe("sandbox-456"); // system wins
    expect(params.env.CUSTOM_USER_VAR).toBe("hello");
  });

  it("classifies daemon unreachable as transient", async () => {
    const client = createMockClient({
      createSandbox: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      name: "SandboxProviderError",
      errorType: "transient",
    });
  });

  it("classifies daemon 401 as permanent", async () => {
    const client = createMockClient({
      createSandbox: vi.fn(async () => {
        throw new LocalDockerApiError("unauthorized", 401);
      }),
    });
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      name: "SandboxProviderError",
      errorType: "permanent",
    });
  });
});

// ==================== resumeSandbox ====================

describe("LocalDockerSandboxProvider.resumeSandbox", () => {
  it("starts existing container and returns fresh port mappings", async () => {
    const client = createMockClient();
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    const result = await provider.resumeSandbox({ ...baseResumeConfig, codeServerEnabled: true });

    expect(client.getSandbox).toHaveBeenCalledWith("ctr-abc");
    expect(client.startContainer).toHaveBeenCalledWith("ctr-abc");
    expect(result.success).toBe(true);
    expect(result.providerObjectId).toBe("ctr-abc");
    expect(result.codeServerUrl).toBe("http://localhost:32811");
    expect(result.codeServerPassword).toHaveLength(32);
  });

  it("returns shouldSpawnFresh when the container no longer exists", async () => {
    const client = createMockClient({
      getSandbox: vi.fn(
        async (): Promise<LocalDockerInspectResponse> => ({
          exists: false,
          status: "missing",
          portMappings: {},
        })
      ),
    });
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    const result = await provider.resumeSandbox(baseResumeConfig);

    expect(result.success).toBe(false);
    expect(result.shouldSpawnFresh).toBe(true);
    expect(client.startContainer).not.toHaveBeenCalled();
  });

  it("classifies daemon unreachable on resume as transient", async () => {
    const client = createMockClient({
      getSandbox: vi.fn(async () => {
        throw new TypeError("ECONNREFUSED");
      }),
    });
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    await expect(provider.resumeSandbox(baseResumeConfig)).rejects.toMatchObject({
      name: "SandboxProviderError",
      errorType: "transient",
    });
  });
});

// ==================== stopSandbox ====================

describe("LocalDockerSandboxProvider.stopSandbox", () => {
  it("stops the container", async () => {
    const client = createMockClient();
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    const result = await provider.stopSandbox(baseStopConfig);
    expect(client.stopContainer).toHaveBeenCalledWith("ctr-abc");
    expect(result.success).toBe(true);
  });

  it("treats missing container as success (idempotent stop)", async () => {
    const client = createMockClient({
      stopContainer: vi.fn(async () => {
        throw new LocalDockerNotFoundError("not found");
      }),
    });
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    const result = await provider.stopSandbox(baseStopConfig);
    expect(result.success).toBe(true);
  });

  it("treats 500 from `docker stop` (no-such-container) as success", async () => {
    const client = createMockClient({
      stopContainer: vi.fn(async () => {
        throw new LocalDockerApiError("Error: No such container", 500);
      }),
    });
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    const result = await provider.stopSandbox(baseStopConfig);
    expect(result.success).toBe(true);
  });

  it("propagates non-recoverable errors as a SandboxProviderError", async () => {
    const client = createMockClient({
      stopContainer: vi.fn(async () => {
        throw new LocalDockerApiError("forbidden", 403);
      }),
    });
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    await expect(provider.stopSandbox(baseStopConfig)).rejects.toBeInstanceOf(SandboxProviderError);
  });
});

// ==================== opencode auth mount ====================

describe("LocalDockerSandboxProvider opencodeAuthPath mount", () => {
  it("omits mounts when opencodeAuthPath is not configured", async () => {
    const client = createMockClient();
    const provider = new LocalDockerSandboxProvider(
      client,
      defaultProviderConfig,
      defaultGetCloneToken
    );

    await provider.createSandbox(baseCreateConfig);
    const params = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(params.mounts).toBeUndefined();
  });

  it("forwards a read-only mount when opencodeAuthPath is set", async () => {
    const client = createMockClient();
    const provider = new LocalDockerSandboxProvider(
      client,
      {
        ...defaultProviderConfig,
        opencodeAuthPath: "/home/dev/.local/share/opencode/auth.json",
      },
      defaultGetCloneToken
    );

    await provider.createSandbox(baseCreateConfig);
    const params = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(params.mounts).toEqual([
      {
        hostPath: "/home/dev/.local/share/opencode/auth.json",
        containerPath: "/root/.local/share/opencode/auth.json",
        readOnly: true,
      },
    ]);
  });

  it("treats whitespace-only opencodeAuthPath as unset", async () => {
    const client = createMockClient();
    const provider = new LocalDockerSandboxProvider(
      client,
      { ...defaultProviderConfig, opencodeAuthPath: "   " },
      defaultGetCloneToken
    );

    await provider.createSandbox(baseCreateConfig);
    const params = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(params.mounts).toBeUndefined();
  });
});

// ==================== capabilities ====================

describe("LocalDockerSandboxProvider capabilities", () => {
  it("declares persistentResume + explicitStop, no snapshots/restore/warm", () => {
    const provider = new LocalDockerSandboxProvider(
      createMockClient(),
      defaultProviderConfig,
      defaultGetCloneToken
    );
    expect(provider.capabilities).toEqual({
      supportsSnapshots: false,
      supportsRestore: false,
      supportsWarm: false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
    expect(provider.name).toBe("local-docker");
  });
});
