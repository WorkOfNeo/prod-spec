import type { UserRole } from "@/generated/prisma/enums";

// Who may approve/reject during review. Reviewing is the REVIEWER role's
// whole job, and ADMINs can do everything — any other (future) role is
// refused at the decision endpoints, not merely hidden in the sidebar.
// Kept pure (type-only import) so the API gate is unit-testable without a
// session, a DB, or the Next runtime.
export function canReview(role: UserRole | null): boolean {
  return role === "ADMIN" || role === "REVIEWER";
}

// Who may trigger ADMIN-only mutations (queue drains, manual re-runs, the
// rejection-ticket workbench). REVIEWERs can approve/reject but must not be
// able to kick off generation or fix tickets — gated at the API, not merely
// hidden in the UI. Kept pure for the same unit-testable reasons as canReview.
export function isAdmin(role: UserRole | null): boolean {
  return role === "ADMIN";
}
