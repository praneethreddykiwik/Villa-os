import { NextResponse } from "next/server";
import { read, resolveBrandId } from "@/lib/db";
import { retrieveAll } from "@/lib/engine/sync";
import { guard } from "@/lib/auth/guard";

/** Pull everything inbound from every connected channel. Safe to re-run. */
export async function POST(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  const url = new URL(req.url);
  let brandId = url.searchParams.get("brand") ?? undefined;
  try {
    const body = (await req.json()) as { brandId?: string };
    brandId = body.brandId ?? brandId;
  } catch {
    /* body is optional */
  }
  const result = await retrieveAll(resolveBrandId(read(), brandId));
  return NextResponse.json(result);
}

export const GET = POST;
