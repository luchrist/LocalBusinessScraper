import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-llama-cpp", "better-sqlite3", "playwright"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
