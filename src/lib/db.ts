import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
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
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

export const db = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
