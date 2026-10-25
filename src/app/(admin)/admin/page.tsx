import Link from "next/link";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { requireAdminPage } from "@/lib/auth-server";
import { activeStylesWhere } from "@/lib/styles/active-filter";

// =====================================================
// Admin oversight panel (/admin). One admin-only page, four tabs:
//   views      — full chronological log of who opened a style and when
//   approvals  — outputs currently approved (who/what/when)
//   rejections — rejection tickets with their message + a link to the output
//   gaps       — Customer × Business Area with active styles but no actively
//                generating prod spec (inactive OR missing)
// Each tab is its own async server component, so only the active tab queries.
// =====================================================

export const dynamic = "force-dynamic";

type TabKey = "users" | "views" | "approvals" | "rejections" | "gaps";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "users", label: "Users" },
  { key: "views", label: "Style views" },
  { key: "approvals", label: "Approvals" },
  { key: "rejections", label: "Rejections" },
  { key: "gaps", label: "Config gaps" },
];

function normalizeTab(raw: string | undefined): TabKey {
  return TABS.some((t) => t.key === raw) ? (raw as TabKey) : "users";
}

// Live-DB quirk: some BusinessArea rows are literally named "–". Treat those
// (and blanks) as "no real name" so they don't render as a junk business area.
function blankCheck(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v || v === "–" || v === "-" || v === "—") return null;
  return v;
}

export const metadata = { title: "Admin" };

export default async function AdminPanelPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireAdminPage();
  const tab = normalizeTab((await searchParams).tab);

  return (
    <div className="px-6 py-5">
      <h1 className="text-[18px] font-semibold tracking-[-0.01em]">Admin</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Oversight of the review flow — who looked at what, what they approved or rejected, and which
        customer / business-area combinations are taking in styles without a prod spec to generate them.
      </p>

      <nav className="mt-6 border-b border-line">
        <ul className="flex gap-5 overflow-x-auto">
          {TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={`/admin?tab=${t.key}`}
                className={`-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 text-[13px] transition-colors duration-150 ${
                  tab === t.key
                    ? "border-ink text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-6">
        {tab === "users" && <UsersTab />}
        {tab === "views" && <ViewsTab />}
        {tab === "approvals" && <ApprovalsTab />}
        {tab === "rejections" && <RejectionsTab />}
        {tab === "gaps" && <GapsTab />}
      </div>
    </div>
  );
}

// ---------- shared bits ----------

function TableShell({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-subtle text-left text-xs text-muted">
          {head}
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-muted">
        {children}
      </td>
    </tr>
  );
}

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {children}
    </span>
  );
}

function CustomerBA({ customer, ba }: { customer: string; ba: string | null }) {
  const baLabel = blankCheck(ba);
  return (
    <span className="text-muted">
      {customer}
      {baLabel ? <span className="text-faint"> · {baLabel}</span> : null}
    </span>
  );
}

// ---------- Tab · Users (presence) ----------

// Heartbeat pings every ~60s; treat "seen within 2 min" as online so a single
// missed ping (background tab, slow request) doesn't flip someone offline.
const ONLINE_WINDOW_MS = 2 * 60_000;

async function UsersTab() {
  const [users, presence] = await Promise.all([
    db.user.findMany({
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    }),
    // .catch keeps the tab alive before the user_presence table is deployed.
    db.userPresence.findMany({ select: { userId: true, lastSeenAt: true } }).catch(() => []),
  ]);

  const seenByUser = new Map(presence.map((p) => [p.userId, p.lastSeenAt]));
  const now = Date.now();
  const rows = users
    .map((u) => {
      const lastSeen = seenByUser.get(u.id) ?? null;
      const online = lastSeen != null && now - lastSeen.getTime() < ONLINE_WINDOW_MS;
      return { ...u, lastSeen, online };
    })
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0) ||
        (a.name || a.email).localeCompare(b.name || b.email),
    );
  const onlineCount = rows.filter((r) => r.online).length;

  return (
    <>
      <div className="mb-4 flex items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-good-soft px-2.5 py-1 font-medium text-good">
          <span className="inline-block h-2 w-2 rounded-full bg-good" />
          {onlineCount} online now
        </span>
        <span className="text-faint">
          of {rows.length} user{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <TableShell
        head={
          <tr>
            <th className="px-3 py-2">User</th>
            <th className="px-3 py-2">Role</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Last online</th>
            <th className="px-3 py-2">Member since</th>
          </tr>
        }
      >
        {rows.length === 0 ? (
          <EmptyRow colSpan={5}>No users yet.</EmptyRow>
        ) : (
          rows.map((u) => (
            <tr key={u.id} className="border-t border-line hover:bg-subtle">
              <td data-private className="px-3 py-2">
                <div className="text-ink">{u.name || "—"}</div>
                <div className="text-xs text-faint">{u.email}</div>
              </td>
              <td className="px-3 py-2">
                <Pill tone={u.role === "ADMIN" ? "bg-zinc-800 text-white" : "bg-zinc-100 text-zinc-600"}>
                  {u.role}
                </Pill>
              </td>
              <td className="px-3 py-2">
                {u.online ? (
                  <span className="inline-flex items-center gap-1.5 font-medium text-good">
                    <span className="inline-block h-2 w-2 rounded-full bg-good" />
                    Online
                  </span>
                ) : u.lastSeen ? (
                  <span className="text-muted">{timeAgo(u.lastSeen)}</span>
                ) : (
                  <span className="text-faint">Never seen</span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-muted">
                {u.lastSeen ? formatDate(u.lastSeen) : "—"}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-muted">{formatDate(u.createdAt)}</td>
            </tr>
          ))
        )}
      </TableShell>
    </>
  );
}

// ---------- Tab 1 · Style views ----------

async function ViewsTab() {
  // .catch keeps the panel alive before the style_views table is deployed.
  const views = await db.styleView
    .findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        user: { select: { name: true, email: true } },
        style: {
          select: {
            id: true,
            name: true,
            customer: { select: { name: true } },
            businessAreaRef: { select: { name: true } },
          },
        },
      },
    })
    .catch(() => []);

  return (
    <>
      <p className="mb-3 text-xs text-faint">
        Every open of a style page, newest first — one row per visit. Latest 200.
      </p>
      <TableShell
        head={
          <tr>
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">Who</th>
            <th className="px-3 py-2">Style</th>
            <th className="px-3 py-2">Customer · BA</th>
            <th className="px-3 py-2">Surface</th>
          </tr>
        }
      >
        {views.length === 0 ? (
          <EmptyRow colSpan={5}>
            No style views logged yet. Opens are recorded from now on.
          </EmptyRow>
        ) : (
          views.map((v) => (
            <tr key={v.id} className="border-t border-line hover:bg-subtle">
              <td className="whitespace-nowrap px-3 py-2 text-muted">{formatDate(v.createdAt)}</td>
              <td className="px-3 py-2 text-ink">{v.user.name || v.user.email}</td>
              <td className="px-3 py-2">
                <Link href={`/styles/${v.style.id}`} className="text-ink underline hover:text-ink">
                  {v.style.name}
                </Link>
              </td>
              <td className="px-3 py-2">
                <CustomerBA customer={v.style.customer.name} ba={v.style.businessAreaRef?.name ?? null} />
              </td>
              <td className="px-3 py-2">
                {v.surface === "REVIEW" ? (
                  <Pill tone="bg-blue-50 text-blue-700">Review</Pill>
                ) : (
                  <Pill tone="bg-zinc-100 text-zinc-600">Style</Pill>
                )}
              </td>
            </tr>
          ))
        )}
      </TableShell>
    </>
  );
}

// ---------- Tab 2 · Approvals ----------

async function ApprovalsTab() {
  // select (not include) on job so we never read Job.reviewEndedAt (additive
  // column that may not be deployed yet — the ColumnNotFound trap).
  const approvals = await db.jobAsset.findMany({
    where: { reviewStatus: "APPROVED" },
    orderBy: { reviewedAt: "desc" },
    take: 200,
    select: {
      id: true,
      docType: true,
      displayName: true,
      variantKey: true,
      reviewedAt: true,
      reviewedBy: { select: { name: true, email: true } },
      job: {
        select: {
          styleId: true,
          style: {
            select: {
              id: true,
              name: true,
              customer: { select: { name: true } },
              businessAreaRef: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  return (
    <>
      <p className="mb-3 text-xs text-faint">
        Outputs currently approved, newest first. A re-run replaces a style&rsquo;s outputs, so this
        reflects the latest approved state rather than a permanent event history. Latest 200.
      </p>
      <TableShell
        head={
          <tr>
            <th className="px-3 py-2">Approved</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">Output</th>
            <th className="px-3 py-2">Style</th>
            <th className="px-3 py-2">Customer · BA</th>
          </tr>
        }
      >
        {approvals.length === 0 ? (
          <EmptyRow colSpan={5}>No approved outputs yet.</EmptyRow>
        ) : (
          approvals.map((a) => (
            <tr key={a.id} className="border-t border-line hover:bg-subtle">
              <td className="whitespace-nowrap px-3 py-2 text-muted">{formatDate(a.reviewedAt)}</td>
              <td className="px-3 py-2 text-ink">
                {a.reviewedBy ? a.reviewedBy.name || a.reviewedBy.email : "—"}
              </td>
              <td className="px-3 py-2 text-ink">{a.displayName || a.docType}</td>
              <td className="px-3 py-2">
                {a.job?.style ? (
                  <Link
                    href={`/styles/${a.job.style.id}`}
                    className="text-ink underline hover:text-ink"
                  >
                    {a.job.style.name}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-3 py-2">
                {a.job?.style ? (
                  <CustomerBA
                    customer={a.job.style.customer.name}
                    ba={a.job.style.businessAreaRef?.name ?? null}
                  />
                ) : null}
              </td>
            </tr>
          ))
        )}
      </TableShell>
    </>
  );
}

// ---------- Tab 3 · Rejections ----------

const TICKET_TONE: Record<string, string> = {
  OPEN: "bg-amber-50 text-amber-800",
  IN_PROGRESS: "bg-blue-50 text-blue-700",
  FIXED: "bg-violet-50 text-violet-700",
  RESOLVED: "bg-emerald-50 text-emerald-700",
};

async function RejectionsTab() {
  const tickets = await db.rejectionTicket.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { reportedBy: { select: { name: true, email: true } } },
  });

  return (
    <>
      <p className="mb-3 text-xs text-faint">
        Every rejection ticket with the reviewer&rsquo;s message and a link to the output. Work them on
        the{" "}
        <Link href="/settings/rejection-log" className="underline">
          rejection log
        </Link>
        . Latest 200.
      </p>
      <TableShell
        head={
          <tr>
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">Output</th>
            <th className="px-3 py-2">Message</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Link</th>
          </tr>
        }
      >
        {tickets.length === 0 ? (
          <EmptyRow colSpan={6}>No rejections logged.</EmptyRow>
        ) : (
          tickets.map((t) => (
            <tr key={t.id} className="border-t border-line align-top hover:bg-subtle">
              <td className="whitespace-nowrap px-3 py-2 text-muted">{formatDate(t.createdAt)}</td>
              <td className="px-3 py-2 text-ink">{t.reportedBy.name || t.reportedBy.email}</td>
              <td className="px-3 py-2">
                <div className="text-ink">{t.outputName}</div>
                <div className="text-xs text-faint">{t.styleName}</div>
                <div className="mt-0.5">
                  <CustomerBA customer={t.customerName} ba={t.businessArea} />
                </div>
              </td>
              <td className="max-w-sm px-3 py-2 text-ink">
                <span className="line-clamp-3 whitespace-pre-wrap" title={t.comment}>
                  {t.comment}
                </span>
                {t.reopenedCount > 0 ? (
                  <span className="mt-1 block text-[11px] text-faint">reopened ×{t.reopenedCount}</span>
                ) : null}
              </td>
              <td className="px-3 py-2">
                <Pill tone={TICKET_TONE[t.status] ?? "bg-zinc-100 text-zinc-600"}>{t.status}</Pill>
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                <Link
                  href={`/styles/${t.styleId}/review`}
                  className="text-ink underline hover:text-ink"
                >
                  Output →
                </Link>
              </td>
            </tr>
          ))
        )}
      </TableShell>
    </>
  );
}

// ---------- Tab 4 · Config gaps ----------

async function GapsTab() {
  // Same active-style set the /styles list shows.
  const where = await activeStylesWhere();
  const [activeStyles, specs] = await Promise.all([
    db.style.findMany({
      where,
      select: {
        customerId: true,
        businessAreaId: true,
        businessArea: true,
        customer: { select: { name: true } },
        businessAreaRef: { select: { name: true } },
      },
    }),
    db.prodSpec.findMany({ select: { id: true, customerId: true, businessAreaId: true, active: true } }),
  ]);

  const specByKey = new Map(specs.map((p) => [`${p.customerId}|${p.businessAreaId}`, p]));

  type Group = {
    customerId: string;
    customerName: string;
    businessAreaId: string | null;
    baLabel: string;
    count: number;
  };
  const groups = new Map<string, Group>();
  for (const s of activeStyles) {
    const key = `${s.customerId}|${s.businessAreaId ?? "none"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    const baLabel =
      blankCheck(s.businessAreaRef?.name) ??
      blankCheck(s.businessArea) ??
      (s.businessAreaId ? "(unnamed business area)" : "(no business area)");
    groups.set(key, {
      customerId: s.customerId,
      customerName: s.customer.name,
      businessAreaId: s.businessAreaId,
      baLabel,
      count: 1,
    });
  }

  // Keep combos whose prod spec is missing or inactive (a combo with no
  // businessAreaId can never have a prod spec, so it's always "missing").
  const rows = [...groups.values()]
    .map((g) => {
      const spec = g.businessAreaId
        ? specByKey.get(`${g.customerId}|${g.businessAreaId}`) ?? null
        : null;
      return { ...g, spec };
    })
    .filter((g) => !g.spec || !g.spec.active)
    .sort((a, b) => b.count - a.count || a.customerName.localeCompare(b.customerName));

  return (
    <>
      <p className="mb-3 text-xs text-faint">
        Customer × business-area combinations with active styles but no actively-generating prod spec —
        styles are coming in, but nothing is being produced for them.
      </p>
      <TableShell
        head={
          <tr>
            <th className="px-3 py-2">Customer</th>
            <th className="px-3 py-2">Business area</th>
            <th className="px-3 py-2">Active styles</th>
            <th className="px-3 py-2">Prod spec</th>
            <th className="px-3 py-2">Action</th>
          </tr>
        }
      >
        {rows.length === 0 ? (
          <EmptyRow colSpan={5}>
            Every combination with active styles has an active prod spec. Nothing to flag.
          </EmptyRow>
        ) : (
          rows.map((g) => (
            <tr
              key={`${g.customerId}|${g.businessAreaId ?? "none"}`}
              className="border-t border-line hover:bg-subtle"
            >
              <td className="px-3 py-2 text-ink">{g.customerName}</td>
              <td className="px-3 py-2 text-ink">{g.baLabel}</td>
              <td className="px-3 py-2 tabular-nums text-ink">{g.count}</td>
              <td className="px-3 py-2">
                {g.spec ? (
                  <Pill tone="bg-amber-50 text-amber-800">Inactive</Pill>
                ) : (
                  <Pill tone="bg-rose-50 text-rose-700">Missing</Pill>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                {g.spec ? (
                  <Link href={`/prod-specs/${g.spec.id}`} className="text-ink underline hover:text-ink">
                    Open spec →
                  </Link>
                ) : (
                  <Link href="/prod-specs" className="text-ink underline hover:text-ink">
                    Create spec →
                  </Link>
                )}
              </td>
            </tr>
          ))
        )}
      </TableShell>
    </>
  );
}
