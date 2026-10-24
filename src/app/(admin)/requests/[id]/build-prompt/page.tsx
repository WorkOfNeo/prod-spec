import Link from "next/link";
import { notFound } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { requireAdminPage } from "@/lib/auth-server";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { getRequestDetail } from "@/lib/change-requests/store";
import { CodeSpecSchema, requestRef } from "@/lib/change-requests/types";
import { CopyPromptButton } from "./copy-prompt-button";

export const dynamic = "force-dynamic";

export const metadata = { title: "Build prompt" };

// /requests/[id]/build-prompt?output=<outputId> — where the developer lands
// from the "Variable needed" email (design §5.6). The agent stopped on an
// output because the change needs a layout variable that doesn't exist yet;
// this page shows its code spec (what to print, where the value comes from,
// the worked cases) and the generated build prompt to paste into a coding
// agent. Behind CHANGE_REQUESTS_ENABLED (404 when off) and ADMIN only.
// Without ?output= it shows the request's first output that has a spec.
//
// Parts of the prompt come from the request (the requester's words and the
// agent's reading of them). gap.ts fences them as data, but the page still
// asks the developer to read the prompt before handing it to a coding agent.
export default async function BuildPromptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!changeRequestsEnabled()) notFound();
  await requireAdminPage();

  const { id } = await params;
  const query = await searchParams;
  const outputParam = typeof query.output === "string" ? query.output : null;

  const request = await getRequestDetail(id);
  if (!request) notFound();
  const output = outputParam
    ? request.outputs.find((o) => o.id === outputParam)
    : (request.outputs.find((o) => o.codeSpec != null) ?? request.outputs[0]);
  if (!output) notFound();

  const ref = requestRef(request.number);
  const spec = CodeSpecSchema.safeParse(output.codeSpec);
  const promptId = "build-prompt-text";

  return (
    <div className="px-8 py-8">
      <Link href={`/requests/${request.id}`} className="text-xs text-zinc-500 underline">
        ← Back to {ref}
      </Link>
      <div className="mt-2 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Build prompt</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          {ref} · {output.label}. The agent stopped because this change needs a layout variable that doesn&apos;t
          exist yet. Paste the prompt into a coding agent; when the change is merged and deployed, this output picks
          itself up again.
        </p>
      </div>

      {!spec.success ? (
        <div className="max-w-3xl rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
          This output has no build prompt. It is {output.status.toLowerCase().replace(/_/g, " ")}
          {output.awaitingToken ? `, waiting for {{${output.awaitingToken}}}` : ""}.
        </div>
      ) : (
        <div className="grid max-w-5xl gap-6">
          <section className="rounded-lg border border-zinc-200 bg-white p-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-sm text-zinc-800">
                {`{{${spec.data.tokenKey}}}`}
              </code>
              <span className="text-sm font-medium text-zinc-800">{spec.data.label}</span>
              <span className="text-xs text-zinc-400">
                {output.status === "NEEDS_CODE" ? "waiting for this variable" : output.status.toLowerCase().replace(/_/g, " ")}
              </span>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-600">{spec.data.rule}</p>

            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-zinc-400">Board</dt>
              <dd className="text-zinc-700">{spec.data.source.board}</dd>
              <dt className="text-zinc-400">Column</dt>
              <dd className="text-zinc-700">{spec.data.source.column}</dd>
            </dl>

            <div className="mt-4 grid gap-6 md:grid-cols-2">
              <div>
                <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400">Live values</h2>
                {spec.data.source.examples.length === 0 ? (
                  <p className="mt-2 text-sm text-zinc-400">None recorded.</p>
                ) : (
                  <table className="mt-2 w-full text-sm">
                    <tbody>
                      {[...spec.data.source.examples]
                        .sort((a, b) => b.count - a.count)
                        .map((e, i) => (
                          <tr key={i} className="border-t border-zinc-100 first:border-t-0">
                            <td className="py-1 pr-3 text-zinc-700">{e.value}</td>
                            <td className="py-1 text-right tabular-nums text-zinc-400">× {e.count}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400">Worked cases</h2>
                {spec.data.cases.length === 0 ? (
                  <p className="mt-2 text-sm text-zinc-400">None given.</p>
                ) : (
                  <table className="mt-2 w-full text-sm">
                    <tbody>
                      {spec.data.cases.map((c, i) => (
                        <tr key={i} className="border-t border-zinc-100 first:border-t-0">
                          <td className="py-1 pr-3 text-zinc-700">{c.input}</td>
                          <td className="py-1 pr-2 text-zinc-300">→</td>
                          <td className="py-1 font-mono text-zinc-800">
                            {c.output.trim() === "" ? <span className="text-zinc-400">(nothing)</span> : c.output}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>

          <p
            role="note"
            className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>Read this prompt before pasting it into a coding agent: parts of it come from the request.</span>
          </p>

          <section className="rounded-lg border border-zinc-200 bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-5 py-3">
              <h2 className="text-sm font-medium text-zinc-800">Prompt</h2>
              <CopyPromptButton text={spec.data.buildPrompt} targetId={promptId} />
            </div>
            <pre
              id={promptId}
              className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-relaxed text-zinc-700"
            >
              {spec.data.buildPrompt}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
