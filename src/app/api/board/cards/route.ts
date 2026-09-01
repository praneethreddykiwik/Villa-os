import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { uid } from "@/lib/ids";
import { logActivity } from "@/lib/engine/publisher";
import type { BoardCard } from "@/lib/types";
import { guard } from "@/lib/auth/guard";
import { actorLabel, getSession } from "@/lib/auth/session";

/** Create a card. Landing in a HITL column starts it as pending approval. */
export async function POST(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  // Authorship is recorded from the session, never from the payload: the
  // approval gate below refuses a card's own author, and an author a caller can
  // nominate for itself is not an author.
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in to continue." }, { status: 401 });

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
    createdBy: session.userId,
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

  // An approval is a record of who signed off, so the name comes from the
  // session rather than the request body — a caller that can label its own
  // approval with someone else's name has not been through a gate at all.
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in to continue." }, { status: 401 });

  const body = (await req.json()) as {
    cardId: string;
    columnId?: string;
    order?: number;
    /** Only the decision is read from here; the record around it is built below. */
    approval?: { state?: unknown; note?: unknown };
    patch?: Partial<BoardCard>;
    /** Set by the UI when a person explicitly overrides the HITL gate. */
    force?: boolean;
  };

  const outcome = mutate((db) => {
    const card = db.boardCards.find((c) => c.id === body.cardId);
    if (!card) return { ok: false as const, error: "card not found" };
    const board = db.boards.find((b) => b.id === card.boardId);
    if (!board) return { ok: false as const, error: "board not found" };

    // Approving and overriding are the same sign-off wearing two hats, and the
    // author of a card is not a valid signatory for either: a gate its own
    // subject can clear is decoration. Cards created before `createdBy` existed
    // record no author, so there is nobody to compare against and they fall
    // through — the check cannot invent a fact the stored record does not hold.
    const decides = body.approval !== undefined || body.force === true;
    if (decides && card.createdBy !== undefined && card.createdBy === session.userId) {
      return {
        ok: false as const,
        error: "You cannot approve or override your own card. Someone else has to sign it off.",
        selfApproval: true,
      };
    }

    if (body.approval) {
      // The record is built here rather than spread from the request. The old
      // code copied the caller's object and overwrote only `at` and `by`, so
      // `state` — the single field the gate below actually reads — arrived
      // straight out of the payload with nothing checking it was a decision at
      // all. "pending" is the server's to set, when a card enters a gated
      // column, and is not a decision a caller may assert.
      const state = body.approval.state;
      if (state !== "approved" && state !== "rejected") {
        return {
          ok: false as const,
          error: "An approval decision must be either approved or rejected.",
          invalidDecision: true,
        };
      }
      card.approval = {
        state,
        at: new Date().toISOString(),
        by: session.fullName,
        byId: session.userId,
        note: typeof body.approval.note === "string" ? body.approval.note.slice(0, 500) : undefined,
      };
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

    if (body.patch) {
      // Object.assign copied whatever the caller sent, which made `patch` a
      // second, entirely unguarded way to write the approval record — and to
      // rewrite the card's author and its column, sidestepping the gate checked
      // above. Only the descriptive fields a person edits are copied across, so
      // a field added to BoardCard later is not writable here by accident.
      const p = body.patch;
      if (p.title !== undefined) card.title = p.title.slice(0, 200);
      if (p.description !== undefined) card.description = p.description;
      if (p.priority !== undefined) card.priority = p.priority;
      if (p.dueDate !== undefined) card.dueDate = p.dueDate;
      if (p.tags !== undefined) card.tags = p.tags;
      if (p.assignee !== undefined) card.assignee = p.assignee;
      if (p.automationLabel !== undefined) card.automationLabel = p.automationLabel;
      if (p.linkedPostId !== undefined) card.linkedPostId = p.linkedPostId;
    }

    card.updatedAt = new Date().toISOString();

    // Renumber the destination column so orders stay dense and stable.
    db.boardCards
      .filter((c) => c.boardId === card.boardId && c.columnId === card.columnId)
      .sort((a, b) => a.order - b.order)
      .forEach((c, i) => void (c.order = i));

    return { ok: true as const, card };
  });

  if (!outcome.ok) {
    const status = outcome.selfApproval ? 403 : outcome.invalidDecision ? 422 : outcome.needsApproval ? 409 : 404;
    return NextResponse.json(outcome, { status });
  }
  return NextResponse.json(outcome);
}

export async function DELETE(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  // Deleting somebody else's card is the entry most likely to be asked about
  // later, so it is the one that must not read "user".
  const actor = actorLabel(await getSession());

  const { cardId } = (await req.json()) as { cardId: string };
  const brandId = read().boardCards.find((c) => c.id === cardId)?.brandId;
  mutate((db) => void (db.boardCards = db.boardCards.filter((c) => c.id !== cardId)));
  if (brandId) logActivity(brandId, "board", "Card deleted", actor);
  return NextResponse.json({ ok: true });
}
