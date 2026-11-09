import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (pdfjs-based) does dynamic requires / touches Node built-ins
  // that break when bundled — keep it external on the server. Same story
  // for pdfjs-dist (fake-worker dynamic import) and @napi-rs/canvas
  // (native .node binary), which power the output thumbnails.
  //
  // The tracing stack (src/instrumentation-node.ts) stays external too: the
  // OTel SDK loads exporters dynamically, and every module must share ONE
  // copy of @opentelemetry/api, whose global holds the registered tracer.
  serverExternalPackages: [
    "pdf-parse",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@langfuse/otel",
    "@langfuse/tracing",
  ],
};

export default nextConfig;
