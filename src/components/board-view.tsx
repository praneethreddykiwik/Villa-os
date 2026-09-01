"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle, Calendar, Check, Clock, Plus, Settings2, Shield, Trash2, User, X, Zap,
} from "lucide-react";
import clsx from "clsx";
import type { Board, BoardCard, BoardColumn } from "@/lib/types";
import { orphanCards } from "@/lib/board/templates";
import { BoardSettings } from "./board-settings";

/**
 * The board.
 *
 * Three things here are deliberate and are what separate this from a toy kanban:
 *  1. HITL columns gate movement — a card cannot leave an approval column until
 *     someone approves it, with an explicit override that gets logged.
 *  2. Cards whose column was deleted are never lost; they surface in a banner
 *     with one-click rehoming.
 *  3. Card fields are board-level configuration, so the same component renders a
 *     content calendar, a sales pipeline or a support queue with no forks.
 */

const PRIORITY_TONE: Record<string, string> = {
  Urgent: "bg-bad-500/15 text-bad-400",
  High: "bg-bad-500/12 text-bad-400",
  Medium: "bg-warn-500/12 text-warn-400",
  Low: "bg-ink-700 text-mist-300",
};

function daysAgo(iso: string): string {
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "today";
  return `${d}d ago`;
}

export function BoardView({ board: initialBoard, cards: initialCards }: { board: Board; cards: BoardCard[] }) {
  const [board, setBoard] = useState(initialBoard);
  const [cards, setCards] = useState(initialCards);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragCard, setDragCard] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const [addingIn, setAddingIn] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; cardId?: string; columnId?: string } | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);

  const orphans = useMemo(() => orphanCards(cards, board.columns), [cards, board.columns]);
  const byColumn = useMemo(() => {
    const map = new Map<string, BoardCard[]>();
    for (const col of board.columns) {
      map.set(
        col.id,
        cards.filter((c) => c.columnId === col.id).sort((a, b) => a.order - b.order),
      );
    }
    return map;
  }, [cards, board.columns]);

  async function createCard(columnId: string, title: string) {
    if (!title.trim()) return;
    const res = await fetch("/api/board/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId: board.id, columnId, title: title.trim() }),
    });
    const json = await res.json();
    if (json.ok) setCards((c) => [...c, json.card]);
  }

  async function moveCard(cardId: string, columnId: string, force = false) {
    const previous = cards;
    // Optimistic: the card jumps immediately, and we roll back if the gate blocks it.
    setCards((list) => list.map((c) => (c.id === cardId ? { ...c, columnId } : c)));
    const res = await fetch("/api/board/cards", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardId, columnId, force }),
    });
    const json = await res.json();
    if (!json.ok) {
      setCards(previous);
      setToast({ text: json.error, cardId, columnId });
      return;
    }
    setCards((list) => list.map((c) => (c.id === cardId ? json.card : c)));
    setToast(null);
  }

  async function decide(cardId: string, state: "approved" | "rejected") {
    const res = await fetch("/api/board/cards", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardId, approval: { state } }),
    });
    const json = await res.json();
    // The server refuses a sign-off from the card's own author. Without this the
    // button would simply do nothing and look broken.
    if (!json.ok) return setToast({ text: json.error });
    setCards((list) => list.map((c) => (c.id === cardId ? json.card : c)));
  }

  async function removeCard(cardId: string) {
    const previous = cards;
    setCards((list) => list.filter((c) => c.id !== cardId));
    const res = await fetch("/api/board/cards", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardId }),
    });
    const json = await res.json();
    // Same rollback the move already does. Dropping the card locally and never
    // reading the response showed a refused delete as a completed one — the
    // card comes back on the next load, by which time the operator has moved
    // on believing the work item is gone.
    if (!res.ok || !json.ok) {
      setCards(previous);
      setToast({ text: json.error ?? "Could not delete that card — it is still on the board." });
    }
  }

  async function addColumn(name: string) {
    const previous = board;
    const next: BoardColumn[] = [
      ...board.columns,
      { id: `col_${Math.random().toString(36).slice(2, 9)}`, name, color: "#94a3b8", hitl: false },
    ];
    setBoard((b) => ({ ...b, columns: next }));
    setAddingColumn(false);
    const res = await fetch("/api/board", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId: board.id, columns: next }),
    });
    const json = await res.json();
    // Without this the new column stays on screen after the server refused to
    // save it, and cards get dragged into a column that does not exist server
    // side — every one of those moves then fails for a reason nobody can see.
    if (!res.ok || !json.ok) {
      setBoard(previous);
      setToast({ text: json.error ?? "Could not add that column." });
    }
  }

  const f = board.fields;

  return (
    <div className="flex h-[calc(100vh-58px)] flex-col">
      {/* ---- Quick add ---- */}
      <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-2.5">
        <input
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && board.columns[0]) {
              void createCard(board.columns[0].id, quick);
              setQuick("");
            }
          }}
          placeholder={`Quick add to "${board.columns[0]?.name ?? "board"}"...`}
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[13px] outline-none placeholder:text-mist-500 focus:border-brand-500"
        />
        <button
          onClick={() => {
            if (board.columns[0]) void createCard(board.columns[0].id, quick);
            setQuick("");
          }}
          className="grid h-9 w-9 place-items-center rounded-lg bg-brand-500 text-[var(--a-on)] hover:bg-brand-600"
        >
          <Plus size={16} />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-2 text-[12.5px] text-mist-200 hover:border-ink-600"
        >
          <Settings2 size={14} /> Settings
        </button>
      </div>

      {/* ---- Orphan recovery ---- */}
      {orphans.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warn-500/25 bg-warn-500/[0.07] px-4 py-2.5 text-[12.5px]">
          <AlertCircle size={14} className="text-warn-400" />
          <span className="text-mist-200">
            {orphans.length} card(s) belong to deleted columns. Move them to an active column or delete.
          </span>
          {orphans.slice(0, 4).map((c) => (
            <span key={c.id} className="flex items-center gap-1">
              <button
                onClick={() => board.columns[0] && moveCard(c.id, board.columns[0].id, true)}
                title={`Move "${c.title}" to ${board.columns[0]?.name}`}
                className="underline decoration-dotted underline-offset-2 text-warn-400 hover:text-warn-500"
              >
                {c.title.length > 22 ? `${c.title.slice(0, 22)}…` : c.title}
              </button>
              <button onClick={() => removeCard(c.id)} title="Delete card" className="text-mist-400 hover:text-bad-400">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ---- HITL block toast ---- */}
      {toast && (
        <div className="flex items-center gap-3 border-b border-bad-500/25 bg-bad-500/[0.07] px-4 py-2.5 text-[12.5px]">
          <Shield size={14} className="text-bad-400" />
          <span className="flex-1 text-mist-200">{toast.text}</span>
          {toast.cardId && (
            <>
              <button
                onClick={() => toast.cardId && decide(toast.cardId, "approved")}
                className="rounded-lg bg-good-500/15 px-2.5 py-1 font-medium text-good-400 hover:bg-good-500/25"
              >
                Approve
              </button>
              <button
                onClick={() => toast.cardId && toast.columnId && moveCard(toast.cardId, toast.columnId, true)}
                className="rounded-lg border border-ink-600 px-2.5 py-1 text-mist-300 hover:text-mist-100"
              >
                Override
              </button>
            </>
          )}
          <button onClick={() => setToast(null)} className="text-mist-400 hover:text-mist-100"><X size={13} /></button>
        </div>
      )}

      {/* ---- Columns ---- */}
      <div className="flex flex-1 gap-3 overflow-x-auto p-4">
        {board.columns.map((col) => {
          const list = byColumn.get(col.id) ?? [];
          const overLimit = col.wipLimit !== undefined && list.length > col.wipLimit;
          return (
            <div
              key={col.id}
              onDragOver={(e) => {
                e.preventDefault();
                setDropCol(col.id);
              }}
              onDragLeave={() => setDropCol((c) => (c === col.id ? null : c))}
              onDrop={() => {
                if (dragCard) void moveCard(dragCard, col.id);
                setDragCard(null);
                setDropCol(null);
              }}
              className={clsx(
                "flex w-[300px] shrink-0 flex-col rounded-xl border border-ink-700 bg-ink-900/60",
                dropCol === col.id && "drop-target",
              )}
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: col.color }} />
                <span className="truncate text-[12px] font-semibold uppercase tracking-wider text-mist-100">{col.name}</span>
                {col.hitl && (
                  <span className="flex items-center gap-1 rounded bg-warn-500/12 px-1.5 py-0.5 text-[9.5px] font-semibold text-warn-400">
                    <Shield size={9} /> HITL
                  </span>
                )}
                <span className={clsx("tnum ml-auto text-[12px]", overLimit ? "font-semibold text-warn-400" : "text-mist-400")}>
                  {list.length}
                  {col.wipLimit !== undefined && `/${col.wipLimit}`}
                </span>
                <button onClick={() => setAddingIn(col.id)} className="text-mist-400 hover:text-mist-100"><Plus size={15} /></button>
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {addingIn === col.id && (
                  <input
                    autoFocus
                    placeholder="Card title, Enter to save"
                    onBlur={() => setAddingIn(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void createCard(col.id, (e.target as HTMLInputElement).value);
                        setAddingIn(null);
                      }
                      if (e.key === "Escape") setAddingIn(null);
                    }}
                    className="w-full rounded-lg border border-brand-500 bg-ink-850 px-3 py-2 text-[13px] outline-none"
                  />
                )}

                {list.map((card) => (
                  <article
                    key={card.id}
                    draggable
                    onDragStart={() => setDragCard(card.id)}
                    onDragEnd={() => setDragCard(null)}
                    className={clsx(
                      "group cursor-grab rounded-xl border border-ink-700 bg-ink-850 p-3 active:cursor-grabbing",
                      dragCard === card.id && "drag-ghost",
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <h4 className="min-w-0 flex-1 text-[14px] font-semibold leading-snug text-mist-100">{card.title}</h4>
                      <button
                        onClick={() => removeCard(card.id)}
                        className="opacity-0 transition-opacity group-hover:opacity-100 text-mist-400 hover:text-bad-400"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>

                    {f.description && card.description && (
                      <p className="mt-1 line-clamp-2 text-[12px] text-mist-400">{card.description}</p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {f.priority && card.priority && (
                        <span className={clsx("rounded px-1.5 py-0.5 text-[10.5px] font-semibold", PRIORITY_TONE[card.priority])}>
                          {card.priority}
                        </span>
                      )}
                      {f.dueDate && card.dueDate && (
                        <span
                          className={clsx(
                            "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px]",
                            new Date(card.dueDate) < new Date() ? "bg-bad-500/12 text-bad-400" : "bg-ink-700 text-mist-300",
                          )}
                        >
                          <Calendar size={9} />
                          {new Date(card.dueDate).toLocaleDateString("en", { month: "short", day: "numeric" })}
                        </span>
                      )}
                      {f.assignee && card.assignee && (
                        <span className="flex items-center gap-1 rounded bg-ink-700 px-1.5 py-0.5 text-[10.5px] text-mist-300">
                          <User size={9} /> {card.assignee}
                        </span>
                      )}
                    </div>

                    {f.tags && card.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {card.tags.map((t) => (
                          <span key={t} className="rounded bg-brand-500/12 px-1.5 py-0.5 text-[10px] text-brand-400">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}

                    {f.automationLabel && card.automationLabel && (
                      <div className="mt-1.5 flex items-center gap-1 text-[10.5px] text-brand-400">
                        <Zap size={9} /> {card.automationLabel}
                      </div>
                    )}

                    <footer className="mt-2.5 flex items-center gap-2 border-t border-ink-700/70 pt-2 text-[10.5px]">
                      <span className="flex items-center gap-1 text-mist-400">
                        <Clock size={9} /> {daysAgo(card.createdAt)}
                      </span>

                      {card.approval?.state === "approved" && (
                        <span className="ml-auto flex items-center gap-1 text-good-400">
                          <Check size={10} /> Approved {card.approval.at ? daysAgo(card.approval.at) : ""}
                        </span>
                      )}
                      {card.approval?.state === "rejected" && (
                        <span className="ml-auto flex items-center gap-1 text-bad-400"><X size={10} /> Rejected</span>
                      )}
                      {card.approval?.state === "pending" && (
                        <span className="ml-auto flex items-center gap-1.5">
                          <button
                            onClick={() => decide(card.id, "approved")}
                            className="rounded bg-good-500/15 px-2 py-0.5 font-medium text-good-400 hover:bg-good-500/25"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => decide(card.id, "rejected")}
                            className="rounded border border-ink-600 px-2 py-0.5 text-mist-300 hover:text-bad-400"
                          >
                            Reject
                          </button>
                        </span>
                      )}
                    </footer>
                  </article>
                ))}

                {list.length === 0 && addingIn !== col.id && (
                  <button
                    onClick={() => setAddingIn(col.id)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-ink-600 py-8 text-[12.5px] text-mist-400 hover:border-ink-500 hover:text-mist-200"
                  >
                    <Plus size={14} /> Add card
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* ---- Add column ---- */}
        <div className="w-[220px] shrink-0">
          {addingColumn ? (
            <input
              autoFocus
              placeholder="Column name"
              onBlur={() => setAddingColumn(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addColumn((e.target as HTMLInputElement).value || "New column");
                if (e.key === "Escape") setAddingColumn(false);
              }}
              className="w-full rounded-xl border border-brand-500 bg-ink-850 px-3 py-2.5 text-[13px] outline-none"
            />
          ) : (
            <button
              onClick={() => setAddingColumn(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-ink-600 py-3 text-[13px] text-mist-400 hover:border-ink-500 hover:text-mist-200"
            >
              <Plus size={15} /> Add column
            </button>
          )}
        </div>
      </div>

      {settingsOpen && (
        <BoardSettings
          board={board}
          onClose={() => setSettingsOpen(false)}
          onSaved={(b) => setBoard(b)}
        />
      )}
    </div>
  );
}
