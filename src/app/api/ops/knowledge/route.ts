import { read, resolveBrandId } from "@/lib/db";
import { guard } from "@/lib/auth/guard";
import { fail, handleError, ok } from "@/lib/ops/http";
import { deleteEntry, ensureKnowledge, forgetKnowledgeCache, KB_TOPICS, listEntries, listGaps, resolveGap, retrieve, upsertEntry } from "@/lib/ops/knowledge";

/**
 * WhatsApp knowledge base admin.
 *
 *   GET    ?brand=&q=        entries + unanswered gaps (q previews retrieval)
 *   POST   {brand, entry}    create; {brand, resync:true} re-reads the facts file
 *   PATCH  {brand, entry}    update by id
 *   DELETE ?brand=&id= | &gap=   remove an entry, or dismiss a gap
 *
 * Gated on workflows.manage: what the assistant may say to customers is
 * configuration, not day-to-day sales work.
 */

function brandFrom(url: URL, body?: { brand?: string; brandId?: string }): string {
  return resolveBrandId(read(), body?.brandId ?? body?.brand ?? url.searchParams.get("brand"));
}

export async function GET(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    const brandId = brandFrom(url);
    if (!brandId) return fail("No brand configured.", 404);
    const seeded = ensureKnowledge(brandId);
    const q = url.searchParams.get("q")?.trim();
    return ok({
      brandId,
      topics: KB_TOPICS,
      seeded,
      entries: listEntries(brandId),
      gaps: listGaps(brandId),
      preview: q ? retrieve(brandId, q) : undefined,
    });
  } catch (e) {
    return handleError(e);
  }
}

interface EntryBody {
  brand?: string;
  brandId?: string;
  resync?: boolean;
  entry?: { id?: string; topic?: string; question?: string; answer?: string; keywords?: string[] | string; public?: boolean };
}

export async function POST(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as EntryBody;
    const brandId = brandFrom(new URL(req.url), body);
    if (!brandId) return fail("No brand configured.", 404);
    if (body.resync) {
      forgetKnowledgeCache();
      return ok({ seeded: ensureKnowledge(brandId), entries: listEntries(brandId) });
    }
    const e = body.entry;
    if (!e?.question?.trim() || !e?.answer?.trim()) return fail("question and answer are required.", 400);
    const entry = upsertEntry({ brandId, topic: e.topic, question: e.question, answer: e.answer, keywords: e.keywords, public: Boolean(e.public), source: "admin" });
    return ok({ entry }, 201);
  } catch (e) {
    return handleError(e);
  }
}

export async function PATCH(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as EntryBody;
    const brandId = brandFrom(new URL(req.url), body);
    const e = body.entry;
    if (!e?.id) return fail("entry.id is required.", 400);
    const existing = read().kbEntries.find((x) => x.id === e.id && x.brandId === brandId);
    if (!existing) return fail("Entry not found.", 404);
    const entry = upsertEntry({
      id: e.id,
      brandId,
      topic: e.topic ?? existing.topic,
      question: e.question ?? existing.question,
      answer: e.answer ?? existing.answer,
      keywords: e.keywords ?? existing.keywords,
      public: e.public ?? existing.public,
      // An edited row is the admin's now, whatever seeded it — a resync must not overwrite it.
      source: "admin",
    });
    return ok({ entry });
  } catch (e) {
    return handleError(e);
  }
}

export async function DELETE(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    const brandId = brandFrom(url);
    const gap = url.searchParams.get("gap");
    if (gap) return resolveGap(gap) ? ok({ removed: gap }) : fail("Gap not found.", 404);
    const id = url.searchParams.get("id");
    if (!id) return fail("id or gap is required.", 400);
    return deleteEntry(brandId, id) ? ok({ removed: id }) : fail("Entry not found.", 404);
  } catch (e) {
    return handleError(e);
  }
}
