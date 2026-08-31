import { NextResponse } from "next/server";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { makeBoard, templateColumns } from "@/lib/board/templates";
import { logActivity } from "@/lib/engine/publisher";
import type { Board, BoardColumn, BoardFieldKey } from "@/lib/types";

/** Fetch (creating on first use) the board for a brand. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const db = read();
  const brandId = resolveBrandId(db, url.searchParams.get("brand"));
  let board = db.boards.find((b) => b.brandId === brandId);
  if (!board) {
    const created = makeBoard(brandId, `${db.brands.find((b) => b.id === brandId)?.name ?? "New"} Board`);
    mutate((d) => void d.boards.push(created));
    board = created;
  }
  return NextResponse.json({ ok: true, board, cards: db.boardCards.filter((c) => c.boardId === board!.id) });
}

/**
 * Update board settings: rename, reorder/add/remove columns, toggle HITL,
 * cycle colours, toggle card fields, or apply a template.
 *
 * Applying a template replaces the column set but never deletes cards — cards
 * left pointing at a removed column become orphans and are surfaced in the UI
 * for a human to rehome. Destroying work to apply a layout is not a trade we
 * make silently.
 */
export async function PATCH(req: Request) {
  const body = (await req.json()) as {
    boardId: string;
    name?: string;
    columns?: BoardColumn[];
    fields?: Partial<Record<BoardFieldKey, boolean>>;
    applyTemplate?: string;
  };

  const result = mutate((db) => {
    const board = db.boards.find((b) => b.id === body.boardId);
    if (!board) return null;

    if (body.name !== undefined) board.name = body.name.slice(0, 80);
    if (body.columns) board.columns = body.columns;
    if (body.fields) board.fields = { ...board.fields, ...body.fields };

    if (body.applyTemplate) {
      const previous = board.columns;
      const next = templateColumns(body.applyTemplate);

      // Remap cards by column *position*, not id: template columns get fresh ids,
      // so without this every card on the board would orphan on every template
      // change — technically non-destructive, practically unusable. Cards in
      // columns beyond the new template's length still orphan, and the UI offers
      // to rehome those.
      const byIndex = new Map(previous.map((c, i) => [c.id, next[i]?.id]));
      for (const card of db.boardCards) {
        if (card.boardId !== board.id) continue;
        const target = byIndex.get(card.columnId);
        if (target) card.columnId = target;
      }

      board.columns = next;
      board.templateId = body.applyTemplate;
    }

    board.updatedAt = new Date().toISOString();
    return board as Board;
  });

  if (!result) return NextResponse.json({ ok: false, error: "board not found" }, { status: 404 });

  const orphans = read().boardCards.filter(
    (c) => c.boardId === result.id && !result.columns.some((col) => col.id === c.columnId),
  ).length;

  logActivity(result.brandId, "board", `Board settings updated${body.applyTemplate ? ` — template "${body.applyTemplate}"` : ""}`, "user");
  return NextResponse.json({ ok: true, board: result, orphans });
}
