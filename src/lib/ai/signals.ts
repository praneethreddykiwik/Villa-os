import { adTotals, inRange, lastNDays, previousRange, type Range } from "../metrics/aggregate";
import { mean, robustZ, trendSlopePct, wilsonLower } from "../metrics/stats";
import type { AdStat, Database, RankGridCell, Suggestion, SuggestionSeverity } from "../types";
import { uid } from "../ids";

/**
 * THE INSIGHT ENGINE
 * ------------------
 * Twelve independent analysers, each one a pure function of the data. They run on
 * every dashboard load and produce ranked, *executable* recommendations.
 *
 * Two design rules everything here follows:
 *
 * 1. No LLM is required to produce a recommendation. Every number, threshold and
 *    projected impact below is computed from the account's own data. An LLM is
 *    used only to *rewrite* these findings in nicer prose (see narrative.ts), so
 *    the system never invents a number and still works with no API key.
 *
 * 2. Every suggestion carries a `projectedImpact` in a comparable unit, so a
 *    creative-fatigue finding on Meta can be ranked against a posting-time finding
 *    on Instagram instead of the user reading twelve unranked cards.
 */

const DAY_MS = 86400000;

function severityRank(s: SuggestionSeverity): number {
  return s === "critical" ? 3 : s === "opportunity" ? 2 : 1;
}

function make(
  brandId: string,
  s: Omit<Suggestion, "id" | "brandId" | "createdAt" | "state">,
): Suggestion {
  return { ...s, id: uid("sug"), brandId, createdAt: new Date().toISOString(), state: "new" };
}

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

/* ------------------------------------------------------------------------- */
/* 1. Creative fatigue                                                        */
/* ------------------------------------------------------------------------- */
/**
 * The classic Meta failure mode: an ad keeps spending while the same people see
 * it over and over. Two independent symptoms, and we require BOTH so we don't
 * pause a healthy ad that simply has a small audience:
 *   - frequency above ~2.8 (the audience is being re-served), and
 *   - CTR trending down over the window (they have stopped responding).
 * CPM rising at the same time is treated as confirmation and raises severity.
 */
export function creativeFatigue(db: Database, brandId: string, range: Range): Suggestion[] {
  const rows = db.adStats.filter((r) => r.brandId === brandId && inRange(r.date, range));
  const byAd = new Map<string, AdStat[]>();
  for (const r of rows) {
    byAd.set(r.adId, [...(byAd.get(r.adId) ?? []), r]);
  }

  const out: Suggestion[] = [];
  for (const [adId, adRows] of byAd) {
    const sorted = [...adRows].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length < 7) continue;
    const spend = sorted.reduce((a, r) => a + r.spend, 0);
    if (spend < 100) continue; // not enough money at stake to bother a human

    const dailyCtr = sorted.map((r) => (r.impressions ? (r.clicks / r.impressions) * 100 : 0));
    const freq = adTotals(sorted).frequency;
    const ctrSlope = trendSlopePct(dailyCtr);
    const cpmEarly = adTotals(sorted.slice(0, Math.floor(sorted.length / 2)));
    const cpmLate = adTotals(sorted.slice(Math.floor(sorted.length / 2)));
    const cpmDrift = cpmEarly.cpm ? ((cpmLate.cpm - cpmEarly.cpm) / cpmEarly.cpm) * 100 : 0;

    if (freq < 2.8 || ctrSlope > -1.5) continue;

    const ad = db.adCampaigns
      .flatMap((c) => c.adSets.flatMap((s) => s.ads.map((a) => ({ ...a, campaign: c, adSet: s }))))
      .find((a) => a.id === adId);
    if (!ad) continue;

    // Wasted spend over the next 30 days.
    //
    // The decay rate is per *day*, so treating it as the total loss understates
    // the damage by an order of magnitude. Compound it instead: efficiency after
    // t days is (1-r)^t, and the mean efficiency over a 30-day flight is the sum
    // of that geometric series divided by the number of days. What you waste is
    // the complement of that mean.
    const dailySpend = spend / sorted.length;
    const r = Math.min(0.15, Math.abs(ctrSlope) / 100);
    const horizon = 30;
    const meanEfficiency = r > 0 ? (1 - Math.pow(1 - r, horizon)) / (horizon * r) : 1;
    const wasted = dailySpend * horizon * (1 - meanEfficiency);

    out.push(
      make(brandId, {
        kind: "creative_fatigue",
        severity: freq > 4 || cpmDrift > 25 ? "critical" : "opportunity",
        title: `"${ad.name}" is burning out`,
        rationale:
          `Frequency has reached ${freq.toFixed(1)}x and daily CTR is falling ${Math.abs(ctrSlope).toFixed(1)}% per day ` +
          `across ${sorted.length} days. CPM has drifted ${cpmDrift >= 0 ? "+" : ""}${cpmDrift.toFixed(0)}% between the first ` +
          `and second half of the window — the same people are seeing this creative and no longer clicking. ` +
          `At ${money(dailySpend)}/day, continuing without a refresh wastes roughly ${money(wasted)} over the next 30 days.`,
        projectedImpact: { metric: "Wasted spend avoided", value: Math.round(wasted), unit: "$/30d" },
        action: {
          type: "generate_variants",
          label: "Generate 3 fresh hooks from the winning frame",
          params: { adId, campaignId: ad.campaign.id },
        },
        entity: { type: "ad", id: adId, label: ad.name },
        confidence: Math.min(0.95, 0.55 + Math.abs(ctrSlope) / 60 + (freq - 2.8) / 12),
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* 2. Budget reallocation                                                     */
/* ------------------------------------------------------------------------- */
/**
 * Compares ROAS across ad sets *within the same objective* and proposes moving
 * money from the worst to the best. Uses a Wilson lower bound on conversion rate
 * rather than raw ROAS, so a lucky ad set with 3 conversions cannot win.
 * Caps any single move at 30% of the loser's budget — real accounts punish
 * large overnight budget jumps by re-entering the learning phase.
 */
export function budgetReallocation(db: Database, brandId: string, range: Range): Suggestion[] {
  const rows = db.adStats.filter((r) => r.brandId === brandId && inRange(r.date, range));
  const campaigns = db.adCampaigns.filter((c) => c.brandId === brandId && c.status === "active");
  const out: Suggestion[] = [];

  for (const campaign of campaigns) {
    const perSet = campaign.adSets
      .map((set) => {
        const setRows = rows.filter((r) => r.adSetId === set.id);
        const t = adTotals(setRows);
        return {
          set,
          t,
          score: wilsonLower(t.conversions, Math.max(t.clicks, t.conversions)) * (t.roas || 0.01),
        };
      })
      .filter((x) => x.t.spend > 50);

    if (perSet.length < 2) continue;
    const sorted = [...perSet].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best.t.roas < worst.t.roas * 1.4) continue; // not a meaningful gap

    const dailyWorst = worst.t.spend / Math.max(1, daysIn(range));
    const move = Math.round(dailyWorst * 0.3);
    if (move < 5) continue;
    const gain = move * (best.t.roas - worst.t.roas) * 30;

    out.push(
      make(brandId, {
        kind: "budget_shift",
        severity: best.t.roas > worst.t.roas * 2.5 ? "critical" : "opportunity",
        title: `Move ${money(move)}/day from "${worst.set.name}" to "${best.set.name}"`,
        rationale:
          `Inside ${campaign.name}, "${best.set.name}" returns ${best.t.roas.toFixed(2)}x on ${money(best.t.spend)} ` +
          `(${best.t.conversions.toFixed(0)} conversions, CPA ${money(best.t.cpa)}) while "${worst.set.name}" returns ` +
          `${worst.t.roas.toFixed(2)}x on ${money(worst.t.spend)} (CPA ${money(worst.t.cpa)}). ` +
          `Shifting 30% of the weaker budget — not more, so neither ad set re-enters the learning phase — ` +
          `is worth about ${money(gain)} of extra revenue over 30 days at current rates.`,
        projectedImpact: { metric: "Incremental revenue", value: Math.round(gain), unit: "$/30d" },
        action: {
          type: "shift_budget",
          label: `Shift ${money(move)}/day`,
          params: { fromAdSetId: worst.set.id, toAdSetId: best.set.id, amount: move },
        },
        entity: { type: "campaign", id: campaign.id, label: campaign.name },
        confidence: 0.72,
      }),
    );
  }
  return out;
}

function daysIn(range: Range): number {
  return Math.max(1, Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / DAY_MS) + 1);
}

/* ------------------------------------------------------------------------- */
/* 3. Boost-worthy organic posts                                              */
/* ------------------------------------------------------------------------- */
/**
 * The highest-ROI ad decision most businesses never make: put money behind the
 * organic post the audience already validated. We look for posts whose
 * engagement rate is a robust-z outlier versus the account's own last 90 days —
 * not versus an industry benchmark, which is meaningless per account — and which
 * are recent enough that the algorithm will still distribute them.
 */
export function boostOrganic(db: Database, brandId: string): Suggestion[] {
  const published = db.posts
    .filter((p) => p.brandId === brandId && p.status === "published" && p.metrics)
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  if (published.length < 8) return [];

  const history = published.map((p) => p.metrics!.engagementRate);
  const baseline = mean(history);
  const recent = published.filter(
    (p) => Date.now() - new Date(p.publishedAt!).getTime() < 10 * DAY_MS,
  );

  const out: Suggestion[] = [];
  for (const p of recent) {
    const z = robustZ(p.metrics!.engagementRate, history);
    if (z < 1.5) continue;
    const alreadyBoosted = db.adCampaigns
      .flatMap((c) => c.adSets.flatMap((s) => s.ads))
      .some((a) => a.sourcePostId === p.id);
    if (alreadyBoosted) continue;

    const lift = p.metrics!.engagementRate / (baseline || 1);
    // Paid reach estimated from the account's own blended CPM, not a guess — so
    // with no ad history there is no honest figure to project from and we say nothing.
    const blendedCpm = adTotals(db.adStats.filter((r) => r.brandId === brandId)).cpm;
    if (!blendedCpm) continue;
    const estReach = Math.round((150 / blendedCpm) * 1000);

    out.push(
      make(brandId, {
        kind: "boost_organic",
        severity: z > 2.5 ? "critical" : "opportunity",
        title: `Put $150 behind "${p.caption.slice(0, 42)}…"`,
        rationale:
          `This post is running at ${p.metrics!.engagementRate.toFixed(1)}% engagement — ${lift.toFixed(1)}x your ` +
          `${baseline.toFixed(1)}% account average, a ${z.toFixed(1)}σ outlier against your own last ${history.length} posts. ` +
          `It also held ${(p.metrics!.retention3s * 100).toFixed(0)}% of viewers past 3 seconds, so it survives being served cold. ` +
          `At your blended ${money(blendedCpm)} CPM, $150 buys roughly ${estReach.toLocaleString()} extra impressions ` +
          `on creative the audience has already voted for.`,
        projectedImpact: { metric: "Incremental reach", value: estReach, unit: "people" },
        action: { type: "boost_post", label: "Boost for $150 over 5 days", params: { postId: p.id, budget: 150, days: 5 } },
        entity: { type: "post", id: p.id, label: p.caption.slice(0, 40) },
        confidence: Math.min(0.92, 0.6 + z / 10),
      }),
    );
  }
  return out.slice(0, 3);
}

/* ------------------------------------------------------------------------- */
/* 4. Posting time                                                            */
/* ------------------------------------------------------------------------- */
/** Finds the day/hour cells that beat the account median and are being underused. */
export function postingTime(db: Database, brandId: string): Suggestion[] {
  const posts = db.posts.filter((p) => p.brandId === brandId && p.status === "published" && p.metrics);
  if (posts.length < 12) return [];

  const cells = new Map<string, { er: number[]; count: number }>();
  for (const p of posts) {
    const d = new Date(p.publishedAt!);
    const key = `${d.getDay()}-${d.getHours()}`;
    const c = cells.get(key) ?? { er: [], count: 0 };
    c.er.push(p.metrics!.engagementRate);
    c.count += 1;
    cells.set(key, c);
  }
  const overall = mean(posts.map((p) => p.metrics!.engagementRate));
  const ranked = [...cells.entries()]
    .filter(([, c]) => c.count >= 2)
    .map(([key, c]) => ({ key, avg: mean(c.er), count: c.count }))
    .sort((a, b) => b.avg - a.avg);
  if (!ranked.length) return [];

  const best = ranked[0];
  if (best.avg < overall * 1.25) return [];
  const [day, hour] = best.key.split("-").map(Number);
  const dayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day];
  const uplift = ((best.avg - overall) / overall) * 100;

  return [
    make(brandId, {
      kind: "posting_time",
      severity: "opportunity",
      title: `${dayName} ${hour}:00 outperforms your average by ${uplift.toFixed(0)}%`,
      rationale:
        `Across ${posts.length} published posts, the ${dayName} ${String(hour).padStart(2, "0")}:00 slot averages ` +
        `${best.avg.toFixed(1)}% engagement versus ${overall.toFixed(1)}% overall, on ${best.count} posts. ` +
        `You currently publish into that slot ${((best.count / posts.length) * 100).toFixed(0)}% of the time. ` +
        `Moving your next few posts there is a free uplift — it costs nothing but a change of schedule.`,
      projectedImpact: { metric: "Engagement uplift", value: Math.round(uplift), unit: "%" },
      action: { type: "reschedule", label: `Move queue to ${dayName} ${hour}:00`, params: { day, hour } },
      confidence: Math.min(0.85, 0.45 + best.count / 20),
    }),
  ];
}

/* ------------------------------------------------------------------------- */
/* 5. Format mix                                                              */
/* ------------------------------------------------------------------------- */
/** Are you making the format that actually works for this account? */
export function formatMix(db: Database, brandId: string): Suggestion[] {
  const posts = db.posts.filter((p) => p.brandId === brandId && p.status === "published" && p.metrics);
  if (posts.length < 10) return [];
  const byFormat = new Map<string, { er: number[]; reach: number[]; n: number }>();
  for (const p of posts) {
    for (const t of p.targets) {
      const f = byFormat.get(t.format) ?? { er: [], reach: [], n: 0 };
      f.er.push(p.metrics!.engagementRate);
      f.reach.push(p.metrics!.reach);
      f.n += 1;
      byFormat.set(t.format, f);
    }
  }
  const ranked = [...byFormat.entries()]
    .filter(([, v]) => v.n >= 3)
    .map(([format, v]) => ({ format, er: mean(v.er), reach: mean(v.reach), n: v.n }))
    .sort((a, b) => b.reach - a.reach);
  if (ranked.length < 2) return [];

  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const totalTargets = [...byFormat.values()].reduce((a, v) => a + v.n, 0);
  const share = (best.n / totalTargets) * 100;
  if (best.reach < worst.reach * 1.5 || share > 55) return [];

  const gain = Math.round((best.reach - worst.reach) * 4);
  return [
    make(brandId, {
      kind: "format_mix",
      severity: "opportunity",
      title: `${best.format} reaches ${(best.reach / Math.max(1, worst.reach)).toFixed(1)}x further than ${worst.format}`,
      rationale:
        `Your ${best.format} posts average ${Math.round(best.reach).toLocaleString()} reach and ${best.er.toFixed(1)}% engagement ` +
        `across ${best.n} posts, while ${worst.format} averages ${Math.round(worst.reach).toLocaleString()}. ` +
        `${best.format} is only ${share.toFixed(0)}% of what you publish. Rebalancing four posts a month from ` +
        `${worst.format} to ${best.format} is worth roughly ${gain.toLocaleString()} extra impressions with no extra ad spend.`,
      projectedImpact: { metric: "Monthly reach", value: gain, unit: "people" },
      action: { type: "change_format", label: `Plan 4 more ${best.format}s`, params: { format: best.format } },
      confidence: 0.7,
    }),
  ];
}

/* ------------------------------------------------------------------------- */
/* 6. Hook quality                                                            */
/* ------------------------------------------------------------------------- */
/**
 * For video, the first three seconds decide everything downstream. We compare
 * 3s retention against the account's own distribution and flag the systematic
 * case (many weak hooks), because that is a production-process fix, not a
 * one-post fix.
 *
 * The rationale deliberately stops at the numbers. PostMetrics carries counts
 * and retention fractions only — nothing in this codebase watches the footage —
 * so any sentence describing what is *on screen* in the strong reels would be
 * invented. We name the measurable gap and let the human look at the reels.
 */
export function hookQuality(db: Database, brandId: string): Suggestion[] {
  const videos = db.posts.filter(
    (p) =>
      p.brandId === brandId &&
      p.status === "published" &&
      p.metrics &&
      p.targets.some((t) => t.format === "reel" || t.format === "short"),
  );
  if (videos.length < 6) return [];
  const retentions = videos.map((p) => p.metrics!.retention3s);
  const avg = mean(retentions);
  const weak = videos.filter((p) => p.metrics!.retention3s < 0.45);
  if (weak.length < Math.max(2, videos.length * 0.3)) return [];

  const strong = videos.filter((p) => p.metrics!.retention3s >= 0.65);
  const strongReach = mean(strong.map((p) => p.metrics!.reach)) || 0;
  const weakReach = mean(weak.map((p) => p.metrics!.reach)) || 1;

  return [
    make(brandId, {
      kind: "hook_quality",
      severity: "critical",
      title: `${weak.length} of ${videos.length} reels lose the viewer in 3 seconds`,
      rationale:
        `Average 3-second retention is ${(avg * 100).toFixed(0)}%. The ${weak.length} weakest reels sit below 45%, and they reach ` +
        `${Math.round(weakReach).toLocaleString()} people on average — versus ${Math.round(strongReach).toLocaleString()} for reels that ` +
        `hold 65%+. That is a ${(strongReach / weakReach).toFixed(1)}x distribution difference decided in the first three seconds. ` +
        `This reads retention, not the footage — so watch the first three seconds of your strongest reels against the weakest, ` +
        `rewrite those openers, and judge the change on 3-second retention rather than on likes.`,
      projectedImpact: { metric: "Reach per reel", value: Math.round(strongReach - weakReach), unit: "people" },
      action: { type: "generate_variants", label: "Rewrite the 5 weakest hooks", params: { postIds: weak.slice(0, 5).map((p) => p.id).join(",") } },
      confidence: 0.8,
    }),
  ];
}

/* ------------------------------------------------------------------------- */
/* 7. Anomaly detection                                                       */
/* ------------------------------------------------------------------------- */
/** Robust-z on the last day vs. the previous 30 — catches breakage and virality. */
export function anomalies(db: Database, brandId: string): Suggestion[] {
  const stats = db.dailyStats
    .filter((s) => s.brandId === brandId)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (stats.length < 20) return [];

  const byDate = new Map<string, number>();
  const clicksByDate = new Map<string, number>();
  for (const s of stats) {
    byDate.set(s.date, (byDate.get(s.date) ?? 0) + s.impressions);
    clicksByDate.set(s.date, (clicksByDate.get(s.date) ?? 0) + s.linkClicks);
  }
  const dates = [...byDate.keys()].sort();
  const out: Suggestion[] = [];

  for (const [label, series, unit] of [
    ["Impressions", byDate, "impressions"],
    ["Link clicks", clicksByDate, "clicks"],
  ] as const) {
    const values = dates.map((d) => series.get(d) ?? 0);
    const last = values[values.length - 1];
    const history = values.slice(-31, -1);
    const z = robustZ(last, history);
    if (Math.abs(z) < 2.5) continue;
    const expected = mean(history);
    out.push(
      make(brandId, {
        kind: "anomaly",
        severity: z < 0 ? "critical" : "info",
        title:
          z < 0
            ? `${label} dropped ${Math.abs(((last - expected) / expected) * 100).toFixed(0)}% yesterday`
            : `${label} spiked ${(((last - expected) / expected) * 100).toFixed(0)}% yesterday`,
        rationale:
          `${label} came in at ${Math.round(last).toLocaleString()} against a 30-day median of ${Math.round(expected).toLocaleString()} ` +
          `(${z.toFixed(1)}σ using median absolute deviation, so a single earlier spike is not skewing this). ` +
          (z < 0
            ? `Check in order: a connection token expired, a post failed to publish, or an ad set exhausted its budget.`
            : `Find what caused it and repeat it deliberately — spikes you cannot explain are spikes you cannot reproduce.`),
        projectedImpact: { metric: label, value: Math.round(Math.abs(last - expected)), unit },
        confidence: Math.min(0.9, 0.5 + Math.abs(z) / 10),
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* 8. Budget pacing                                                           */
/* ------------------------------------------------------------------------- */
/** Will this campaign under- or over-spend before it ends? */
export function pacing(db: Database, brandId: string): Suggestion[] {
  const out: Suggestion[] = [];
  const now = new Date();
  for (const c of db.adCampaigns.filter((c) => c.brandId === brandId && c.status === "active")) {
    if (!c.endDate) continue;
    const start = new Date(c.startDate).getTime();
    const end = new Date(c.endDate).getTime();
    if (end <= now.getTime()) continue;
    const elapsedDays = Math.max(1, (now.getTime() - start) / DAY_MS);
    const totalDays = Math.max(1, (end - start) / DAY_MS);
    const planned = c.dailyBudget * totalDays;
    const actualDaily = c.lifetimeSpend / elapsedDays;
    const projected = actualDaily * totalDays;
    const drift = ((projected - planned) / planned) * 100;
    if (Math.abs(drift) < 15) continue;

    out.push(
      make(brandId, {
        kind: "pacing",
        severity: Math.abs(drift) > 30 ? "critical" : "opportunity",
        title: `${c.name} is pacing to ${drift > 0 ? "overspend" : "underspend"} by ${Math.abs(drift).toFixed(0)}%`,
        rationale:
          `Planned budget is ${money(planned)} over ${Math.round(totalDays)} days. After ${Math.round(elapsedDays)} days you have spent ` +
          `${money(c.lifetimeSpend)} — ${money(actualDaily)}/day against a ${money(c.dailyBudget)}/day plan — which projects to ` +
          `${money(projected)} by ${new Date(c.endDate).toLocaleDateString()}. ` +
          (drift > 0
            ? `Lower the daily cap now; catching this late means an abrupt stop that kills delivery at the end of the flight.`
            : `Raise the cap or widen targeting: unspent budget at the end of a flight is reach you paid for and never received.`),
        projectedImpact: { metric: "Budget variance", value: Math.round(Math.abs(projected - planned)), unit: "$" },
        action: {
          type: drift > 0 ? "lower_budget" : "raise_budget",
          label: `Set daily cap to ${money(planned / totalDays)}`,
          params: { campaignId: c.id, dailyBudget: Math.round(planned / totalDays) },
        },
        entity: { type: "campaign", id: c.id, label: c.name },
        confidence: 0.85,
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* 9. Review response                                                         */
/* ------------------------------------------------------------------------- */
/**
 * Unanswered reviews are the cheapest fix in local marketing: response rate is a
 * ranking-adjacent trust signal, and negatives left unanswered are the first
 * thing a prospect reads.
 */
export function reviewResponse(db: Database, brandId: string): Suggestion[] {
  const reviews = db.reviews.filter((r) => r.brandId === brandId);
  if (!reviews.length) return [];
  const unreplied = reviews.filter((r) => !r.replied);
  const negatives = unreplied.filter((r) => r.rating <= 3);
  const rate = ((reviews.length - unreplied.length) / reviews.length) * 100;
  const out: Suggestion[] = [];

  if (negatives.length) {
    const oldest = [...negatives].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const ageDays = Math.round((Date.now() - new Date(oldest.createdAt).getTime()) / DAY_MS);
    out.push(
      make(brandId, {
        kind: "review_response",
        severity: "critical",
        title: `${negatives.length} negative review${negatives.length > 1 ? "s" : ""} unanswered`,
        rationale:
          `The oldest has been sitting ${ageDays} days. Negative reviews are read disproportionately by people close to booking, ` +
          `and an unanswered one reads as confirmation. Common themes across them: ${topTopics(negatives)}. ` +
          `Nothing is drafted yet — replies are written on demand from the review's own text, so each one names the ` +
          `specific issue instead of reading as a template, and moves whatever is unresolved off the public thread.`,
        projectedImpact: { metric: "Response rate", value: Math.round(100 - rate), unit: "% to recover" },
        action: { type: "reply_review", label: "Draft a reply", params: { reviewId: oldest.id } },
        entity: { type: "review", id: oldest.id, label: `${oldest.author} · ${oldest.rating}★` },
        confidence: 0.95,
      }),
    );
  }
  if (rate < 70 && unreplied.length > 3) {
    out.push(
      make(brandId, {
        kind: "review_response",
        severity: "opportunity",
        title: `Reply rate is ${rate.toFixed(0)}% — ${unreplied.length} reviews waiting`,
        rationale:
          `You have answered ${reviews.length - unreplied.length} of ${reviews.length} reviews. Businesses that answer consistently ` +
          `earn more subsequent reviews, because responding publicly demonstrates that leaving one is worth the effort. ` +
          `Turning on auto-reply for 4–5★ reviews clears ${unreplied.filter((r) => r.rating >= 4).length} of these immediately and ` +
          `leaves only the ones that need a human.`,
        projectedImpact: { metric: "Reviews cleared", value: unreplied.length, unit: "reviews" },
        action: { type: "reply_review", label: "Auto-reply to 4–5★", params: { minRating: 4 } },
        confidence: 0.9,
      }),
    );
  }
  return out;
}

function topTopics(rs: { topics: string[] }[]): string {
  const counts = new Map<string, number>();
  for (const r of rs) for (const t of r.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t, n]) => `${t} (${n})`)
      .join(", ") || "no repeated theme"
  );
}

/* ------------------------------------------------------------------------- */
/* 10. Local visibility                                                       */
/* ------------------------------------------------------------------------- */
/** Reads the rank grid the way a local SEO would: where do you fall off the map? */
export function localVisibility(db: Database, brandId: string): Suggestion[] {
  const cells = db.rankGrid.filter((c) => c.brandId === brandId);
  if (!cells.length) return [];
  // Keep whole cells, not just ranks: where a cell sits in the grid is half the
  // finding, and averaging the ranks throws that away.
  const byKeyword = new Map<string, RankGridCell[]>();
  for (const c of cells) byKeyword.set(c.keyword, [...(byKeyword.get(c.keyword) ?? []), c]);

  const out: Suggestion[] = [];
  for (const [keyword, kwCells] of byKeyword) {
    const ranks = kwCells.map((c) => c.rank);
    const avg = mean(ranks);
    const inTop3 = ranks.filter((r) => r <= 3).length;
    const invisible = ranks.filter((r) => r >= 15).length;
    const coverage = (inTop3 / ranks.length) * 100;
    if (coverage > 60) continue;

    // Dimensions from the actual row/col span rather than sqrt(cell count),
    // which quietly assumes the grid is square and complete.
    const rows = new Set(kwCells.map((c) => c.row)).size;
    const cols = new Set(kwCells.map((c) => c.col)).size;

    out.push(
      make(brandId, {
        kind: "local_visibility",
        severity: coverage < 25 ? "critical" : "opportunity",
        title: `"${keyword}" only ranks top-3 in ${coverage.toFixed(0)}% of your area`,
        rationale:
          `Across a ${rows}x${cols} grid your average position is ` +
          `${avg.toFixed(1)}, top-3 in ${inTop3} of ${ranks.length} points, and outside the top 15 in ${invisible}. ` +
          `${edgeFalloff(kwCells)} The levers that move a weak cell are review velocity from the area it covers, ` +
          `a weekly Google post naming that area, and services and photos tagged to it.`,
        projectedImpact: { metric: "Grid points to win", value: ranks.length - inTop3, unit: "cells" },
        confidence: 0.75,
      }),
    );
  }
  return out.slice(0, 2);
}

/**
 * Does rank actually decay towards the edge of *this* grid?
 *
 * It usually does — proximity to the searcher is the strongest factor in the
 * local pack — but "usually" is not this account, and telling someone to work
 * the edges when they are in fact weakest next to their own pin sends them at
 * the wrong postcodes. So measure it: the outer ring (any cell on the first or
 * last row or column) against the interior. A grid one cell deep has no
 * interior and therefore no answer, and we say that rather than guessing.
 */
function edgeFalloff(cells: RankGridCell[]): string {
  const rows = cells.map((c) => c.row);
  const cols = cells.map((c) => c.col);
  const minRow = Math.min(...rows);
  const maxRow = Math.max(...rows);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);
  const isEdge = (c: RankGridCell) =>
    c.row === minRow || c.row === maxRow || c.col === minCol || c.col === maxCol;

  const edge = cells.filter(isEdge);
  const inner = cells.filter((c) => !isEdge(c));
  if (!edge.length || !inner.length) {
    return "The grid is too shallow to say whether the weakness sits at its edges or runs through the whole area.";
  }

  const edgeAvg = mean(edge.map((c) => c.rank));
  const innerAvg = mean(inner.map((c) => c.rank));
  // One full position is the smallest gap worth calling a direction; below that
  // the two halves are the same grid read twice.
  const gap = edgeAvg - innerAvg;
  if (gap >= 1) {
    return (
      `The outer ring averages position ${edgeAvg.toFixed(1)} against ${innerAvg.toFixed(1)} nearer the pin, ` +
      `so you are losing at the edge of your radius.`
    );
  }
  if (gap <= -1) {
    return (
      `The outer ring averages position ${edgeAvg.toFixed(1)} against ${innerAvg.toFixed(1)} nearer the pin, ` +
      `so this is not a distance problem — you are weakest closest to home.`
    );
  }
  return (
    `Edge cells average ${edgeAvg.toFixed(1)} and interior cells ${innerAvg.toFixed(1)}, ` +
    `so the weakness is spread across the grid rather than concentrated at its edges.`
  );
}

/* ------------------------------------------------------------------------- */
/* 11. Competitor gap                                                         */
/* ------------------------------------------------------------------------- */
export function competitorGap(db: Database, brandId: string, range: Range): Suggestion[] {
  const comps = db.competitors.filter((c) => c.brandId === brandId);
  if (!comps.length) return [];
  const stats = db.dailyStats.filter((s) => s.brandId === brandId && inRange(s.date, range));
  const myPosts = stats.reduce((a, s) => a + s.posts, 0);
  const days = daysIn(range);
  const myPerWeek = (myPosts / days) * 7;
  const theirPerWeek = mean(comps.map((c) => c.postsPerWeek));
  const fastest = [...comps].sort((a, b) => b.followerDelta30d - a.followerDelta30d)[0];

  const out: Suggestion[] = [];
  if (theirPerWeek > myPerWeek * 1.5) {
    out.push(
      make(brandId, {
        kind: "cadence",
        severity: "opportunity",
        title: `Competitors publish ${(theirPerWeek / Math.max(0.1, myPerWeek)).toFixed(1)}x more often`,
        rationale:
          `You are averaging ${myPerWeek.toFixed(1)} posts/week across all channels; the ${comps.length} tracked competitors average ` +
          `${theirPerWeek.toFixed(1)}. ${fastest.name} added ${fastest.followerDelta30d.toLocaleString()} followers in 30 days at ` +
          `${fastest.postsPerWeek}/week, mostly ${fastest.topFormat}s. Cadence is the cheapest variable here — it needs no budget, ` +
          `only a queue that does not run dry.`,
        projectedImpact: { metric: "Posts/week gap", value: Math.round(theirPerWeek - myPerWeek), unit: "posts" },
        confidence: 0.68,
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* 12. Queue health                                                           */
/* ------------------------------------------------------------------------- */
/** The unglamorous one that saves accounts: is the queue about to run empty? */
export function queueHealth(db: Database, brandId: string): Suggestion[] {
  const scheduled = db.posts.filter(
    (p) => p.brandId === brandId && (p.status === "scheduled" || p.status === "approved") && p.scheduledAt,
  );
  const horizonDays = scheduled.length
    ? Math.max(
        0,
        (new Date([...scheduled].sort((a, b) => b.scheduledAt!.localeCompare(a.scheduledAt!))[0].scheduledAt!).getTime() -
          Date.now()) /
          DAY_MS,
      )
    : 0;
  const failed = db.posts.filter((p) => p.brandId === brandId && p.status === "failed");
  const out: Suggestion[] = [];

  if (failed.length) {
    out.push(
      make(brandId, {
        kind: "anomaly",
        severity: "critical",
        title: `${failed.length} post${failed.length > 1 ? "s" : ""} failed to publish`,
        rationale:
          `These were scheduled but the platform rejected or timed out on them: ` +
          `${failed.map((p) => p.targets.find((t) => t.error)?.error ?? "unknown error").slice(0, 2).join("; ")}. ` +
          `They stay in the queue and can be retried once the cause is cleared.`,
        projectedImpact: { metric: "Posts to recover", value: failed.length, unit: "posts" },
        confidence: 1,
      }),
    );
  }

  // A healthy queue is not a finding — only report runway when it is short.
  if (horizonDays >= 7) return out;

  out.push(
    make(brandId, {
      kind: "cadence",
      severity: horizonDays < 2 ? "critical" : "opportunity",
      title:
        scheduled.length === 0
          ? "Your queue is empty"
          : `Only ${horizonDays.toFixed(1)} days of content scheduled`,
      rationale:
        `${scheduled.length} post${scheduled.length === 1 ? "" : "s"} remain in the queue. Reach decay after a publishing gap is ` +
        `not linear — accounts that go quiet for a week take two to three weeks to recover their previous distribution. ` +
        `There are ${db.ideas.filter((i) => i.brandId === brandId && !i.used).length} unused ideas ready to fill it.`,
      projectedImpact: { metric: "Queue runway", value: Math.round(horizonDays), unit: "days" },
      confidence: 0.99,
    }),
  );
  return out;
}

/* ------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Run every analyser and rank the output. Ranking is severity first, then
 * confidence-weighted impact normalised within each unit — you cannot compare
 * "$4,200" to "18%" directly, so we rank within unit and interleave.
 */
export function generateSuggestions(db: Database, brandId: string, range = lastNDays(30)): Suggestion[] {
  const all = [
    ...creativeFatigue(db, brandId, range),
    ...budgetReallocation(db, brandId, range),
    ...boostOrganic(db, brandId),
    ...postingTime(db, brandId),
    ...formatMix(db, brandId),
    ...hookQuality(db, brandId),
    ...anomalies(db, brandId),
    ...pacing(db, brandId),
    ...reviewResponse(db, brandId),
    ...localVisibility(db, brandId),
    ...competitorGap(db, brandId, range),
    ...queueHealth(db, brandId),
  ];

  const byUnit = new Map<string, number>();
  for (const s of all) {
    byUnit.set(s.projectedImpact.unit, Math.max(byUnit.get(s.projectedImpact.unit) ?? 0, s.projectedImpact.value));
  }

  return all
    .map((s) => ({
      s,
      score:
        severityRank(s.severity) * 1000 +
        s.confidence * 100 * (s.projectedImpact.value / (byUnit.get(s.projectedImpact.unit) || 1)),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

export { previousRange };
