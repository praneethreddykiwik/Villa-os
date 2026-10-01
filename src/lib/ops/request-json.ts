/**
 * A POST/PATCH whose two failure paths are turned into a message instead of a
 * rejection.
 *
 * Both of these escape a click handler as an unhandled promise rejection if
 * they are not caught, and both look identical to the operator: the spinner
 * stops, the control snaps back to where it was, and nothing is said. They then
 * reasonably conclude the button is broken.
 *
 *   1. `fetch` itself rejects — offline, DNS, an aborted request.
 *   2. `res.json()` rejects — a proxy or CDN returned an HTML error page, which
 *      is exactly what a 502 looks like from the browser's side.
 *
 * `src/components/ops/sales-actions.tsx` worked this out first and wrote it
 * inline; this is that logic, shared, so the next caller gets it for free.
 */
export type JsonOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

export async function requestJson<T>(url: string, init: RequestInit): Promise<JsonOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, error: "Could not reach the server — nothing was changed." };
  }

  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return {
      ok: false,
      error: `The server returned an unreadable response (HTTP ${res.status}). Nothing was changed.`,
    };
  }
}
