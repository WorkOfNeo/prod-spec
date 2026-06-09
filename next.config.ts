import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (pdfjs-based) does dynamic requires / touches Node built-ins
  // that break when bundled — keep it external on the server.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
