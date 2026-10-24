"use client";

import { useState } from "react";
import { Columns2, ImageOff, LoaderCircle, SlidersHorizontal } from "lucide-react";
import { proofUrl } from "./shared";

// One before/after proof (design §5.5): why this document is shown (changed /
// branch / control) and the two pictures from the proof route — side by side,
// or as a slider that wipes the draft over what prints today. Pictures load
// lazily; a click opens one full size in a new tab.

// proofs.ts ProofPick, as JSON.
export type ProofPick = {
  styleId: string;
  styleLabel: string;
  variantKey: string;
  suffix: string | null;
  reason: "changed" | "branch" | "control";
  note: string;
};

const REASON: Record<ProofPick["reason"], { label: string; className: string }> = {
  changed: { label: "Changed", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  branch: { label: "Branch", className: "bg-blue-50 text-blue-700 ring-blue-200" },
  control: { label: "Control", className: "bg-zinc-100 text-zinc-600 ring-zinc-200" },
};

export function ProofCard({ revisionId, pick }: { revisionId: string; pick: ProofPick }) {
  const [mode, setMode] = useState<"side" | "slider">("side");
  const [pos, setPos] = useState(50);
  const before = proofUrl(revisionId, pick.styleId, "before", pick.suffix);
  const after = proofUrl(revisionId, pick.styleId, "after", pick.suffix);
  const reason = REASON[pick.reason];

  return (
    <article className="rounded-md border border-zinc-200 p-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${reason.className}`}>
              {reason.label}
            </span>
            <span className="truncate text-sm font-medium text-zinc-900">{pick.styleLabel}</span>
            {pick.suffix && <span className="font-mono text-xs text-zinc-500">{pick.suffix}</span>}
          </div>
          <p className="mt-1 text-xs text-zinc-500">{pick.note}</p>
        </div>
        <div className="flex rounded-md ring-1 ring-zinc-200" role="group" aria-label="Compare as">
          <ModeButton active={mode === "side"} onClick={() => setMode("side")} label="Side by side">
            <Columns2 className="h-3.5 w-3.5" aria-hidden />
          </ModeButton>
          <ModeButton active={mode === "slider"} onClick={() => setMode("slider")} label="Slider">
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          </ModeButton>
        </div>
      </header>

      {mode === "side" ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <figure>
            <figcaption className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Before</figcaption>
            <ProofImage src={before} alt={`${pick.styleLabel}: as it prints today`} />
          </figure>
          <figure>
            <figcaption className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">After</figcaption>
            <ProofImage src={after} alt={`${pick.styleLabel}: with this draft`} />
          </figure>
        </div>
      ) : (
        <div className="mt-3">
          <div className="relative overflow-hidden rounded bg-white ring-1 ring-zinc-200">
            <ProofImage src={before} alt={`${pick.styleLabel}: as it prints today`} bare />
            {/* eslint-disable-next-line @next/next/no-img-element -- private, session-gated PNG */}
            <img
              src={after}
              alt={`${pick.styleLabel}: with this draft`}
              className="absolute inset-0 h-full w-full object-contain"
              style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
            />
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-blue-500" style={{ left: `${pos}%` }} />
            <span className="absolute left-1 top-1 rounded bg-blue-600/80 px-1 text-[10px] font-medium text-white">After</span>
            <span className="absolute right-1 top-1 rounded bg-zinc-700/70 px-1 text-[10px] font-medium text-white">Before</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={pos}
            onChange={(e) => setPos(Number(e.target.value))}
            aria-label="Wipe between after (left) and before (right)"
            className="mt-2 w-full accent-blue-600"
          />
        </div>
      )}
    </article>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={`inline-flex items-center gap-1 px-2 py-1 text-xs first:rounded-l-md last:rounded-r-md ${
        active ? "bg-zinc-900 text-white" : "bg-white text-zinc-600 hover:bg-zinc-50"
      }`}
    >
      {children}
      {label}
    </button>
  );
}

// A proof picture: spinner while it renders (a cold one launches the
// renderer), the route's error in words if it can't be drawn.
function ProofImage({ src, alt, bare = false }: { src: string; alt: string; bare?: boolean }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const onError = async () => {
    setState("error");
    // The <img> can't read the body; ask once for the reason.
    try {
      const res = await fetch(src, { cache: "force-cache" });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setMessage(body?.error ?? `HTTP ${res.status}`);
    } catch {
      setMessage(null);
    }
  };
  return (
    <div className={`relative min-h-24 ${bare ? "" : "rounded bg-white ring-1 ring-zinc-200"}`}>
      {state !== "error" && (
        <a href={src} target="_blank" rel="noreferrer" title="Open full size">
          {/* eslint-disable-next-line @next/next/no-img-element -- private, session-gated PNG */}
          <img
            src={src}
            alt={alt}
            loading="lazy"
            onLoad={() => setState("ready")}
            onError={onError}
            className="block h-auto w-full"
          />
        </a>
      )}
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-400">
          <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden />
        </div>
      )}
      {state === "error" && (
        <div className="flex min-h-24 flex-col items-center justify-center gap-1 p-3 text-center text-xs text-zinc-500">
          <ImageOff className="h-5 w-5" aria-hidden />
          <span>{message ?? "This picture could not be rendered."}</span>
        </div>
      )}
    </div>
  );
}
