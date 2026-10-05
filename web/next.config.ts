import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Allow a phone on the same Wi-Fi to load the dev server through the
  // computer's LAN IP (npm run dev:https). Hostnames/IPs only, no port.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.*.*.*", "*.local"],
};

export default nextConfig;
