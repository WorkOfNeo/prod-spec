"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FacetFilter } from "@/components/facet-filter";
import { useUrlSearchState } from "@/lib/use-url-search-state";
import type { BoardPo, BoardGroupRow, BoardStyleRow } from "@/lib/carton-groups/board";
import { MultiStyleCartonDialog } from "./multi-style-carton-dialog";

// The board's client half: search, facets, and the two actions a reviewer
// takes here (group several styles into one carton; ungroup one).
//
// Everything on screen is deliberately spelled out. The people working this
// board follow written instructions rather than infer intent, so every
// destructive or irreversible step states what will happen in full sentences
// BEFORE it happens, and the one step we cannot do for them — deleting a file
// out of SharePoint — is named with the exact file.

type Status = "APPROVED" | "PENDING_REVIEW" | "REJECTED";

const STATUS_LABEL: Record<Status, string> = {
  APPROVED: "Approved",
  PENDING_REVIEW: "Pending review",
  REJECTED: "Rejected",
};

function StatusPill({ status }: { status: Status | null }) {
  if (!status) return <span className="text-xs text-zinc-400">—</span>;
  const cls =
    status === "APPROVED"
      ? "bg-green-100 text-green-800"
      : status === "REJECTED"
        ? "bg-red-100 text-red-800"
        : "bg-amber-100 text-amber-800";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function UploadPill({ at }: { at: string | null }) {
  if (!at) {
    return (
      <span className="inline-flex rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500">
        Not uploaded
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800">
      Uploaded {at.slice(0, 16).replace("T", " ")}
    </span>
  );
}

export function CartonMarkingBoard({
  pos,
  truncated,
  cap,
}: {
  pos: BoardPo[];
  truncated: boolean;
  cap: number;
}) {
  const router = useRouter();
  const [q, setQ] = useUrlSearchState("q");
  const [customers, setCustomers] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [uploads, setUploads] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [wizardPo, setWizardPo] = useState<BoardPo | null>(null);
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);

  const customerOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const po of pos) {
      counts.set(po.customerName, (counts.get(po.customerName) ?? 0) + po.styles.length);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [pos]);

  const needle = q.trim().toLowerCase();

  const filtered = useMemo(() => {
    const matchesText = (hay: string[]) =>
      !needle || hay.join(" ").toLowerCase().includes(needle);

    return pos
      .filter((po) => customers.length === 0 || customers.includes(po.customerName))
      .map((po) => {
        const styles = po.styles.filter((s) => {
          if (kinds.length && !kinds.includes("single")) return false;
          if (statuses.length && !statuses.includes(s.reviewStatus)) return false;
          if (uploads.length) {
            const key = s.spUploadedAt ? "uploaded" : "not-uploaded";
            if (!uploads.includes(key)) return false;
          }
          return matchesText([
            po.poNumber,
            po.customerName,
            po.supplierName ?? "",
            s.styleNumber,
            s.styleName,
            s.colourName,
            s.cartonEan ?? "",
            s.fileName,
          ]);
        });

        const groups = po.groups.filter((g) => {
          if (kinds.length && !kinds.includes("grouped")) return false;
          if (statuses.length && (!g.reviewStatus || !statuses.includes(g.reviewStatus))) {
            return false;
          }
          if (uploads.length) {
            const key = g.spUploadedAt ? "uploaded" : "not-uploaded";
            if (!uploads.includes(key)) return false;
          }
          return matchesText([
            po.poNumber,
            po.customerName,
            po.supplierName ?? "",
            g.fileName,
            ...g.members.map((m) => `${m.styleNumber} ${m.colourName}`),
          ]);
        });

        // Removed-group notices are not filtered by status or upload state:
        // they are a standing instruction ("this file still needs deleting"),
        // not a row of work, and hiding one behind a filter would lose it.
        const removedGroups = po.removedGroups.filter((g) =>
          matchesText([po.poNumber, po.customerName, g.fileName]),
        );

        return { ...po, styles, groups, removedGroups };
      })
      .filter((po) => po.styles.length + po.groups.length + po.removedGroups.length > 0);
  }, [pos, needle, customers, statuses, uploads, kinds]);

  const shown = filtered.reduce((n, po) => n + po.styles.length + po.groups.length, 0);

  async function ungroup(po: BoardPo, group: BoardGroupRow) {
    const reason = window.prompt(
      group.removedFileWasUploaded
        ? [
            "STOP AND READ.",
            "",
            `This carton marking was already uploaded to the supplier's SharePoint folder.`,
            "",
            "Removing the grouping here does NOT delete the file. The supplier still has it and can still print it.",
            "",
            "Type the reason you are removing it:",
          ].join("\n")
        : [
            "Remove this multi-style carton grouping?",
            "",
            "It was never uploaded to SharePoint, so nothing leaves your hands.",
            "The individual carton markings are not affected — they were never changed.",
            "",
            "Type the reason you are removing it:",
          ].join("\n"),
    );
    if (reason === null) return;
    if (!reason.trim()) {
      window.alert("Nothing was removed — a reason is required.");
      return;
    }

    setBusyGroupId(group.id);
    try {
      const res = await fetch(`/api/admin/carton-groups/${group.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = (await res.json()) as {
        error?: string;
        fileName?: string;
        wasUploaded?: boolean;
      };
      if (!res.ok) {
        window.alert(body.error ?? "Could not remove the carton group.");
        return;
      }

      // The one instruction that matters, on its own, naming the exact file.
      // We do not delete supplier files and we do not email the supplier — the
      // reviewer does this by hand or it does not happen.
      if (body.wasUploaded) {
        window.alert(
          [
            "NOW DO THIS — the file is still in SharePoint.",
            "",
            `1. Open the SharePoint folder for PO ${po.poNumber}.`,
            "2. Find this file:",
            "",
            `        ${body.fileName}`,
            "",
            "3. Delete it.",
            "",
            "We cannot delete it for you. Until you delete it, the supplier can still print this carton marking.",
            "",
            `Use the "Open PO folder" button at the top of PO ${po.poNumber} to get there.`,
          ].join("\n"),
        );
      }
      router.refresh();
    } finally {
      setBusyGroupId(null);
    }
  }

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search PO, style number, style name, customer, supplier, barcode…"
          className="min-w-64 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
        />
        <FacetFilter
          label="Customer"
          options={customerOptions}
          selected={customers}
          onChange={setCustomers}
        />
        <FacetFilter
          label="Status"
          options={[
            { value: "APPROVED", label: "Approved", count: 0 },
            { value: "PENDING_REVIEW", label: "Pending review", count: 0 },
            { value: "REJECTED", label: "Rejected", count: 0 },
          ]}
          selected={statuses}
          onChange={setStatuses}
        />
        <FacetFilter
          label="SharePoint"
          options={[
            { value: "uploaded", label: "Uploaded", count: 0 },
            { value: "not-uploaded", label: "Not uploaded", count: 0 },
          ]}
          selected={uploads}
          onChange={setUploads}
        />
        <FacetFilter
          label="Carton type"
          options={[
            { value: "grouped", label: "Multi-style carton", count: 0 },
            { value: "single", label: "Single style", count: 0 },
          ]}
          selected={kinds}
          onChange={setKinds}
        />
        {(needle.length > 0 ||
          customers.length > 0 ||
          statuses.length > 0 ||
          uploads.length > 0 ||
          kinds.length > 0) && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              setCustomers([]);
              setStatuses([]);
              setUploads([]);
              setKinds([]);
            }}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50"
          >
            Clear
          </button>
        )}
      </div>

      <p className="mt-3 mb-4 text-sm text-zinc-500">
        {shown} carton marking{shown === 1 ? "" : "s"} shown
        {truncated && (
          <span className="ml-2 text-amber-700">
            · showing the {cap} most recent only — narrow the search to see older ones
          </span>
        )}
      </p>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500">
          Nothing matches.
        </div>
      ) : (
        filtered.map((po) => (
          <PoCard
            key={po.poNumber}
            po={po}
            busyGroupId={busyGroupId}
            onUngroup={(g) => void ungroup(po, g)}
            onOpenWizard={() => setWizardPo(po)}
          />
        ))
      )}

      {wizardPo && (
        <MultiStyleCartonDialog
          po={wizardPo}
          onClose={() => setWizardPo(null)}
          onCreated={() => {
            setWizardPo(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function PoCard({
  po,
  busyGroupId,
  onUngroup,
  onOpenWizard,
}: {
  po: BoardPo;
  busyGroupId: string | null;
  onUngroup: (g: BoardGroupRow) => void;
  onOpenWizard: () => void;
}) {
  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center gap-4 border-b border-zinc-200 bg-zinc-50 px-5 py-3">
        <div>
          <div className="text-sm font-semibold">
            PO {po.poNumber} · {po.customerName}
          </div>
          <div className="text-xs text-zinc-500">
            {po.supplierName ?? "No supplier"} · {po.styles.length} style
            {po.styles.length === 1 ? "" : "s"}
            {po.lastUploadedAt
              ? ` · last upload ${po.lastUploadedAt.slice(0, 16).replace("T", " ")}`
              : " · nothing uploaded yet"}
          </div>
        </div>
        <div className="flex-1" />
        {po.folderUrl && (
          <a
            href={po.folderUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
          >
            Open PO folder
          </a>
        )}
        <button
          type="button"
          onClick={onOpenWizard}
          className="rounded-md bg-violet-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-800"
        >
          Multiple styles in Carton
        </button>
      </div>

      {po.groups.map((g) => (
        <div
          key={g.id}
          id={`group-${g.id}`}
          className="m-4 rounded-lg border border-violet-200 bg-violet-50 p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex rounded-full bg-violet-200 px-2 py-0.5 text-xs font-semibold text-violet-900">
              MULTI-STYLE CARTON
            </span>
            <span className="text-sm font-semibold text-violet-900">
              {g.members.length} styles packed in one box
            </span>
          </div>
          <div className="mt-1 text-xs text-zinc-600">
            Created by {g.createdByName ?? "someone"} on{" "}
            {g.createdAt.slice(0, 16).replace("T", " ")}
            {g.totalCartons ? ` · ${g.totalCartons} cartons` : ""}
          </div>
          <div className="mt-1 text-xs text-zinc-600">
            File: <span className="font-mono">{g.fileName}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {g.members.map((m) => (
              <span
                key={m.styleId}
                className="rounded border border-violet-200 bg-white px-2 py-0.5 text-xs"
              >
                {m.styleNumber} {m.colourName}
                {m.slot === 1 ? " · main" : ""}
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusPill status={g.reviewStatus} />
            <UploadPill at={g.spUploadedAt} />
            <div className="flex-1" />
            {g.spFileUrl && (
              <a
                href={g.spFileUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
              >
                Open file
              </a>
            )}
            <button
              type="button"
              disabled={busyGroupId === g.id}
              onClick={() => onUngroup(g)}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50"
            >
              {busyGroupId === g.id ? "Removing…" : "Ungroup"}
            </button>
          </div>
        </div>
      ))}

      {po.removedGroups.map((g) => (
        <div
          key={g.id}
          className="mx-4 mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600"
        >
          A multi-style carton marking ({g.members.map((m) => m.styleNumber).join(" + ")}) was
          removed by {g.removedByName ?? "someone"} on{" "}
          {g.removedAt?.slice(0, 16).replace("T", " ")}.{" "}
          {g.removedFileWasUploaded ? (
            <>
              Delete <span className="font-mono">{g.fileName}</span> from the supplier&apos;s
              SharePoint folder if it has not been done already.
            </>
          ) : (
            <>It was never uploaded, so there is nothing to delete.</>
          )}
          {g.removedReason && (
            <div className="mt-1 italic text-zinc-500">Reason given: “{g.removedReason}”</div>
          )}
        </div>
      ))}

      {po.styles.length > 0 && (
        <table className="w-full text-sm">
          <thead className="bg-white text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2 font-semibold">Style</th>
              <th className="px-4 py-2 font-semibold">Colour</th>
              <th className="px-4 py-2 font-semibold">Carton barcode</th>
              <th className="px-4 py-2 font-semibold">Status</th>
              <th className="px-4 py-2 font-semibold">SharePoint</th>
              <th className="px-4 py-2 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {po.styles.map((s) => (
              <StyleRow key={s.jobAssetId} row={s} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StyleRow({ row }: { row: BoardStyleRow }) {
  return (
    <tr className="border-t border-zinc-100 hover:bg-zinc-50">
      <td className="px-4 py-2.5">
        <div className="font-semibold">{row.styleNumber || row.styleName}</div>
        <div className="text-xs text-zinc-500">{row.styleName}</div>
        {row.groupIds.map((gid) => (
          <a
            key={gid}
            href={`#group-${gid}`}
            className="mt-1 inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 hover:bg-violet-200"
          >
            In multi-style carton
          </a>
        ))}
      </td>
      <td className="px-4 py-2.5">{row.colourName || "—"}</td>
      <td className="px-4 py-2.5 font-mono text-xs">{row.cartonEan ?? "—"}</td>
      <td className="px-4 py-2.5">
        <StatusPill status={row.reviewStatus} />
      </td>
      <td className="px-4 py-2.5">
        <UploadPill at={row.spUploadedAt} />
      </td>
      <td className="px-4 py-2.5 text-right whitespace-nowrap">
        {row.spFileUrl && (
          <a
            href={row.spFileUrl}
            target="_blank"
            rel="noreferrer"
            className="mr-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
          >
            File
          </a>
        )}
        <a
          href={`/api/admin/job-assets/${row.jobAssetId}/download`}
          className="mr-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
        >
          PDF
        </a>
        <a
          href={`/styles/${row.styleId}/review`}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
        >
          Review
        </a>
      </td>
    </tr>
  );
}
