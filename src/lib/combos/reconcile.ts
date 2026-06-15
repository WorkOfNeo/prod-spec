import { db } from "@/lib/db";
import { activeStylesWhere } from "@/lib/styles/active-filter";
import { dispatchEmail } from "@/lib/email/dispatch";
import { newComboEmail } from "@/lib/email/templates/new-combo";
import { BLANK_BA_VALUES } from "@/lib/import/heuristics";

// Heads-up recipient for newcomer combos. Hardcoded for v1 (the feature was
// scoped to nh@neo-labs.com); swap for an AppSetting accessor later if it
// needs to be operator-configurable (mirror getReviewNotificationEmails).
const COMBO_ALERT_TO = "nh@neo-labs.com";
const NO_BA_LABEL = "— no business area —";

export type ComboReconcileResult = {
  activeCombos: number; // distinct combos among active styles right now
  created: number; // combo rows created this pass (newcomers, or the baseline seed)
  notified: number; // newcomer alert emails staged this pass
  deactivated: number; // combos that dropped to 0 active styles this pass
  baseline: boolean; // first-ever run — registry was empty, seeded without alerts
};

function baseUrl(): string {
  return process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
}

// Prisma's unique-constraint error code. Checked duck-typed so we don't have
// to import the generated error class (the codebase doesn't elsewhere).
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

// The stable discriminator key + display label for a style's business area.
// A resolved BA (businessAreaId) wins over free text; blank Monday markers
// collapse into the single "no business area" bucket so en/em-dash
// placeholders don't spawn junk combos. NOTE: a mirrored BusinessArea can
// itself be named with a blank marker ("–") — Monday's "no BA selected"
// option mirrored as a real row — so a resolved BA whose name is blank is
// also treated as "no business area" (seen on the live data: many JYSK
// styles resolve to a BusinessArea literally named "–").
export function comboKeyFor(s: {
  businessAreaId: string | null;
  businessAreaName: string | null;
  businessArea: string | null;
}): { baKey: string; baLabel: string; businessAreaId: string | null } {
  if (s.businessAreaId) {
    const name = (s.businessAreaName ?? "").trim();
    if (name && !BLANK_BA_VALUES.has(name)) {
      return { baKey: s.businessAreaId, baLabel: name, businessAreaId: s.businessAreaId };
    }
    // Resolved but blank-named → fall through to the no-business-area bucket.
  }
  const ft = (s.businessArea ?? "").trim();
  if (ft && !BLANK_BA_VALUES.has(ft)) {
    return {
      baKey: `freetext:${ft.toLowerCase().replace(/\s+/g, " ")}`,
      baLabel: ft,
      businessAreaId: null,
    };
  }
  return { baKey: "none", baLabel: NO_BA_LABEL, businessAreaId: null };
}

type ComboAgg = {
  customerId: string;
  customerName: string;
  businessAreaId: string | null;
  baKey: string;
  baLabel: string;
  count: number;
  exampleStyleId: string;
};

// Recompute the active-combo set, upsert the registry, and stage a heads-up
// email for genuine newcomers. Idempotent and concurrency-safe (overlapping
// syncs never double-create a row or double-send an alert), so it is safe to
// run on every style sync as well as the standalone detect-combos cron.
export async function reconcileCustomerBusinessAreaCombos(): Promise<ComboReconcileResult> {
  // First-ever run? Seed the current landscape as the baseline — REVIEWED,
  // already-notified, no emails — so the feature doesn't blast an alert for
  // every pre-existing combo. History is retained (rows are never deleted),
  // so the registry is empty only once and this branch fires only once.
  const baseline = (await db.customerBusinessAreaCombo.count()) === 0;

  const where = await activeStylesWhere();
  const styles = await db.style.findMany({
    where,
    select: {
      id: true,
      customerId: true,
      businessAreaId: true,
      businessArea: true,
      customer: { select: { name: true } },
      businessAreaRef: { select: { name: true } },
    },
  });

  // Aggregate into distinct (customer, baKey) combos with a live count + one
  // example style for the dashboard deep link.
  const byKey = new Map<string, ComboAgg>();
  for (const s of styles) {
    const { baKey, baLabel, businessAreaId } = comboKeyFor({
      businessAreaId: s.businessAreaId,
      businessAreaName: s.businessAreaRef?.name ?? null,
      businessArea: s.businessArea,
    });
    const mapKey = `${s.customerId}::${baKey}`;
    const existing = byKey.get(mapKey);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(mapKey, {
        customerId: s.customerId,
        customerName: s.customer.name,
        businessAreaId,
        baKey,
        baLabel,
        count: 1,
        exampleStyleId: s.id,
      });
    }
  }

  const now = new Date();
  const result: ComboReconcileResult = {
    activeCombos: byKey.size,
    created: 0,
    notified: 0,
    deactivated: 0,
    baseline,
  };
  const seenIds: string[] = [];

  for (const c of byKey.values()) {
    let comboId: string;
    try {
      const created = await db.customerBusinessAreaCombo.create({
        data: {
          customerId: c.customerId,
          businessAreaId: c.businessAreaId,
          baKey: c.baKey,
          baLabel: c.baLabel,
          customerName: c.customerName,
          activeStyleCount: c.count,
          exampleStyleId: c.exampleStyleId,
          firstSeenAt: now,
          lastSeenAt: now,
          status: baseline ? "REVIEWED" : "NEW",
          notifiedAt: baseline ? now : null,
        },
        select: { id: true },
      });
      comboId = created.id;
      result.created += 1;
    } catch (err) {
      // Lost a create race with a concurrent sync (unique customerId+baKey)
      // → fall through to an update. Anything else is a real error.
      if (!isUniqueViolation(err)) throw err;
      const updated = await db.customerBusinessAreaCombo.update({
        where: { customerId_baKey: { customerId: c.customerId, baKey: c.baKey } },
        data: {
          baLabel: c.baLabel,
          customerName: c.customerName,
          businessAreaId: c.businessAreaId,
          activeStyleCount: c.count,
          exampleStyleId: c.exampleStyleId,
          lastSeenAt: now,
        },
        select: { id: true },
      });
      comboId = updated.id;
    }
    seenIds.push(comboId);

    // Notify exactly once, ever. The atomic claim (updateMany guarded on
    // notifiedAt: null) means two overlapping syncs can never both send —
    // the same idempotency trick as markStyleArchived. Skipped on baseline
    // (those rows are created already-notified). The email is staged, not
    // forced, so it surfaces on /settings/notifications for a manual send.
    if (!baseline) {
      const claim = await db.customerBusinessAreaCombo.updateMany({
        where: { id: comboId, notifiedAt: null },
        data: { notifiedAt: now },
      });
      if (claim.count === 1) {
        const email = newComboEmail({
          customerName: c.customerName,
          businessArea: c.baLabel,
          activeStyleCount: c.count,
          comboUrl: `${baseUrl()}/combos`,
        });
        await dispatchEmail({
          type: "NEW_COMBO",
          to: COMBO_ALERT_TO,
          subject: email.subject,
          html: email.html,
          text: email.text,
          styleId: c.exampleStyleId,
        });
        result.notified += 1;
      }
    }
  }

  // History: any previously-active combo not seen this pass drops to 0 but
  // the row (firstSeenAt / notifiedAt / reviewedAt) is kept, so a combo that
  // reappears later is never re-alerted. An empty seen-set means no active
  // combos at all → every count>0 row is zeroed.
  const deact = await db.customerBusinessAreaCombo.updateMany({
    where: {
      activeStyleCount: { gt: 0 },
      ...(seenIds.length > 0 ? { id: { notIn: seenIds } } : {}),
    },
    data: { activeStyleCount: 0 },
  });
  result.deactivated = deact.count;

  return result;
}
