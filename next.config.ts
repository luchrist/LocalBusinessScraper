import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-llama-cpp", "better-sqlite3"],
};

export default nextConfig;
