"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

// Copy button for the build prompt. navigator.clipboard needs a secure context
// (and permission); when it isn't there, the prompt's <pre> is selected
// instead so a plain Ctrl/Cmd+C finishes the job, and execCommand("copy") is
// tried on that selection for older browsers.
export function CopyPromptButton({ text, targetId }: { text: string; targetId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "selected">("idle");

  function selectTarget(): boolean {
    const el = document.getElementById(targetId);
    const selection = window.getSelection();
    if (!el || !selection) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      if (!selectTarget()) return;
      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      setState(copied ? "copied" : "selected");
    }
    setTimeout(() => setState("idle"), 2000);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
    >
      {state === "copied" ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
      {state === "copied" ? "Copied" : state === "selected" ? "Selected — press Ctrl/Cmd+C" : "Copy prompt"}
    </button>
  );
}
