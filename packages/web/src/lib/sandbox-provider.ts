/**
 * Public sandbox backend helpers for the web app.
 */

export type PublicSandboxProvider = "modal" | "daytona" | "local-docker";

export function getPublicSandboxProvider(): PublicSandboxProvider {
  const rawValue = process.env.NEXT_PUBLIC_SANDBOX_PROVIDER ?? process.env.SANDBOX_PROVIDER;
  if (!rawValue || rawValue.trim() === "") {
    return "modal";
  }

  const value = rawValue.trim().toLowerCase();
  if (value === "modal" || value === "daytona" || value === "local-docker") {
    return value;
  }

  throw new Error(`Invalid sandbox provider: ${rawValue}`);
}

// Only the Modal backend supports pre-built repo images. Daytona and the local
// Docker provider don't, so the corresponding UI bits hide themselves.
export function supportsRepoImages(): boolean {
  return getPublicSandboxProvider() === "modal";
}
