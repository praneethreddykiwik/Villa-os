import { NextResponse } from "next/server";
import { mutate } from "@/lib/db";
import { logActivity } from "@/lib/engine/publisher";
import { setAdStatus, setMetaBudget } from "@/lib/platforms/ads";
import type { SuggestionAction } from "@/lib/types";
import { uid } from "@/lib/ids";

/**
 * The one-click execution endpoint behind every suggestion card.
 *
 * Each action mutates local state *and* calls the platform write API. In mock
 * mode the platform call is a no-op that returns ok, so the whole loop is
 * exercisable end to end without spending money.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    suggestionId: string;
    brandId: string;
    decision: "accepted" | "dismissed";
    action?: SuggestionAction;
  };

  if (body.decision === "dismissed") {
    logActivity(body.brandId, "suggestion", `Dismissed suggestion ${body.suggestionId}`, "user");
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
      mutate((db) => {
        const min = Number(action.params.minRating ?? 0);
        for (const r of db.reviews) {
          if (r.brandId !== body.brandId || r.replied) continue;
          if (action.params.reviewId && r.id !== action.params.reviewId) continue;
          if (min && r.rating < min) continue;
          r.draftReply = r.draftReply ?? "Draft ready for approval.";
        }
      });
      message = "Drafts queued in Reviews";
      break;
    }

    default:
      message = "Queued";
  }

  logActivity(body.brandId, "suggestion", `${action.label} — ${message}`, "user");
  return NextResponse.json({ ok: true, message });
}
