"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CustomerConfig } from "@/lib/customers/config";

type Initial = {
  slug: string;
  name: string;
  config: CustomerConfig;
};

type Props =
  | { mode: "create"; initial: Initial; customerId?: undefined }
  | { mode: "edit"; initial: Initial; customerId: string };

export function CustomerForm({ mode, initial, customerId }: Props) {
  const router = useRouter();
  const [slug, setSlug] = useState(initial.slug);
  const [name, setName] = useState(initial.name);
  const [configText, setConfigText] = useState(JSON.stringify(initial.config, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      let config: unknown;
      try {
        config = JSON.parse(configText);
      } catch (err) {
        setError(`Config JSON parse error: ${(err as Error).message}`);
        return;
      }

      const payload: Record<string, unknown> = {
        name,
        config,
      };
      if (mode === "create") payload.slug = slug;

      const url = mode === "create" ? "/api/admin/customers" : `/api/admin/customers/${customerId}`;
      const method = mode === "create" ? "POST" : "PATCH";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ? `${body.error}${body.details ? ` — ${JSON.stringify(body.details)}` : ""}` : `HTTP ${res.status}`);
        return;
      }
      router.push("/settings");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex max-w-3xl flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <label className="text-xs font-medium text-ink">
          Slug
          <input
            type="text"
            required
            disabled={mode === "edit"}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-subtle disabled:text-muted"
            placeholder="netto-germany"
          />
        </label>
        <label className="text-xs font-medium text-ink">
          Name
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder="Netto Germany"
          />
        </label>
      </div>

      <label className="text-xs font-medium text-ink">
        Config JSON
        <span className="ml-2 font-normal text-muted">
          (mondayBoardIds, enabledDocTypes, sharepointPath) — column mapping is shared, edit it under Settings → Monday
        </span>
        <textarea
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          rows={20}
          spellCheck={false}
          className="mt-1 w-full rounded-md border border-line px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </label>

      {error && <p className="text-xs text-bad">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink transition-colors enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Saving…" : mode === "create" ? "Create customer" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
