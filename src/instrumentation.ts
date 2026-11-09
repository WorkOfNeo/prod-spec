// Next.js server start-up hook: registers OpenTelemetry with Langfuse as the
// exporter, so the AI features' traces (src/lib/ai/tracing.ts) reach
// Langfuse. Node runtime only, and only when the Langfuse keys are set:
// without them nothing is registered and every observation is a no-op.
//
//   LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY   the project's key pair
//   LANGFUSE_BASE_URL                           the self-hosted instance
//   LANGFUSE_TRACING_ENVIRONMENT                optional; defaults to the
//                                               Railway environment's name
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { langfuseConfigured } = await import("./lib/ai/tracing");
  if (!langfuseConfigured()) return;
  await import("./instrumentation-node");
}
