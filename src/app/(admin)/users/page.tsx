import { requireRole } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import {
  buildInviteLink,
  inviteStatus,
  isMissingInvitesTable,
  type InviteStatus,
} from "@/lib/invites/invites";
import { UsersTable, type UserRow } from "./users-table";
import { InvitePanel } from "./invite-panel";
import { InvitesTable, type InviteRow } from "./invites-table";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) {
    return (
      <div className="px-8 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Users &amp; invites</h1>
        <p className="mt-4 max-w-md rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This page is for admins. Ask an admin if you need someone added or removed.
        </p>
      </div>
    );
  }

  const users = await db.user.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });
  const userRows: UserRow[] = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    joinedLabel: formatDate(u.createdAt),
  }));

  // The invites table may not be migrated yet (code lands before
  // npm run db:deploy) — degrade to an explicit banner instead of a 500.
  let inviteRows: InviteRow[] = [];
  let migrationPending = false;
  try {
    const invites = await db.invite.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        invitedBy: { select: { name: true } },
        usedBy: { select: { name: true } },
      },
    });
    inviteRows = invites.map((inv) => {
      const status: InviteStatus = inviteStatus(inv);
      return {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        status,
        expiresLabel: formatDate(inv.expiresAt),
        invitedByName: inv.invitedBy.name,
        usedLabel: inv.usedAt ? `accepted ${formatDate(inv.usedAt)}` : null,
        // The working link only exists for a live invite — used/revoked/
        // expired rows get no copy target.
        link: status === "PENDING" ? buildInviteLink(inv.token) : null,
      };
    });
  } catch (err) {
    if (!isMissingInvitesTable(err)) throw err;
    migrationPending = true;
  }

  return (
    <div className="px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Users &amp; invites</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Who can access Prod Spec, and pending invitations. Signup is by invite only.
        </p>
      </div>

      {migrationPending && (
        <p className="mb-6 max-w-xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          The invites table is not migrated yet — run <code className="font-mono">npm run db:deploy</code>,
          then reload. Inviting is disabled until then; existing users are unaffected.
        </p>
      )}

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">People</h2>
        <UsersTable users={userRows} currentUserId={auth.userId} />
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Invite someone</h2>
        <InvitePanel disabled={migrationPending} />
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Invitations</h2>
        <InvitesTable invites={inviteRows} />
      </section>
    </div>
  );
}
