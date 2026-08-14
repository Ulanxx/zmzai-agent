import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@zmzai/db", "@zmzai/theme"],
  webpack: (config) => {
    // The framework package's ESM source imports use .js extensions (NodeNext
    // style); map them back to .ts so webpack resolves the source directly.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
