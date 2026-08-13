"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// "Send email to suppliers" on a row of Recent sends — write one subject + body
// and send it to the suppliers that batch reached. The correction channel for a
// batch that went out wrong; see the route for the full why.
//
// Everyone who actually received the batch (originalStatus SENT) is ticked by
// default, because that is who a correction is owed to. Suppliers that were
// NO_EMAIL or FAILED are listed but unticked — they never got the original, so
// mailing them an apology for it would be the second mistake.

type Recipient = {
  supplierId: string;
  supplierName: string;
  to: string | null;
  cc: string[];
  originalStatus: string;
  outputCount: number;
};

type SendResult = {
  supplierId: string;
  supplierName: string;
  to: string | null;
  status: string;
  error?: string | null;
};

export function SupplierMessageButton({
  batchId,
  batchLabel,
  followUpAt,
  followUpCount,
}: {
  batchId: string;
  batchLabel: string;
  followUpAt: string | null;
  followUpCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [results, setResults] = useState<SendResult[] | null>(null);

  async function load() {
    setOpen(true);
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch(`/api/admin/supplier-send/batches/${batchId}/message`);
      const j = (await res.json().catch(() => ({}))) as { recipients?: Recipient[]; error?: string };
      if (!res.ok) {
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      const list = j.recipients ?? [];
      setRecipients(list);
      setPicked(new Set(list.filter((r) => r.originalStatus === "SENT" && r.to).map((r) => r.supplierId)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load recipients");
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/supplier-send/batches/${batchId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body, supplierIds: [...picked] }),
      });
      const j = (await res.json().catch(() => ({}))) as { results?: SendResult[]; error?: string };
      if (!res.ok) {
        setError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      setResults(j.results ?? []);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sendable = recipients.filter((r) => r.to);
  const canSend = picked.size > 0 && subject.trim().length > 0 && body.trim().length > 0 && !sending;

  return (
    <>
      <button
        type="button"
        onClick={load}
        className="whitespace-nowrap rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
      >
        Send email to suppliers
      </button>
      {followUpAt ? (
        <div className="mt-1 text-[10px] text-zinc-400">
          follow-up sent to {followUpCount} · {followUpAt.slice(0, 16).replace("T", " ")}
        </div>
      ) : null}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-zinc-900">Email the suppliers on this send</h3>
                <p className="mt-0.5 text-xs text-zinc-500">{batchLabel}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-500 underline">
                close
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-5">
              {loading ? (
                <p className="text-sm text-zinc-500">Loading recipients…</p>
              ) : error && !results ? (
                <p className="text-sm text-red-600">{error}</p>
              ) : results ? (
                <div>
                  <p className="mb-3 text-sm text-zinc-700">
                    {results.filter((r) => r.status === "SENT").length} sent
                    {results.some((r) => r.status !== "SENT")
                      ? ` · ${results.filter((r) => r.status !== "SENT").length} did not send`
                      : ""}
                  </p>
                  <ul className="space-y-1">
                    {results.map((r) => (
                      <li key={r.supplierId} className="text-xs text-zinc-600">
                        <span className="font-medium text-zinc-800">{r.supplierName}</span>{" "}
                        <span className="text-zinc-400">·</span>{" "}
                        <span className={r.status === "SENT" ? "text-emerald-700" : "text-red-600"}>{r.status}</span>
                        {r.to ? <span className="text-zinc-400"> · {r.to}</span> : null}
                        {r.error ? <div className="text-[11px] text-zinc-500">{r.error}</div> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-zinc-700">Subject</label>
                    <input
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="Please disregard last night's email"
                      className="mt-1 w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-700">Message</label>
                    <textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={9}
                      placeholder={
                        "Dear {{supplier}},\n\nYou received an email from us last night listing production specs that are not in fact ready. Please disregard it — no action is needed, and we will be in touch when the layouts are approved.\n\nApologies for the confusion."
                      }
                      className="mt-1 w-full rounded-md border border-zinc-300 px-2.5 py-2 font-mono text-[13px] leading-relaxed"
                    />
                    <p className="mt-1 text-[11px] text-zinc-500">
                      Blank lines start a new paragraph.{" "}
                      <span className="font-mono">{"{{supplier}}"}</span> is replaced with each
                      supplier&rsquo;s name. Nothing else is substituted — what you type is what they get.
                    </p>
                  </div>

                  <div>
                    <div className="flex items-baseline justify-between">
                      <label className="block text-xs font-medium text-zinc-700">
                        Recipients ({picked.size} of {sendable.length} selected)
                      </label>
                      <div className="flex gap-2 text-[11px]">
                        <button
                          type="button"
                          className="text-zinc-500 underline"
                          onClick={() => setPicked(new Set(sendable.map((r) => r.supplierId)))}
                        >
                          select all
                        </button>
                        <button type="button" className="text-zinc-500 underline" onClick={() => setPicked(new Set())}>
                          none
                        </button>
                      </div>
                    </div>
                    <div className="mt-1 max-h-56 overflow-auto rounded-md border border-zinc-200">
                      {recipients.length === 0 ? (
                        <p className="px-3 py-4 text-xs text-zinc-500">No suppliers on this batch.</p>
                      ) : (
                        <ul className="divide-y divide-zinc-100">
                          {recipients.map((r) => (
                            <li key={r.supplierId} className="flex items-start gap-2 px-3 py-1.5">
                              <input
                                type="checkbox"
                                className="mt-0.5"
                                disabled={!r.to}
                                checked={picked.has(r.supplierId)}
                                onChange={() => toggle(r.supplierId)}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-medium text-zinc-800">{r.supplierName}</div>
                                <div className="truncate text-[11px] text-zinc-500">
                                  {r.to ?? <span className="text-red-500">no email on file</span>}
                                  {r.cc.length > 0 ? (
                                    <span className="text-zinc-400"> · cc {r.cc.length}</span>
                                  ) : null}
                                </div>
                              </div>
                              <span
                                className={`shrink-0 text-[10px] ${r.originalStatus === "SENT" ? "text-zinc-400" : "text-amber-600"}`}
                              >
                                {r.originalStatus === "SENT" ? "received the send" : `was ${r.originalStatus}`}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  {error ? <p className="text-sm text-red-600">{error}</p> : null}
                </div>
              )}
            </div>

            {!results && !loading ? (
              <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-5 py-3">
                <p className="text-[11px] text-zinc-500">
                  One email per supplier, sent immediately. There is no undo.
                </p>
                <button
                  type="button"
                  disabled={!canSend}
                  onClick={send}
                  className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
                >
                  {sending ? "Sending…" : `Send to ${picked.size} supplier${picked.size === 1 ? "" : "s"}`}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
