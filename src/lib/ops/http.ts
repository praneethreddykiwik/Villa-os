import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { AuthError } from "./auth";

/** Uniform error shape. Never leaks internals to the client. */
export function handleError(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
  }
  // The internal message stays on the server. Returning e.message handed the
  // client PostgREST errors, file paths and library internals, and reported
  // every server fault as a 400 so genuine outages looked like bad input.
  const ref = crypto.randomUUID();
  console.error(`[ops:${ref}]`, e instanceof Error ? e.stack : e);
  return NextResponse.json(
    { ok: false, error: "Something went wrong. Quote this reference if you report it.", ref },
    { status: 500 },
  );
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, ...data }, { status });
}

/**
 * A refusal. Use this for every non-2xx reply.
 *
 * `ok({ error: "Missing permission" }, 403)` reads like a refusal but emits
 * `{ ok: true, error: ... }`, and every client in this app decides success by
 * reading `json.ok`. So a permission denial, a "not your case" and an expired
 * download token all arrived in the browser flagged as successes: the checklist
 * editor and the case controls showed no error, kept their optimistic state and
 * told the officer the write had gone through. The status code carried the
 * truth and nothing read it. `fail()` makes the body and the status agree.
 */
export function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}
