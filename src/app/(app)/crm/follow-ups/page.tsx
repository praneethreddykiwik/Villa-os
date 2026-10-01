import { redirect } from "next/navigation";

/**
 * Moved to the records the agents actually write.
 *
 * This screen read the local JSON store. The WhatsApp and voice agents write
 * to Supabase (villa_follow_ups), and nothing ever copied between the two — so a lead
 * that messaged in appeared on one page and was invisible on this one. The
 * two lists were different products wearing the same name.
 *
 * Kept as a redirect rather than deleted so bookmarks, in-app links and
 * anything the team has pasted into a chat still land somewhere real. The
 * query string is carried across so ?highlight= and friends survive.
 */
export const dynamic = "force-dynamic";

export default async function FollowUpsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") qs.set(k, v);
    else if (Array.isArray(v)) for (const one of v) qs.append(k, one);
  }
  const query = qs.toString();
  redirect(query ? `/inbox/whatsapp/crm/follow-ups?${query}` : "/inbox/whatsapp/crm/follow-ups");
}
