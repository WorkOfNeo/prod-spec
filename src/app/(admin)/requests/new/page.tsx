import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { MAX_IMAGES_PER_OUTPUT, MAX_IMAGES_TOTAL, MAX_OUTPUTS } from "@/lib/change-requests/requests";
import { NewRequestForm } from "./new-request-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "New request" };

// =====================================================
// /requests/new — report that a print output is wrong.
//
// Find the order, pick the outputs that are wrong (live thumbnails of what
// prints today), then say per output what should change, with screenshots. A
// pasted email can be split across the picked outputs. Sending files the
// request; nothing changes on a print file until an admin approves a change.
//
// Admins and reviewers (canReview, like /checks). Behind CHANGE_REQUESTS_ENABLED.
// The limits come from requests.ts (which the client can't import — it pulls
// in the database) so the form and the server agree on them.
// =====================================================

export default async function NewRequestPage() {
  if (!changeRequestsEnabled()) notFound();
  const { session, role } = await getSessionWithRole();
  if (!session) redirect("/login");
  if (!canReview(role)) redirect("/");

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link href="/requests" className="text-sm text-zinc-500 hover:text-zinc-900">
        ← Requests
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New request</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-500">
        Tell us which print output is wrong and how it should look. One issue per output — the assistant
        drafts each change on a copy for an admin to approve.
      </p>
      <div className="mt-6">
        <NewRequestForm
          limits={{
            maxOutputs: MAX_OUTPUTS,
            maxImagesPerOutput: MAX_IMAGES_PER_OUTPUT,
            maxImagesTotal: MAX_IMAGES_TOTAL,
          }}
        />
      </div>
    </div>
  );
}
