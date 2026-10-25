import pg from "pg";
import { resolveSsl } from "@/lib/pg-ssl";
import { assertDevDataLoaderSafe } from "./flags";

// Two plain pg pools, kept apart from the app's Prisma client:
// - prod: PROD_READ_DATABASE_URL, every session read-only (Postgres itself
//   refuses writes, on top of the read-only role it should log in as) and with
//   a statement timeout so a slow read can't hold production.
// - dev: the app's own DATABASE_URL, where every copied row is written.
// Small pools: the loader runs one sync at a time. (`pg` and its types come
// with @prisma/adapter-pg, which depends on both.)

type Pools = { prod: pg.Pool; dev: pg.Pool };

const globalForPools = globalThis as unknown as { devDataPools?: Pools };

export function pools(): Pools {
  const { prodUrl, devUrl } = assertDevDataLoaderSafe();
  if (!globalForPools.devDataPools) {
    const prodSsl = resolveSsl(prodUrl);
    const devSsl = resolveSsl(devUrl);
    globalForPools.devDataPools = {
      prod: new pg.Pool({
        connectionString: prodUrl,
        max: 3,
        options: "-c default_transaction_read_only=on -c statement_timeout=120000",
        ...(prodSsl !== undefined ? { ssl: prodSsl } : {}),
      }),
      dev: new pg.Pool({ connectionString: devUrl, max: 4, ...(devSsl !== undefined ? { ssl: devSsl } : {}) }),
    };
  }
  return globalForPools.devDataPools;
}
