import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

// Loaded by src/instrumentation.ts on the Node runtime when Langfuse is
// configured. The span processor batches and exports in the background; by
// default it sends only Langfuse and GenAI spans, so Next.js's own request
// spans stay out of Langfuse.
//
// Environment and release keep production, the dev environment and local runs
// apart in Langfuse, and tie a trace to the deploy that made it. Langfuse
// accepts lowercase letters, digits, "-" and "_" for an environment.
function environment(): string | undefined {
  const raw = process.env.LANGFUSE_TRACING_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV;
  const env = raw?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
  return env && !env.startsWith("langfuse") ? env : undefined;
}

// Exported so a script can shut it down (flushing what is queued) before it exits.
export const sdk = new NodeSDK({
  spanProcessors: [
    new LangfuseSpanProcessor({
      environment: environment(),
      release: process.env.LANGFUSE_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12),
    }),
  ],
});

sdk.start();
