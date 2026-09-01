import { NextResponse } from "next/server";
import { AuthError } from "./auth";

/** Uniform error shape. Never leaks internals to the client. */
export function handleError(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
  }
  const message = e instanceof Error ? e.message : "Unexpected error";
  // Server-side detail stays in the server log; the client gets the message only.
  console.error("[ops]", message);
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, ...data }, { status });
}
