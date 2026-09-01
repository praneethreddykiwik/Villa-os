import { NextResponse } from "next/server";
import { AuthError } from "./session";

/**
 * Uniform API error handling.
 *
 * Clients get a short message and a correlation id. Stack traces, SQL and
 * library versions stay on the server — leaking them hands an attacker the
 * schema and the dependency list for free.
 */
export function apiError(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
  }
  const id = crypto.randomUUID();
  console.error(`[api:${id}]`, e instanceof Error ? e.stack : e);
  return NextResponse.json(
    { ok: false, error: "Something went wrong. Quote this reference if you report it.", ref: id },
    { status: 500 },
  );
}

export function apiOk<T extends Record<string, unknown>>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, ...data }, { status });
}
