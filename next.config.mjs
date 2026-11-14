/** @type {import('next').NextConfig} */
const nextConfig = {
  // The founder-local harness binds only to loopback. Next 16 protects dev
  // resources by origin, so explicitly allow its two loopback hostnames; this
  // setting is development-only and does not open a production origin.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
