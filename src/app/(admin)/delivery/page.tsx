import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Delivery to suppliers" };

// =====================================================
// "Did every approved document actually reach the supplier?" — one row per
// PURCHASE ORDER.
//
// This is the only surface in the app whose unit is the PO folder, and that is
// the point. Everything else is keyed on a style: /settings/style-dashboard,
// the style page's own folder panel, the supplier-send queue. A style-keyed
// view cannot answer "are ALL files delivered", because the case it structurally
// cannot show you is a style with NOTHING uploaded — you would have to already
// suspect that style to open it. On the live PO that prompted this screen, two
// styles looked fine and a third had zero files in the folder.
//
// Rows come from PoDeliveryCheck, written by the /api/cron/po-delivery sweep.
// They are NOT computed here: answering the question costs ~5 sequential Graph
// calls per folder plus a current-outputs walk per style on it, and a few
// hundred folders would make this page unusable. The detail page re-checks live
// before it repairs anything, so a stale row can never be what a repair acts on.
// =====================================================

type SP = { show?: string };

// A snapshot whose folder could not be listed is NOT evidence of anything — a
// 403 or a throttle must never read as "nothing was delivered". These rows get
// their own bucket instead of a scary 0-of-N.
const LISTABLE = new Set(["ok", "subfolder-missing"]);

export default async function DeliveryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  if (!canReview(role)) redirect("/");

  const sp = await searchParams;
  const show = sp.show === "all" ? "all" : sp.show === "done" ? "done" : "problems";

  // One indexed read. Ordered by PO descending (poSeq, the parsed number —
  // never the poNumber string, see table-sort.ts) so the newest orders lead.
  //
  // P2021 = the table isn't there yet. Railway runs `prisma migrate deploy`
  // before `npm start`, so this should never fire — but a migration that failed
  // while the container still served would otherwise turn a brand-new page into
  // a 500 on a screen whose whole job is to reassure. An empty list that says
  // "nothing checked yet" is the honest answer either way.
  const rows = await db.poDeliveryCheck
    .findMany({
      orderBy: [{ poSeq: { sort: "desc", nulls: "last" } }, { poNumber: "desc" }],
      take: 500,
    })
    .catch((err: unknown) => {
      if (!!err && typeof err === "object" && (err as { code?: string }).code === "P2021") return [];
      throw err;
    });

  const unresolvable = rows.filter((r) => !LISTABLE.has(r.state));
  const listable = rows.filter((r) => LISTABLE.has(r.state));
  const problems = listable.filter((r) => !r.fullyDelivered);
  const done = listable.filter((r) => r.fullyDelivered);

  const shown = show === "all" ? rows : show === "done" ? done : problems;

  const totalExpected = listable.reduce((a, r) => a + r.expectedDocs, 0);
  const totalDelivered = listable.reduce((a, r) => a + r.deliveredDocs, 0);
  const totalCollisions = listable.reduce((a, r) => a + r.collisionDocs, 0);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Delivery to suppliers</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500">
            One row per purchase order — every approved document for the PO, checked against what is
            actually in the supplier&apos;s <span className="font-medium">APPROVED LAYOUTS</span> folder. The
            folder belongs to the PO, not to a style, so this is the only place a style with nothing
            uploaded is visible.
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
          Nothing checked yet. The <code className="text-xs">po-delivery</code> cron fills this in — it
          rotates through the PO folders least-recently-checked first, so the list builds up over the
          first day.
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-4">
            <Stat label="Documents delivered" value={`${totalDelivered} of ${totalExpected}`} />
            <Stat label="POs with a shortfall" value={String(problems.length)} tone={problems.length > 0 ? "warn" : "ok"} />
            <Stat
              label="Can't land (name clash)"
              value={String(totalCollisions)}
              tone={totalCollisions > 0 ? "bad" : "ok"}
              hint="Two documents want one file name"
            />
            <Stat label="Folders unreadable" value={String(unresolvable.length)} tone={unresolvable.length > 0 ? "warn" : "ok"} />
          </div>

          <nav className="mt-6 flex flex-wrap gap-1 border-b border-zinc-200 text-sm">
            <Tab href="/delivery" active={show === "problems"} label={`Needs attention (${problems.length})`} />
            <Tab href="/delivery?show=done" active={show === "done"} label={`Fully delivered (${done.length})`} />
            <Tab href="/delivery?show=all" active={show === "all"} label={`All (${rows.length})`} />
          </nav>

          {shown.length === 0 ? (
            <p className="mt-6 text-sm text-zinc-500">
              {show === "problems"
                ? "✓ Every checked PO has all of its approved documents in the supplier's folder."
                : "Nothing here yet."}
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[52rem] border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                    <Th>PO</Th>
                    <Th>Supplier</Th>
                    <Th className="text-right">Styles</Th>
                    <Th className="text-right">Delivered</Th>
                    <Th>What&apos;s outstanding</Th>
                    <Th className="text-right">Checked</Th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const listableRow = LISTABLE.has(r.state);
                    const pct = r.expectedDocs > 0 ? Math.round((r.deliveredDocs / r.expectedDocs) * 100) : 0;
                    return (
                      <tr key={r.id} className="border-t border-zinc-100 align-top">
                        <Td className="whitespace-nowrap">
                          <Link
                            href={`/delivery/${encodeURIComponent(r.poNumber)}?supplier=${r.supplierId}`}
                            className="font-medium text-zinc-900 underline decoration-zinc-300 hover:decoration-zinc-900"
                          >
                            {r.poNumber}
                          </Link>
                        </Td>
                        <Td className="max-w-[16rem] truncate text-zinc-600">{r.supplierName ?? "—"}</Td>
                        <Td className="text-right tabular-nums text-zinc-600">{r.styleCount}</Td>
                        <Td className="whitespace-nowrap text-right tabular-nums">
                          {listableRow ? (
                            <span className={r.fullyDelivered ? "text-emerald-700" : "font-medium text-amber-700"}>
                              {r.deliveredDocs} / {r.expectedDocs}
                              <span className="ml-1 text-xs text-zinc-400">{pct}%</span>
                            </span>
                          ) : (
                            <span className="text-zinc-400">—</span>
                          )}
                        </Td>
                        <Td className="text-xs">
                          {!listableRow ? (
                            <span className="text-amber-700">⚠ {r.message}</span>
                          ) : r.fullyDelivered ? (
                            <span className="text-emerald-700">✓ complete</span>
                          ) : (
                            <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                              {r.missingDocs > 0 ? <Chip tone="bad">{r.missingDocs} missing</Chip> : null}
                              {r.collisionDocs > 0 ? (
                                <Chip tone="bad">{r.collisionDocs} can&apos;t land — name clash</Chip>
                              ) : null}
                              {r.renamedDocs > 0 ? <Chip tone="warn">{r.renamedDocs} under an old name</Chip> : null}
                              {r.staleFiles > 0 ? <Chip tone="mute">{r.staleFiles} old file(s) to clear</Chip> : null}
                              {r.strayFiles > 0 ? <Chip tone="mute">{r.strayFiles} not ours</Chip> : null}
                            </span>
                          )}
                        </Td>
                        <Td className="text-right text-xs whitespace-nowrap text-zinc-400">
                          {r.checkedAt.toISOString().slice(0, 16).replace("T", " ")}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "ok", hint }: { label: string; value: string; tone?: "ok" | "warn" | "bad"; hint?: string }) {
  const colour = tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-zinc-900";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-0.5 text-xl font-semibold tabular-nums ${colour}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-zinc-400">{hint}</div> : null}
    </div>
  );
}

function Tab({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`-mb-px border-b-2 px-3 py-2 ${
        active ? "border-zinc-900 font-medium text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800"
      }`}
    >
      {label}
    </Link>
  );
}

function Chip({ tone, children }: { tone: "bad" | "warn" | "mute"; children: React.ReactNode }) {
  const cls =
    tone === "bad"
      ? "bg-red-50 text-red-700"
      : tone === "warn"
        ? "bg-amber-50 text-amber-800"
        : "bg-zinc-100 text-zinc-500";
  return <span className={`rounded px-1.5 py-0.5 ${cls}`}>{children}</span>;
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`pb-2 pr-3 font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-2 pr-3 ${className}`}>{children}</td>;
}
