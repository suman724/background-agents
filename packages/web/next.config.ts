import path from "path";
import type { NextConfig } from "next";

const monorepoRoot = path.join(__dirname, "../..");

// Comma-separated list of non-localhost origins allowed to talk to the dev
// server (Next.js 16 blocks HMR and hydration from anything outside this list).
// Set in packages/web/.env.local when running `npm run dev:web:lan`.
const devOrigins = process.env.NEXT_DEV_ALLOWED_ORIGINS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  output: "standalone",
  // Both must match the monorepo root for Turbopack to resolve workspace packages
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
  ...(devOrigins?.length ? { allowedDevOrigins: devOrigins } : {}),
};

export default nextConfig;
