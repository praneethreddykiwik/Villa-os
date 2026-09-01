import { NextResponse } from "next/server";
import { AuthError, requirePermission, type Permission } from "./session";

/**
 * Route guard that returns a response instead of throwing.
 *
 * Handlers written without try/catch would otherwise turn an authorisation
 * failure into a 500, which both hides the real reason from the user and looks
 * like a bug to whoever is on call. Usage:
 *
 *   const denied = await guard("customers.read");
 *   if (denied) return denied;
 */
export async function guard(...permissions: Permission[]): Promise<NextResponse | null> {
  try {
    await requirePermission(...permissions);
    return null;
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    return NextResponse.json({ ok: false, error: "Authorization failed." }, { status: 403 });
  }
}
