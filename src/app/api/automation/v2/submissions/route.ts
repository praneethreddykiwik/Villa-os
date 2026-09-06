import { apiError, apiOk } from "@/lib/auth/http";
import { requirePermission } from "@/lib/auth/session";
import { read } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requirePermission("marketing.read");
    const all = read().n8nSubmissions ?? [];
    const submissions = all.slice(-25).reverse();

    return apiOk({ submissions });
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE() {
  try {
    await requirePermission("marketing.publish");
    const { mutate } = await import("@/lib/db");
    mutate((db) => {
      db.n8nSubmissions = [];
    });
    return apiOk({ cleared: true });
  } catch (e) {
    return apiError(e);
  }
}
