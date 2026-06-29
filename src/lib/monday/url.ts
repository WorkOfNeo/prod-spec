/**
 * Deep link to a Monday item (pulse) on its board.
 *
 * No account subdomain is stored anywhere in the app (only the API endpoint),
 * so we use the account-agnostic `monday.com/boards/<board>/pulses/<item>`
 * form — Monday redirects this to the logged-in account's workspace URL.
 *
 * `mondayBoardId` / `mondayItemId` on a Style point at the Pre-Order board item,
 * which is where the editable style fields (PO number, composition, wash care…)
 * live — i.e. exactly where a reviewer goes to fill a missing required field.
 */
export function mondayItemUrl(
  boardId: string | number | null | undefined,
  itemId: string | number | null | undefined,
): string | null {
  if (!boardId || !itemId) return null;
  return `https://monday.com/boards/${boardId}/pulses/${itemId}`;
}
