import { NextResponse } from "next/server";

/**
 * Shared plumbing for route handlers that back a plain <form> POST.
 *
 * Every console page submits real forms so the pages work with zero client JS;
 * the same handlers also accept JSON so a cron or the agent can call them.
 * The two paths differ only in how a result is returned: a browser needs a 303
 * back to the page, a script needs the body.
 */

export interface PostBody {
  /** True when the caller sent JSON rather than submitting a form. */
  json: boolean;
  /** Trimmed value, or undefined when absent or blank. */
  get(name: string): string | undefined;
  /** Checkbox semantics: "on" from a form, true/"true"/"1" from JSON. */
  bool(name: string): boolean;
}

export async function readPost(request: Request): Promise<PostBody> {
  const json = (request.headers.get("content-type") ?? "").includes("application/json");
  const values: Record<string, string> = {};

  if (json) {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined) continue;
      values[key] = typeof value === "string" ? value : String(value);
    }
  } else {
    // A POST with no body at all (a bodiless logout, a probe) makes formData()
    // throw on the missing content-type, which would surface as a 500 from
    // every route using this helper. An empty form is the honest reading.
    const form = await request.formData().catch(() => new FormData());
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") values[key] = value;
    }
  }

  return {
    json,
    get(name) {
      const value = values[name];
      if (value === undefined) return undefined;
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    },
    bool(name) {
      const value = values[name];
      return value === "on" || value === "true" || value === "1";
    },
  };
}

/**
 * An in-app path supplied by the caller, or the fallback.
 *
 * Rejects anything that isn't a same-origin absolute path so a crafted `next`
 * field can't turn a form button into an open redirect.
 *
 * A plain `startsWith("//")` test is not enough, because `respond()` feeds the
 * result to the WHATWG URL parser and that parser normalises before it decides
 * on an origin: it drops tab/CR/LF anywhere in the input and treats `\` as `/`
 * for http(s). So `/\evil.com` and `/<TAB>/evil.com` both parse as an
 * authority. Normalise the same way first, then confirm against the parser
 * itself and hand back its canonical output rather than the raw string.
 */
export function safePath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;

  const normalized = value.replace(/[\t\n\r]/g, "").replace(/\\/g, "/");
  if (!normalized.startsWith("/") || normalized.startsWith("//")) return fallback;

  const base = "http://safe-path.invalid";
  try {
    const url = new URL(value, base);
    if (url.origin !== base) return fallback;

    // The canonical path is re-parsed by `respond()`, so it has to survive a
    // second pass too. `/./\evil.com` is same-origin here but normalises to
    // `//evil.com`, which is protocol-relative the next time round.
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (!path.startsWith("/") || path.startsWith("//")) return fallback;
    return path;
  } catch {
    return fallback;
  }
}

export type ActionResult = ({ ok: true } & Record<string, unknown>) | { ok: false; error: string };

/**
 * A permission refusal on a route that also serves native form posts.
 *
 * guard() answers with JSON, which is right for the fetch callers and wrong for
 * the <form method="POST"> submissions these same routes accept: those are
 * full-page navigations, so the browser paints `{"ok":false,...}` as the
 * document and the operator loses the entire console with only Back to get out.
 * Every other failure on these routes redirects back with ?error= and is
 * rendered in place — this puts the authorization branch on that same path.
 */
export async function denyPost(
  request: Request,
  denied: NextResponse,
  body: PostBody,
  redirectTo: string,
): Promise<NextResponse> {
  if (body.json) return denied;
  let error = "You do not have permission to do that.";
  try {
    // clone(), because the caller's response body can only be read once and
    // the JSON branch above still has to be able to return it intact.
    const parsed = (await denied.clone().json()) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) error = parsed.error;
  } catch {
    // An unreadable body is not worth failing over; the generic message stands.
  }
  return respond(request, body, redirectTo, { ok: false, error });
}

/**
 * `request` is no longer read — the redirect is deliberately relative rather
 * than resolved against the request's own (Host-header-derived) URL. It stays
 * in the signature because every route handler passes it.
 */
export function respond(
  request: Request,
  body: PostBody,
  redirectTo: string,
  result: ActionResult,
): NextResponse {
  if (body.json) {
    return result.ok
      ? NextResponse.json(result)
      : NextResponse.json({ error: result.error }, { status: 400 });
  }

  // The page reads ?error= and renders it, so a failed submit isn't a silent no-op.
  //
  // Resolved against a fixed placeholder rather than request.url, and emitted as
  // a relative Location: request.url takes its host from the Host header, so a
  // spoofed one would otherwise decide where the browser lands. A relative
  // Location is valid per RFC 7231 and every browser resolves it against the
  // request origin.
  const target = new URL(safePath(redirectTo, "/inbox/whatsapp"), "http://form-post.invalid");
  if (!result.ok) target.searchParams.set("error", result.error);

  return new NextResponse(null, {
    status: 303,
    headers: { Location: `${target.pathname}${target.search}${target.hash}` },
  });
}
