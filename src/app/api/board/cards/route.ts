import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { uid } from "@/lib/ids";
import { logActivity } from "@/lib/engine/publisher";
import type { BoardCard } from "@/lib/types";
import { guard } from "@/lib/auth/guard";

/** Create a card. Landing in a HITL column starts it as pending approval. */
export async function POST(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  const body = (await req.json()) as Partial<BoardCard> & { boardId: string; columnId: string; title: string };
  const db = read();
  const board = db.boards.find((b) => b.id === body.boardId);
  if (!board) return NextResponse.json({ ok: false, error: "board not found" }, { status: 404 });

  const column = board.columns.find((c) => c.id === body.columnId);
  const now = new Date().toISOString();
  const siblings = db.boardCards.filter((c) => c.boardId === board.id && c.columnId === body.columnId);

  const card: BoardCard = {
    id: uid("bcard"),
    boardId: board.id,
    brandId: board.brandId,
    columnId: body.columnId,
    title: body.title.slice(0, 200),
    description: body.description,
    priority: body.priority,
    dueDate: body.dueDate,
    tags: body.tags ?? [],
    assignee: body.assignee,
    automationLabel: body.automationLabel,
    linkedPostId: body.linkedPostId,
    approval: column?.hitl ? { state: "pending" } : undefined,
    order: siblings.length,
    createdAt: now,
    updatedAt: now,
  };

  mutate((d) => void d.boardCards.push(card));
  return NextResponse.json({ ok: true, card });
}

/**
 * Update or move a card.
 *
 * Moving *into* a HITL column resets approval to pending; moving out of one
 * without an approval decision is blocked, which is the whole point of marking
 * the column human-in-the-loop.
 */
export async function PATCH(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  const body = (await req.json()) as {
    cardId: string;
    columnId?: string;
    order?: number;
    approval?: BoardCard["approval"];
    patch?: Partial<BoardCard>;
    /** Set by the UI when a person explicitly overrides the HITL gate. */
    force?: boolean;
  };

  const outcome = mutate((db) => {
    const card = db.boardCards.find((c) => c.id === body.cardId);
    if (!card) return { ok: false as const, error: "card not found" };
    const board = db.boards.find((b) => b.id === card.boardId);
    if (!board) return { ok: false as const, error: "board not found" };

    if (body.approval) {
      card.approval = { ...body.approval, at: new Date().toISOString(), by: body.approval.by ?? "You" };
    }

    if (body.columnId && body.columnId !== card.columnId) {
      const from = board.columns.find((c) => c.id === card.columnId);
      const to = board.columns.find((c) => c.id === body.columnId);

      const leavingUnapprovedGate = from?.hitl && card.approval?.state !== "approved" && !body.force;
      if (leavingUnapprovedGate) {
        return {
          ok: false as const,
          error: `"${from!.name}" needs approval before this card can move. Approve it, or override.`,
          needsApproval: true,
        };
      }

      card.columnId = body.columnId;
      // Entering a gate always re-opens the decision.
      card.approval = to?.hitl ? { state: "pending" } : card.approval;
    }

    if (body.order !== undefined) card.order = body.order;
    if (body.patch) Object.assign(card, body.patch);
    card.updatedAt = new Date().toISOString();

    // Renumber the destination column so orders stay dense and stable.
    db.boardCards
      .filter((c) => c.boardId === card.boardId && c.columnId === card.columnId)
      .sort((a, b) => a.order - b.order)
      .forEach((c, i) => void (c.order = i));

    return { ok: true as const, card };
  });

  if (!outcome.ok) return NextResponse.json(outcome, { status: outcome.needsApproval ? 409 : 404 });
  return NextResponse.json(outcome);
}

export async function DELETE(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  const { cardId } = (await req.json()) as { cardId: string };
  const brandId = read().boardCards.find((c) => c.id === cardId)?.brandId;
  mutate((db) => void (db.boardCards = db.boardCards.filter((c) => c.id !== cardId)));
  if (brandId) logActivity(brandId, "board", "Card deleted", "user");
  return NextResponse.json({ ok: true });
}
