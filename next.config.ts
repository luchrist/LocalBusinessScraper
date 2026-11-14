import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: { "/*": ["./node_modules/electron/**", "./node_modules/electron-builder/**", "./.desktop/**", "./release/**", "./scraper-data/**", "./.git/**", "./.env*"] },
  outputFileTracingIncludes: { "/*": ["./src/lib/llm-worker.mjs"] },
  serverExternalPackages: ["node-llama-cpp", "better-sqlite3", "playwright", "systeminformation"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
