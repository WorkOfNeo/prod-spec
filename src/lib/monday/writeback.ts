import { db } from "@/lib/db";
import { changeItemValue } from "@/lib/monday/client";
import { getMondayWriteBackEnabled } from "@/lib/settings/app-settings";

// =====================================================
// The ONE place every outbound Monday status write goes through.
//
// Niels' rule: Monday write-backs are gated by a master switch
// (getMondayWriteBackEnabled, default OFF) and every write — applied OR
// suppressed — is logged with READABLE before→after values, not raw ids, so
// the Monday → Webhooks tab shows exactly "<item> <column>: <from> → <to>".
//
//   • switch ON  → changeItemValue() is sent, logged as APPLIED.
//   • switch OFF → nothing is sent, logged as SIMULATED ("would have set …").
//   • from === to → NOOP (logged, no call) so we never write a no-op.
//
// WEBHOOK RULE (CLAUDE.md): this only ever SETS a column value. It never
// creates, deletes, or recreates webhooks.
//
// Log rows are written to the `Log` table with the `monday.writeback` message
// prefix and a structured `payload` the Webhooks tab renders from. (jobId is
// optional — set it when the write belongs to a job.)
// =====================================================

export type WriteBackMode = "APPLIED" | "SIMULATED" | "FAILED" | "NOOP";

export type WriteBackResult = {
  mode: WriteBackMode;
  // True only when the value was really sent to Monday.
  applied: boolean;
  from: string | null;
  to: string;
  error?: string;
};

export type WriteBackInput = {
  boardId: string;
  itemId: string;
  columnId: string;
  // Target status label ("to").
  label: string;
  // Readable current label ("from"); caller supplies it (it already has it
  // from the subitem/item read). null ⇒ unknown, rendered as "—".
  currentLabel?: string | null;
  // Readable context for the log / UI.
  entity: string; // e.g. "01e. Label/Packaging layouts" or the style name
  boardLabel?: string; // "Styles" / "Pre Order"
  columnTitle?: string; // "Status"
  styleNumber?: string | null;
  jobId?: string | null;
};

export async function writeBackStatus(input: WriteBackInput): Promise<WriteBackResult> {
  const from = input.currentLabel ?? null;
  const to = input.label;
  const enabled = await getMondayWriteBackEnabled();

  let mode: WriteBackMode;
  let error: string | undefined;

  if (from !== null && from === to) {
    // Already at the target value — never write a no-op (and don't let a
    // same-value write trip Monday automations).
    mode = "NOOP";
  } else if (!enabled) {
    mode = "SIMULATED";
  } else {
    try {
      await changeItemValue({
        boardId: input.boardId,
        itemId: input.itemId,
        columnId: input.columnId,
        value: JSON.stringify({ label: to }),
      });
      mode = "APPLIED";
    } catch (err) {
      mode = "FAILED";
      error = (err as Error).message;
    }
  }

  const columnTitle = input.columnTitle ?? "Status";
  const verb =
    mode === "APPLIED"
      ? "set"
      : mode === "SIMULATED"
        ? "WOULD set (write-backs off)"
        : mode === "NOOP"
          ? "no change"
          : "FAILED to set";
  await db.log.create({
    data: {
      jobId: input.jobId ?? null,
      level: mode === "FAILED" ? "WARN" : "INFO",
      message:
        `monday.writeback ${mode} board=${input.boardId} item=${input.itemId} ` +
        `"${input.entity}" ${columnTitle} ${verb}: "${from ?? "—"}" -> "${to}"` +
        (error ? ` · ${error}` : ""),
      payload: {
        kind: "writeback",
        mode,
        applied: mode === "APPLIED",
        from,
        to,
        entity: input.entity,
        boardLabel: input.boardLabel ?? null,
        boardId: input.boardId,
        itemId: input.itemId,
        columnId: input.columnId,
        columnTitle,
        styleNumber: input.styleNumber ?? null,
        error: error ?? null,
      },
    },
  });

  return { mode, applied: mode === "APPLIED", from, to, error };
}
