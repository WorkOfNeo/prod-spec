"use client";

import { useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";

// =====================================================
// WYSIWYG markdown editor — TipTap wearing a plain-markdown costume.
//
// Storage stays markdown (the parent receives serialized markdown on
// every update, via the official @tiptap/markdown extension — which
// parses with `marked`, the same library the PDF renderer uses, so what
// round-trips here is what prints).
//
// Markdown typing shortcuts come from StarterKit's input rules: `# ` +
// space → H1, `## ` → H2 (and so on), `- ` → bullet list, `1. ` →
// ordered list, `> ` → quote, `**bold**`, `*italic*`, backticks → code,
// `---` → horizontal rule. Tables are deliberately toolbar-only.
//
// The "Markdown" view toggle is the escape hatch: raw source in a
// textarea for paste-in (e.g. converted Excel sheets) or fixing
// anything the visual editor serializes in a way you don't like.
// =====================================================

type Props = {
  value: string;
  onChange: (markdown: string) => void;
};

export function MarkdownEditor({ value, onChange }: Props) {
  const [mode, setMode] = useState<"visual" | "source">("visual");

  const editor = useEditor({
    extensions: [
      StarterKit,
      TableKit.configure({ table: { resizable: false } }),
      Markdown,
    ],
    content: value,
    contentType: "markdown",
    // Required under Next.js SSR — render after mount.
    immediatelyRender: false,
    onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
    editorProps: {
      attributes: { class: "mdedit-content", "aria-label": "General information editor" },
    },
  });

  // Toolbar reactivity — re-render on selection/transaction so active
  // states track the caret.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e?.isActive("heading", { level: 1 }) ?? false,
      h2: e?.isActive("heading", { level: 2 }) ?? false,
      h3: e?.isActive("heading", { level: 3 }) ?? false,
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      bullet: e?.isActive("bulletList") ?? false,
      ordered: e?.isActive("orderedList") ?? false,
      quote: e?.isActive("blockquote") ?? false,
      inTable: e?.isActive("table") ?? false,
      canUndo: e?.can().undo() ?? false,
      canRedo: e?.can().redo() ?? false,
    }),
  });

  function switchMode(next: "visual" | "source") {
    if (next === mode) return;
    if (next === "visual" && editor) {
      // Source may have been edited — re-parse it into the document.
      editor.commands.setContent(value, { contentType: "markdown" });
    }
    setMode(next);
  }

  return (
    <div className="mdedit overflow-hidden rounded-md border border-zinc-300 bg-white">
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5">
        <ToolBtn label="H1" title="Heading 1 (type # + space)" active={state?.h1} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} disabled={mode === "source"} />
        <ToolBtn label="H2" title="Heading 2 (type ## + space)" active={state?.h2} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={mode === "source"} />
        <ToolBtn label="H3" title="Heading 3 (type ### + space)" active={state?.h3} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} disabled={mode === "source"} />
        <Divider />
        <ToolBtn label="B" title="Bold (type **text**)" active={state?.bold} bold onClick={() => editor?.chain().focus().toggleBold().run()} disabled={mode === "source"} />
        <ToolBtn label="I" title="Italic (type *text*)" active={state?.italic} italic onClick={() => editor?.chain().focus().toggleItalic().run()} disabled={mode === "source"} />
        <Divider />
        <ToolBtn label="• List" title="Bullet list (type - + space)" active={state?.bullet} onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={mode === "source"} />
        <ToolBtn label="1. List" title="Numbered list (type 1. + space)" active={state?.ordered} onClick={() => editor?.chain().focus().toggleOrderedList().run()} disabled={mode === "source"} />
        <ToolBtn label="❝ Quote" title="Blockquote (type > + space)" active={state?.quote} onClick={() => editor?.chain().focus().toggleBlockquote().run()} disabled={mode === "source"} />
        <ToolBtn label="—" title="Horizontal rule" onClick={() => editor?.chain().focus().setHorizontalRule().run()} disabled={mode === "source"} />
        <Divider />
        {state?.inTable ? (
          <>
            <ToolBtn label="+ Row" title="Add row below" onClick={() => editor?.chain().focus().addRowAfter().run()} />
            <ToolBtn label="+ Col" title="Add column right" onClick={() => editor?.chain().focus().addColumnAfter().run()} />
            <ToolBtn label="− Row" title="Delete row" onClick={() => editor?.chain().focus().deleteRow().run()} />
            <ToolBtn label="− Col" title="Delete column" onClick={() => editor?.chain().focus().deleteColumn().run()} />
            <ToolBtn label="✕ Table" title="Delete table" onClick={() => editor?.chain().focus().deleteTable().run()} />
          </>
        ) : (
          <ToolBtn
            label="⊞ Table"
            title="Insert table (3 × 3 with header row)"
            onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
            disabled={mode === "source"}
          />
        )}
        <Divider />
        <ToolBtn label="↺" title="Undo" onClick={() => editor?.chain().focus().undo().run()} disabled={mode === "source" || !state?.canUndo} />
        <ToolBtn label="↻" title="Redo" onClick={() => editor?.chain().focus().redo().run()} disabled={mode === "source" || !state?.canRedo} />

        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5">
          {(["visual", "source"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                mode === m ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-800"
              }`}
            >
              {m === "visual" ? "Visual" : "Markdown"}
            </button>
          ))}
        </div>
      </div>

      {mode === "visual" ? (
        <EditorContent editor={editor} />
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={22}
          spellCheck={false}
          className="block w-full px-3 py-2 font-mono text-xs leading-relaxed outline-none"
          aria-label="General information markdown source"
        />
      )}

      {/* Editable-area styling. TipTap renders plain semantic HTML inside
          .mdedit-content — these rules approximate the printed page so
          the visual editor reads like the output. */}
      <style>{`
        .mdedit .mdedit-content { min-height: 24rem; padding: 12px 16px; font-size: 0.8125rem; line-height: 1.6; color: #27272a; outline: none; }
        .mdedit .mdedit-content h1 { font-size: 1.45em; font-weight: 700; margin: 0 0 0.5em; }
        .mdedit .mdedit-content h2 { font-size: 1.2em; font-weight: 700; margin: 1.1em 0 0.35em; padding-bottom: 0.15em; border-bottom: 1px solid #e4e4e7; }
        .mdedit .mdedit-content h3 { font-size: 1.05em; font-weight: 600; margin: 0.9em 0 0.3em; }
        .mdedit .mdedit-content p { margin: 0 0 0.5em; }
        .mdedit .mdedit-content ul, .mdedit .mdedit-content ol { margin: 0 0 0.5em; padding-left: 1.4em; }
        .mdedit .mdedit-content ul { list-style: disc; }
        .mdedit .mdedit-content ol { list-style: decimal; }
        .mdedit .mdedit-content li { margin: 0 0 0.2em; }
        .mdedit .mdedit-content blockquote { margin: 0 0 0.5em; padding: 0.1em 0 0.1em 0.8em; border-left: 3px solid #d4d4d8; color: #52525b; }
        .mdedit .mdedit-content hr { border: none; border-top: 1px solid #e4e4e7; margin: 1em 0; }
        .mdedit .mdedit-content code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.85em; background: #f4f4f5; border: 1px solid #ececee; border-radius: 4px; padding: 0 3px; }
        .mdedit .mdedit-content pre { background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 6px; padding: 8px 10px; margin: 0 0 0.6em; }
        .mdedit .mdedit-content pre code { background: none; border: none; padding: 0; }
        .mdedit .mdedit-content table { border-collapse: collapse; width: 100%; margin: 0.4em 0 0.8em; table-layout: fixed; }
        .mdedit .mdedit-content th, .mdedit .mdedit-content td { border: 1px solid #d4d4d8; padding: 4px 8px; vertical-align: top; position: relative; }
        .mdedit .mdedit-content th { background: #f4f4f5; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.03em; color: #52525b; text-align: left; }
        .mdedit .mdedit-content th p, .mdedit .mdedit-content td p { margin: 0; }
        .mdedit .mdedit-content .selectedCell::after { content: ""; position: absolute; inset: 0; background: rgba(24, 24, 27, 0.07); pointer-events: none; }
      `}</style>
    </div>
  );
}

function ToolBtn({
  label,
  title,
  onClick,
  active,
  disabled,
  bold,
  italic,
}: {
  label: string;
  title: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  bold?: boolean;
  italic?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-2 py-1 text-[11.5px] transition-colors disabled:opacity-35 ${
        bold ? "font-bold" : "font-medium"
      } ${italic ? "italic" : ""} ${
        active ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900"
      }`}
    >
      {label}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-zinc-200" />;
}
