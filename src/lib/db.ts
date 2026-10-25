import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveSsl } from "@/lib/pg-ssl";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Pool size per app process. pg's default of 10 queues a page's parallel
// queries behind the sidebar polls and the job runner on a busy instance.
// Railway Postgres allows 100 connections; the cron service only calls the
// app over HTTP, so its work runs inside this pool. 15 leaves room for a
// second instance overlapping during a deploy, `prisma migrate deploy` and
// ad-hoc psql sessions. Override with DATABASE_POOL_MAX (a positive integer).
const DEFAULT_POOL_MAX = 15;

function resolvePoolMax(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_POOL_MAX;
}

function makeClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");

  const ssl = resolveSsl(connectionString);
  const adapter = new PrismaPg({
    connectionString,
    max: resolvePoolMax(process.env.DATABASE_POOL_MAX),
    ...(ssl !== undefined ? { ssl } : {}),
  });

  return new PrismaClient({
    adapter,
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
  | "job"
  | "style"
  | "jobAsset"
  | "log"
  | "styleOutputIgnore"
  | "styleOutputFieldValue"
  | "styleOutputLineValue"
>;
