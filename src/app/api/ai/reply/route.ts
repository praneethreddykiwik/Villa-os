import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { draftReply } from "@/lib/ai/reviews";
import { guard } from "@/lib/auth/guard";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";

/** Draft (or publish) a review reply. Drafting never posts — a human clicks send. */
export async function POST(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  try {
    let body: { reviewId?: string; publish?: boolean; text?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return apiFail("Request body must be valid JSON.", 400);
    }

    if (!body.reviewId) return apiFail("reviewId is required.", 400);

    const db = read();
    const review = db.reviews.find((r) => r.id === body.reviewId);
    if (!review) return apiFail("Review not found.", 404);
    const brand = db.brands.find((b) => b.id === review.brandId);
    if (!brand) return apiFail("Brand not found.", 404);

    if (body.publish) {
      const text = body.text ?? review.draftReply ?? "";
      mutate((d) => {
        const r = d.reviews.find((x) => x.id === body.reviewId)!;
        r.replied = true;
        r.reply = text;
        r.repliedAt = new Date().toISOString();
        r.draftReply = undefined;
      });
      return apiOk({ reply: text });
    }

    const text = await draftReply(brand, review);
    mutate((d) => {
      const r = d.reviews.find((x) => x.id === body.reviewId)!;
      r.draftReply = text;
    });
    return apiOk({ draft: text });
  } catch (e) {
    return apiError(e);
  }
}


/** Bulk-draft every unanswered review at or above a rating threshold. */
export async function PUT(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  const { brandId, minRating = 4 } = (await req.json()) as { brandId: string; minRating?: number };
  const db = read();
  const brand = db.brands.find((b) => b.id === brandId)!;
  const targets = db.reviews.filter((r) => r.brandId === brandId && !r.replied && r.rating >= minRating);
  const drafts = await Promise.all(targets.map(async (r) => ({ id: r.id, text: await draftReply(brand, r) })));
  mutate((d) => {
    for (const { id, text } of drafts) {
      const r = d.reviews.find((x) => x.id === id);
      if (r) r.draftReply = text;
    }
  });
  return NextResponse.json({ ok: true, count: drafts.length });
}
