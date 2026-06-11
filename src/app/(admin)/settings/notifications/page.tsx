import { db } from "@/lib/db";
import { emailSendingEnabled } from "@/lib/email/dispatch";
import { emailFromAddress } from "@/lib/email/client";
import {
  getReviewNotificationEmails,
  getStoredReviewNotificationEmails,
} from "@/lib/settings/app-settings";
import { ReviewNotificationEmailSetting } from "./review-notification-email-setting";
import { EmailActivityTable, type EmailActivityRow } from "./email-activity-table";
import { requireAdminPage } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

const WHEN_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

// Notifications — who gets the post-generation emails, whether sending is
// live or simulated (RESEND_EMAILS), and the activity log of every email
// attempt. Background generations (webhook / cron) have no UI to pop a
// simulation dialog in; this table is where those sends surface.
export default async function NotificationsSettingsPage() {
  await requireAdminPage();

  const [storedEmails, resolvedEmails, logs] = await Promise.all([
    getStoredReviewNotificationEmails(),
    getReviewNotificationEmails(),
    db.emailLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        type: true,
        status: true,
        to: true,
        cc: true,
        subject: true,
        styleId: true,
        createdAt: true,
      },
    }),
  ]);

  const sendingLive = emailSendingEnabled();
  const resendConfigured = Boolean(process.env.RESEND_API_KEY);
  const fromAddress = emailFromAddress();
  const envFallback = (process.env.REVIEW_NOTIFICATION_EMAIL ?? "").trim();

  const rows: EmailActivityRow[] = logs.map((l) => ({
    id: l.id,
    type: l.type,
    status: l.status,
    to: l.to,
    cc: l.cc,
    subject: l.subject,
    styleId: l.styleId,
    whenLabel: WHEN_FORMAT.format(l.createdAt),
  }));

  return (
    <div className="px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500">
        Who gets notified when outputs are generated, and a log of every email — sent or simulated.
      </p>

      <div className="mt-4 max-w-2xl">
        {sendingLive && resendConfigured ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            <strong>✓ Live mode</strong> — <code className="text-xs">RESEND_EMAILS=true</code>; emails are
            really sent via Resend from <code className="text-xs">{fromAddress}</code>.
          </div>
        ) : sendingLive ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
            <strong>⚠ Sending is on but Resend is not configured</strong> — set{" "}
            <code className="text-xs">RESEND_API_KEY</code>. Emails are currently recorded as SKIPPED,
            not sent.
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <strong>⚠ Simulation mode</strong> — <code className="text-xs">RESEND_EMAILS</code> is not{" "}
            <code className="text-xs">&quot;true&quot;</code>. No emails are sent; every send is recorded
            below and shown as a popup when triggered from the UI.
          </div>
        )}
      </div>

      <div className="mt-4 grid max-w-2xl gap-4">
        <ReviewNotificationEmailSetting
          initialEmails={storedEmails.join(", ")}
          resolvedEmails={resolvedEmails.join(", ")}
          envFallback={envFallback}
        />
      </div>

      <div className="mt-6 max-w-5xl">
        <h2 className="text-sm font-semibold text-zinc-900">
          Email activity <span className="ml-1 font-normal text-zinc-400">last {rows.length}</span>
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Every outbound email attempt. <strong>View</strong> opens the full body and attachment list —
          for simulated emails that is exactly what would have been sent.
        </p>
        <EmailActivityTable rows={rows} />
      </div>
    </div>
  );
}
