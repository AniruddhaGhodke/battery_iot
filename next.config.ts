import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The MQTT client opens a long-lived TCP socket. Keep it out of the bundler
  // and load it as a plain Node module on the server.
  serverExternalPackages: ["mqtt"],
};

export default nextConfig;
