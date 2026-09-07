"use client";

import { useRef, useState } from "react";

// =====================================================
// A drag-and-drop / click-to-browse target for ONE file.
//
// The drag mechanics here are lifted from the General-page images panel in
// PR #158 (src/app/(admin)/prod-specs/[id]/general-images-panel.tsx), which is
// still open on its own branch: the enter/leave DEPTH COUNTER, and the "Files"
// check on dataTransfer.types. Both matter and both are easy to get wrong —
// dragging across a child element fires dragleave on the parent, so a boolean
// flag flickers the highlight off mid-drag, and without the types check an
// internal drag (a reordered card, selected text) lights the zone up as though
// a file were incoming.
//
// It lives in src/components rather than beside either caller so the two
// droppers in the app share one behaviour. When #158 lands, its panel should be
// refactored onto this component rather than keeping a second copy — it needs
// multi-file and a thumbnail body, which is why this takes `children` and an
// `onFiles` array instead of hard-coding a single-file signature.
// =====================================================

export function FileDropZone({
  accept,
  multiple = false,
  disabled = false,
  busy = false,
  onFiles,
  children,
}: {
  // `accept` attribute for the hidden input (e.g. ".pdf,.ai,.png"). The real
  // validation is server-side; this only steers the OS file picker.
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  // Renders the zone in its working state and blocks further drops.
  busy?: boolean;
  onFiles: (files: File[]) => void;
  // The zone's label / body. Receives the current drag state so a caller can
  // change its wording while a file is hovering.
  children: (state: { dragOver: boolean; busy: boolean }) => React.ReactNode;
}) {
  const [dragOver, setDragOver] = useState(false);
  // dragenter/dragleave fire for every child element the pointer crosses, so a
  // plain boolean turns the highlight off halfway through the drag. Counting
  // enters against leaves is the fix.
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const inert = disabled || busy;

  // Only a FILE drag lights the zone up — an internal drag (text, a card)
  // carries no "Files" type and must be ignored outright.
  function isFileDrag(e: React.DragEvent) {
    return e.dataTransfer.types.includes("Files");
  }

  function reset() {
    dragDepth.current = 0;
    setDragOver(false);
  }

  return (
    <div
      onDragEnter={(e) => {
        if (inert || !isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (inert || !isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDragOver={(e) => {
        if (inert || !isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        if (inert || !isFileDrag(e)) return;
        e.preventDefault();
        reset();
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
      onClick={() => {
        if (!inert) inputRef.current?.click();
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-4 py-6 text-center transition ${
        inert
          ? "cursor-default border-zinc-200 bg-zinc-50 opacity-70"
          : dragOver
            ? "border-zinc-900 bg-zinc-900/5"
            : "border-zinc-300 bg-zinc-50 hover:border-zinc-400 hover:bg-zinc-100/60"
      }`}
    >
      {children({ dragOver, busy })}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        disabled={inert}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(multiple ? files : files.slice(0, 1));
          e.target.value = ""; // allow re-picking the same file
        }}
      />
    </div>
  );
}
