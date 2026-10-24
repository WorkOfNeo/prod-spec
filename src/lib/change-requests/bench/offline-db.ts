// =====================================================
// Change-request bench — the database stand-in.
//
// The bench promise is "an API key and nothing else": no Postgres, no .env.
// The renderer still reaches for the database here and there — wash-care
// artwork, the translation bank, care-label texts, certificate marks, the
// image library — and `@/lib/db` builds its Prisma client the moment it is
// imported. This module puts a stand-in where db.ts looks FIRST
// (`globalThis.prisma`), so nothing in the bench ever opens a connection:
//
//   • every read answers empty (findMany → [], findFirst/findUnique → null,
//     count → 0), so translations fall back to English and the image library
//     and certificates are empty — exactly how a fresh database behaves;
//   • wash symbols are the one exception: findMany returns a placeholder
//     drawing per registered code, so a proof shows a symbol strip where the
//     layout places one instead of the production "missing" chips — which
//     would otherwise read to the agent as a broken output to fix;
//   • every write (and raw SQL, transactions) throws. The bench is read +
//     draft only, like the agent itself; a write reaching here is a bug.
//
// It must be installed before anything imports `@/lib/db`. fixture-tools.ts
// does that itself (it loads the renderer lazily, after installing), so a
// caller normally never touches this file. When a real client already exists
// in the process it is left alone.
//
// No imports on purpose: importing this must never pull in the database.
// =====================================================

const MARK = Symbol.for("prod-spec.change-requests.bench.offline-db");

export class OfflineDatabaseError extends Error {
  constructor(what: string) {
    super(`The change-request bench runs without a database: ${what} is not available.`);
    this.name = "OfflineDatabaseError";
  }
}

export type OfflineWashSymbol = {
  code: string;
  name?: string;
  // LaunderingAction as stored on WashSymbol.action (WASHING, BLEACHING, …).
  action?: string | null;
  restrictive?: boolean;
};

const washSymbols = new Map<string, Record<string, unknown>>();

// Add placeholder artwork for these codes. Codes already registered keep
// their first registration. Note the renderer caches the symbol map for 30 s,
// so register everything a run needs before its first render.
export function registerOfflineWashSymbols(symbols: readonly OfflineWashSymbol[]): void {
  for (const s of symbols) {
    const code = s.code.trim();
    if (!code || washSymbols.has(code)) continue;
    washSymbols.set(code, {
      id: `offline-${code}`,
      code,
      name: s.name ?? code,
      svg: placeholderSvg(code),
      mondayValue: null,
      action: s.action ?? null,
      restrictive: s.restrictive ?? /_no$/.test(code),
      active: true,
    });
  }
}

export type InstallResult = "installed" | "already-installed" | "real-client";

export function installOfflineDatabase(): InstallResult {
  const g = globalThis as { prisma?: unknown };
  if (g.prisma) return isOfflineDatabase(g.prisma) ? "already-installed" : "real-client";
  g.prisma = makeClient();
  return "installed";
}

export function isOfflineDatabase(client: unknown): boolean {
  return !!client && typeof client === "object" && (client as Record<symbol, unknown>)[MARK] === true;
}

// ── The stand-in ─────────────────────────────────────────────────────────────

const NO_OP_CLIENT_METHODS = new Set(["$connect", "$disconnect"]);

function makeClient(): unknown {
  const delegates = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === MARK) return true;
        // Not a thenable, not inspectable as anything special.
        if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
        if (NO_OP_CLIENT_METHODS.has(prop)) return async () => undefined;
        if (prop.startsWith("$")) {
          return () => {
            throw new OfflineDatabaseError(`db.${prop}`);
          };
        }
        let d = delegates.get(prop);
        if (!d) {
          d = makeDelegate(prop);
          delegates.set(prop, d);
        }
        return d;
      },
    },
  );
}

function makeDelegate(model: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        switch (prop) {
          case "findMany":
            return async () => rowsFor(model);
          case "groupBy":
            return async () => [];
          case "findFirst":
          case "findUnique":
            return async () => null;
          case "count":
            return async () => 0;
          case "aggregate":
            return async () => ({});
          default:
            return async () => {
              throw new OfflineDatabaseError(`db.${model}.${prop}`);
            };
        }
      },
    },
  );
}

function rowsFor(model: string): Record<string, unknown>[] {
  if (model === "washSymbol") return [...washSymbols.values()].map((r) => ({ ...r }));
  return [];
}

// A square with a short label — recognisably a stand-in, sized like the real
// artwork (the renderer scales every symbol to the block's font size).
function placeholderSvg(code: string): string {
  const label = code
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => (part.toLowerCase() === "no" ? "✕" : part[0].toUpperCase() + (part.match(/\d+/)?.[0] ?? "")))
    .join("")
    .slice(0, 4);
  const esc = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<rect x="1.5" y="1.5" width="21" height="21" rx="3" fill="#fff" stroke="#000" stroke-width="1.5"/>` +
    `<text x="12" y="15.5" font-family="Arial, Helvetica, sans-serif" font-size="8" font-weight="700" text-anchor="middle">${esc}</text>` +
    `</svg>`
  );
}
