import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server in .next/standalone, for the Docker image.
  output: "standalone",
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
