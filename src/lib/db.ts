import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Typed off makeClient, not bare PrismaClient: the client-level `omit` below
// narrows the client's generics, so a plain PrismaClient annotation no longer
// matches what makeClient returns.
const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof makeClient> | undefined;
};

// pg-connection-string now treats `sslmode=require` as `verify-full`, which
// fails against Railway's public Postgres proxy (*.proxy.rlwy.net) and most
// managed providers because they serve self-signed certs that won't validate
// against the system CA. We override the SSL behavior at the pool level
// based on the URL's sslmode, since pool options take precedence over the
// connection string.
function resolveSsl(url: string): false | { rejectUnauthorized: boolean } | undefined {
  const match = url.match(/sslmode=([a-z-]+)/i);
  const mode = match?.[1]?.toLowerCase();
  if (!mode) return undefined; // no SSL requested — leave to pg defaults
  if (mode === "disable") return false;
  if (mode === "verify-full") return { rejectUnauthorized: true };
  // require / prefer / verify-ca / no-verify → encrypt but don't verify
  return { rejectUnauthorized: false };
}

function makeClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");

  const ssl = resolveSsl(connectionString);
  const adapter = new PrismaPg({
    connectionString,
    ...(ssl !== undefined ? { ssl } : {}),
  });

  return new PrismaClient({
    adapter,
    // Style.eanResolveTrace is a diagnostic blob nothing renders incidentally —
    // only readEanResolveTrace wants it, and it asks by explicit select (which
    // overrides this). Omitting it client-wide does two jobs:
    //
    //   • Payload: every `include: { style: … }` across the app (review queue,
    //     dashboard, runner, publish, share portal) would otherwise carry the
    //     whole trace on every row for nothing.
    //   • Safety: an additive column breaks EVERY query that selects it until
    //     `migrate deploy` has run. Per-call-site `omit` is how the codebase has
    //     handled that before, but there are ~15 places that pull full Style
    //     rows and missing one takes down a page — verified here: adding this
    //     column 500'd /dashboard and the counts API through a nested
    //     `include: { style: … }` three files away. One client-level omit closes
    //     the whole class.
    omit: { style: { eanResolveTrace: true } },
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

export const db = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

// The full Prisma client OR an interactive-transaction client (the value
// `db.$transaction(async (tx) => …)` hands back). The model delegates are
// identical on both, so helpers that only touch model delegates can accept
// either — production callers get the global `db`, while a transactional
// caller (or a rollback-only test) can pass `tx` to make the whole unit of
// work atomic. Extend the picked set when a helper needs another model.
export type DbClient = Pick<
  typeof db,
  "job" | "style" | "jobAsset" | "log" | "styleOutputIgnore" | "styleOutputFieldValue"
>;
