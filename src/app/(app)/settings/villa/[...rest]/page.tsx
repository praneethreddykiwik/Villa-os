import { redirect } from "next/navigation";

/**
 * The villa profile's tabs moved up a level when it became Settings.
 *
 * Kept as a redirect rather than deleted: these paths were in the navigation
 * for weeks, and a bookmark or a link in a message should still land on the
 * screen it used to open instead of a not-found page.
 */
export default async function VillaProfileSubpathRedirect({
  params,
}: {
  params: Promise<{ rest: string[] }>;
}) {
  const { rest } = await params;
  // Each segment is re-encoded: it arrives decoded, and a stray slash or
  // percent in it would otherwise change which path this resolves to.
  const tail = rest.map(encodeURIComponent).join("/");
  redirect(tail ? `/settings/${tail}` : "/settings");
}
