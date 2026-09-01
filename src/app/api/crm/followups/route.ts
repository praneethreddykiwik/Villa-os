import { NextResponse } from "next/server";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { diff, evaluate } from "@/lib/crm/rules";
import { guard } from "@/lib/auth/guard";

/**
 * Materialise the follow-ups the rules engine says should exist.
 *
 * Idempotent by construction: every generated task has a deterministic id, so
 * running this on a cron, on page load and from the button all converge on the
 * same set. Nothing a person completed comes back.
 */
export async function POST(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  let brandId: string | undefined = new URL(req.url).searchParams.get("brand") ?? undefined;
  try {
    const body = (await req.json()) as { brandId?: string };
    brandId = body.brandId ?? brandId;
  } catch {
    /* body optional */
  }

  const db = read();
  const id = resolveBrandId(db, brandId);
  const drafts = evaluate({
    leads: db.leads.filter((l) => l.brandId === id),
    contacts: db.crmContacts.filter((c) => c.brandId === id),
    existing: db.crmTasks.filter((t) => t.brandId === id),
    now: Date.now(),
  });
  const created = diff(drafts, db.crmTasks.filter((t) => t.brandId === id), id);

  if (created.length) mutate((d) => void d.crmTasks.push(...created));

  return NextResponse.json({
    ok: true,
    evaluated: drafts.length,
    created: created.length,
    tasks: created.map((t) => ({ id: t.id, title: t.title, rule: t.rule, dueAt: t.dueAt })),
  });
}

export const GET = POST;
