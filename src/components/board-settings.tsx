"use client";

import { useState } from "react";
import {
  Calendar, Check, ChevronDown, GripVertical, Link2, Pencil, Plus, Shield, Tag, Text, User, X, Zap,
} from "lucide-react";
import clsx from "clsx";
import type { Board, BoardColumn, BoardFieldKey } from "@/lib/types";
import { ALL_FIELDS, COLUMN_COLORS, nextColor, TEMPLATES } from "@/lib/board/templates";

const FIELD_ICON: Record<string, typeof Text> = {
  text: Text, chevron: ChevronDown, calendar: Calendar, tag: Tag, user: User, zap: Zap, link: Link2,
};

/**
 * Board settings drawer.
 *
 * Everything here is optimistic: the panel edits a local copy and pushes the
 * whole column array on each change, so drag-reordering feels instant and a
 * failed request cannot leave the board half-reordered.
 */
export function BoardSettings({
  board,
  onClose,
  onSaved,
}: {
  board: Board;
  onClose: () => void;
  onSaved: (b: Board) => void;
}) {
  const [name, setName] = useState(board.name);
  const [columns, setColumns] = useState<BoardColumn[]>(board.columns);
  const [fields, setFields] = useState(board.fields);
  const [templateId, setTemplateId] = useState(board.templateId ?? "default");
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function push(payload: Record<string, unknown>, optimistic?: Partial<Board>) {
    setSaving(true);
    try {
      const res = await fetch("/api/board", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ boardId: board.id, ...payload }),
      });
      const json = await res.json();
      if (json.ok) {
        onSaved(json.board);
        if (json.orphans > 0) setNote(`${json.orphans} card(s) now sit in removed columns — rehome them from the board.`);
        else setNote(null);
      }
      return json;
    } finally {
      setSaving(false);
    }
  }

  function commitColumns(next: BoardColumn[]) {
    setColumns(next);
    void push({ columns: next });
  }

  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = [...columns];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commitColumns(next);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label="Board settings">
      <button className="absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-label="Close settings" />

      <div className="slide-in relative flex h-full w-full max-w-[420px] flex-col overflow-y-auto border-l border-ink-700 bg-ink-900">
        <header className="sticky top-0 z-10 flex items-start gap-4 border-b border-ink-700 bg-ink-900/95 px-6 py-5 backdrop-blur">
          <div className="flex-1">
            <h2 className="text-[19px] font-semibold tracking-tight">Board Settings</h2>
            <p className="text-[12.5px] text-mist-400">Customize columns, fields, and layout</p>
          </div>
          <button onClick={onClose} className="text-mist-400 hover:text-mist-100"><X size={20} /></button>
        </header>

        <div className="space-y-8 px-6 py-6">
          {/* ---- Name ---- */}
          <section>
            <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-mist-400">Board name</h3>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name !== board.name && push({ name })}
              className="w-full rounded-xl border border-ink-700 bg-ink-850 px-4 py-3 text-[15px] outline-none focus:border-brand-500"
            />
          </section>

          {/* ---- Templates ---- */}
          <section>
            <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-mist-400">Apply template</h3>
            <div className="space-y-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  disabled={saving}
                  onClick={async () => {
                    setTemplateId(t.id);
                    const json = await push({ applyTemplate: t.id });
                    if (json?.board) setColumns(json.board.columns);
                  }}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-xl border px-4 py-3 text-left transition-colors",
                    templateId === t.id
                      ? "border-brand-500 bg-brand-500/10 text-brand-400"
                      : "border-ink-700 text-mist-100 hover:border-ink-600",
                  )}
                >
                  <span className="text-[15px] font-medium">{t.name}</span>
                  <span className="text-[12.5px] text-mist-400">({t.columns.length} cols)</span>
                </button>
              ))}
            </div>
          </section>

          {/* ---- Columns ---- */}
          <section>
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-mist-400">Columns</h3>
              <button
                onClick={() =>
                  commitColumns([
                    ...columns,
                    { id: `col_${Math.random().toString(36).slice(2, 9)}`, name: "New column", color: COLUMN_COLORS[columns.length % COLUMN_COLORS.length], hitl: false },
                  ])
                }
                className="flex items-center gap-1 text-[13px] font-medium text-brand-400 hover:text-brand-500"
              >
                <Plus size={14} /> Add
              </button>
            </div>
            <p className="mb-3 text-[12px] leading-relaxed text-mist-400">
              Drag to reorder · Click color dot to cycle · Click shield to toggle HITL
            </p>

            <div className="space-y-2">
              {columns.map((col, i) => (
                <div
                  key={col.id}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx !== null) reorder(dragIdx, i);
                    setDragIdx(null);
                  }}
                  onDragEnd={() => setDragIdx(null)}
                  className={clsx(
                    "flex items-center gap-2.5 rounded-xl border border-ink-700 bg-ink-850 px-3 py-3",
                    dragIdx === i && "drag-ghost",
                  )}
                >
                  <GripVertical size={15} className="cursor-grab text-mist-500" />

                  <button
                    title="Cycle colour"
                    onClick={() => commitColumns(columns.map((c) => (c.id === col.id ? { ...c, color: nextColor(c.color) } : c)))}
                    className="h-3.5 w-3.5 shrink-0 rounded-full ring-2 ring-transparent transition hover:ring-ink-600"
                    style={{ background: col.color }}
                  />

                  {editing === col.id ? (
                    <input
                      autoFocus
                      defaultValue={col.name}
                      onBlur={(e) => {
                        commitColumns(columns.map((c) => (c.id === col.id ? { ...c, name: e.target.value || c.name } : c)));
                        setEditing(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      className="min-w-0 flex-1 rounded border border-brand-500 bg-ink-800 px-1.5 py-0.5 text-[15px] outline-none"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-[15px]">{col.name}</span>
                  )}

                  <button
                    title={col.hitl ? "Human approval required" : "No approval gate"}
                    onClick={() => commitColumns(columns.map((c) => (c.id === col.id ? { ...c, hitl: !c.hitl } : c)))}
                    className={clsx(
                      "grid h-6 w-7 place-items-center rounded",
                      col.hitl ? "bg-warn-500/15 text-warn-400" : "bg-ink-800 text-mist-500 hover:text-mist-300",
                    )}
                  >
                    <Shield size={13} />
                  </button>
                  <button onClick={() => setEditing(col.id)} className="text-mist-400 hover:text-mist-100"><Pencil size={14} /></button>
                  <button
                    onClick={() => commitColumns(columns.filter((c) => c.id !== col.id))}
                    disabled={columns.length <= 1}
                    title={columns.length <= 1 ? "A board needs at least one column" : "Remove column"}
                    className="text-mist-400 hover:text-bad-400 disabled:opacity-30"
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>

            {note && <p className="mt-3 rounded-lg bg-warn-500/10 px-3 py-2 text-[12px] text-warn-400">{note}</p>}
          </section>

          {/* ---- Card fields ---- */}
          <section>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-mist-400">Card fields</h3>
            <p className="mb-3 text-[12px] text-mist-400">Toggle which fields appear on cards and in the add form.</p>
            <div className="space-y-2">
              {ALL_FIELDS.map((f) => {
                const on = fields[f.key];
                const Icon = FIELD_ICON[f.icon] ?? Text;
                return (
                  <button
                    key={f.key}
                    onClick={() => {
                      const next = { ...fields, [f.key]: !on } as Record<BoardFieldKey, boolean>;
                      setFields(next);
                      void push({ fields: { [f.key]: !on } });
                    }}
                    className={clsx(
                      "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
                      on ? "border-brand-500 bg-brand-500/[0.07] text-brand-400" : "border-ink-700 text-mist-300 hover:border-ink-600",
                    )}
                  >
                    <Icon size={15} />
                    <span className="flex-1 text-[14px]">{f.label}</span>
                    <span className={clsx("grid h-5 w-5 place-items-center rounded-full border", on ? "border-brand-500 bg-brand-500 text-[var(--a-on)]" : "border-ink-600")}>
                      {on && <Check size={12} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
