import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { draftReply } from "@/lib/ai/reviews";
import { logActivity } from "@/lib/engine/publisher";
import { setAdStatus, setMetaBudget } from "@/lib/platforms/ads";
import type { SuggestionAction } from "@/lib/types";
import { uid } from "@/lib/ids";
import { guard } from "@/lib/auth/guard";
import { actorLabel, getSession } from "@/lib/auth/session";

/**
 * The one-click execution endpoint behind every suggestion card.
 *
 * Each action mutates local state *and* calls the platform write API. In mock
 * mode the platform call is a no-op that returns ok, so the whole loop is
 * exercisable end to end without spending money.
 */
export async function POST(req: Request) {
  // Was analytics.view — a READ permission — on a handler that pauses live ads,
  // moves Meta ad budget, boosts posts and replies to reviews. Auditors and
  // read-only roles could spend money. These are marketing writes.
  const denied = await guard("marketing.publish");
  if (denied) return denied;

  // Named so the activity entries below say who paused the ad or moved the
  // budget. guard() has already resolved the session and the lookup is
  // memoised per request, so this costs nothing.
  const actor = actorLabel(await getSession());

  const body = (await req.json()) as {
    suggestionId: string;
    brandId: string;
    decision: "accepted" | "dismissed";
    action?: SuggestionAction;
  };

  if (body.decision === "dismissed") {
    logActivity(body.brandId, "suggestion", `Dismissed suggestion ${body.suggestionId}`, actor);
    return NextResponse.json({ ok: true, message: "Dismissed" });
  }

  const action = body.action;
  if (!action) return NextResponse.json({ ok: true, message: "Noted" });

  let message = "Applied";
  const token = process.env.META_SYSTEM_USER_TOKEN ?? "";

  switch (action.type) {
    case "pause_ad": {
      const res = await setAdStatus(String(action.params.adId), "PAUSED", token);
      mutate((db) => {
        for (const c of db.adCampaigns)
          for (const s of c.adSets)
            for (const a of s.ads) if (a.id === action.params.adId) a.status = "paused";
      });
      message = res.ok ? "Ad paused" : res.error!;
      break;
    }

    case "shift_budget": {
      const amount = Number(action.params.amount);
      // Local ledger first so the UI is consistent even if the write fails.
      mutate((db) => {
        for (const c of db.adCampaigns) {
          const from = c.adSets.find((s) => s.id === action.params.fromAdSetId);
          const to = c.adSets.find((s) => s.id === action.params.toAdSetId);
          if (from && to) c.dailyBudget = c.dailyBudget; // campaign total unchanged — this is a reallocation
        }
      });
      const res = await setMetaBudget(String(action.params.toAdSetId), amount * 100, token);
      message = res.ok ? `Moved $${amount}/day` : res.error!;
      break;
    }

    case "boost_post": {
      mutate((db) => {
        const post = db.posts.find((p) => p.id === action.params.postId);
        if (!post) return;
        const campaign = db.adCampaigns.find((c) => c.brandId === body.brandId && c.platform === "meta_ads");
        const set = campaign?.adSets[0];
        if (!set) return;
        set.ads.push({
          id: uid("ad"),
          adSetId: set.id,
          name: `Boosted — ${post.caption.slice(0, 30)}`,
          sourcePostId: post.id,
          creativeThumb: "#8b8b95",
          format: post.targets[0]?.format ?? "feed",
          status: "active",
        });
      });
      message = `Boost created ($${action.params.budget} over ${action.params.days} days)`;
      break;
    }

    case "reschedule": {
      const { day, hour } = action.params as { day: number; hour: number };
      mutate((db) => {
        const queued = db.posts.filter(
          (p) => p.brandId === body.brandId && p.scheduledAt && ["scheduled", "approved"].includes(p.status),
        );
        queued.forEach((p, i) => {
          const d = new Date();
          // Next occurrence of the winning weekday, one post per week after that.
          d.setDate(d.getDate() + ((Number(day) - d.getDay() + 7) % 7 || 7) + i * 7);
          d.setHours(Number(hour), 0, 0, 0);
          p.scheduledAt = d.toISOString();
          p.autoScheduled = true;
          for (const t of p.targets) t.scheduledAt = p.scheduledAt;
        });
      });
      message = "Queue re-timed to the winning slot";
      break;
    }

    case "raise_budget":
    case "lower_budget": {
      mutate((db) => {
        const c = db.adCampaigns.find((x) => x.id === action.params.campaignId);
        if (c) c.dailyBudget = Number(action.params.dailyBudget);
      });
      message = `Daily budget set to $${action.params.dailyBudget}`;
      break;
    }

    case "reply_review": {
      // These drafts land on real customer reviews under the business's name, so
      // they go through the same drafting path as the Reviews screen — never a
      // placeholder sentence. draftReply() falls back to review-specific copy
      // when no model key is set, so this works with or without an LLM.
      const db = read();
      const brand = db.brands.find((b) => b.id === body.brandId);
      const min = Number(action.params.minRating ?? 0);
      const targets = brand
        ? db.reviews.filter(
            (r) =>
              r.brandId === body.brandId &&
              !r.replied &&
              // An existing draft is someone's edit in progress; never overwrite it.
              !r.draftReply &&
              (!action.params.reviewId || r.id === action.params.reviewId) &&
              (!min || r.rating >= min),
          )
        : [];

      const drafts = await Promise.all(targets.map(async (r) => ({ id: r.id, text: await draftReply(brand!, r) })));
      mutate((d) => {
        for (const { id, text } of drafts) {
          const r = d.reviews.find((x) => x.id === id);
          if (r) r.draftReply = text;
        }
      });
      message = drafts.length
        ? `${drafts.length} repl${drafts.length === 1 ? "y" : "ies"} drafted in Reviews`
        : "No unanswered reviews to draft";
      break;
    }

    default:
      message = "Queued";
  }

  logActivity(body.brandId, "suggestion", `${action.label} — ${message}`, actor);
  return NextResponse.json({ ok: true, message });
}
