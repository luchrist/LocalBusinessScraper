import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: [
    "node-llama-cpp",
    "better-sqlite3",
    "playwright",
    // Keep devDependencies out of the bundle (eslint / babel are pulled in
    // when Turbopack traces eslint.config.mjs from the project root)
    "eslint",
    "@babel/core",
    "eslint-plugin-import",
    "eslint-config-next",
  ],
  // Exclude runtime data dirs and dev-only files from the standalone bundle.
  // Route key '/' covers all routes when using the glob '*' pattern.
  outputFileTracingExcludes: {
    '/**': [
      'scraper-data/**',
      'models/**',
      'logs/**',
      'electron/**',
      'electron-dist/**',
      'build-resources/**',
      'dist/**',
      'scripts/**',
      '*.md',
      '*.yml',
      '*.patch',
      '*.txt',
      '*.tsbuildinfo',
      'test-*.ts',
      'node_modules/eslint/**',
      'node_modules/@babel/**',
      'node_modules/eslint-plugin-*/**',
      'node_modules/eslint-config-*/**',
      'node_modules/@typescript-eslint/**',
    ],
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
