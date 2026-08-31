import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { renderForFormats } from "@/lib/media/render";
import type { MediaEdit, PostFormat } from "@/lib/types";

/**
 * Render a Studio edit into one file per required aspect ratio.
 * Returns the exact ffmpeg command for each render so the pipeline is auditable
 * (and debuggable) rather than a black box.
 */
export async function POST(req: Request) {
  const { assetId, edit, formats } = (await req.json()) as {
    assetId: string;
    edit: MediaEdit;
    formats: PostFormat[];
  };
  const db = read();
  const asset = db.media.find((m) => m.id === assetId);
  if (!asset) return NextResponse.json({ ok: false, error: "asset not found" }, { status: 404 });

  const results = await renderForFormats(asset, edit, formats.length ? formats : ["reel"]);
  mutate((d) => {
    const a = d.media.find((m) => m.id === assetId);
    if (!a) return;
    a.edit = edit;
    for (const r of results) a.renders[r.aspect] = r.outputPath;
  });
  return NextResponse.json({ ok: true, results });
}
