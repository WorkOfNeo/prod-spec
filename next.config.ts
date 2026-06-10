import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (pdfjs-based) does dynamic requires / touches Node built-ins
  // that break when bundled — keep it external on the server. Same story
  // for pdfjs-dist (fake-worker dynamic import) and @napi-rs/canvas
  // (native .node binary), which power the output thumbnails.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
};

export default nextConfig;
