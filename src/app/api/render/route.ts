import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { serverClient } from "@/lib/supabase/client";
import { isStorageSrc, resolveSrc } from "@/lib/media/store";
import { mutate, read } from "@/lib/db";
import { renderForFormats } from "@/lib/media/render";
import type { MediaEdit, PostFormat } from "@/lib/types";
import { guard } from "@/lib/auth/guard";

/**
 * Render a Studio edit into one file per required aspect ratio.
 * Returns the exact ffmpeg command for each render so the pipeline is auditable
 * (and debuggable) rather than a black box.
 */
export async function POST(req: Request) {
  // Writes render output into the media library — same store as media/upload,
  // which requires marketing.publish. Read permission is not enough to write.
  const denied = await guard("marketing.publish");
  if (denied) return denied;

  const { assetId, edit, formats } = (await req.json()) as {
    assetId: string;
    edit: MediaEdit;
    formats: PostFormat[];
  };
  const db = read();
  const asset = db.media.find((m) => m.id === assetId);
  if (!asset) return NextResponse.json({ ok: false, error: "asset not found" }, { status: 404 });

  /**
   * Uploaded media lives in the private bucket, so `src` is an object key rather
   * than a readable path. ffmpeg needs something it can open, and a signed URL
   * is minted per render because the stored one would have expired.
   */
  let source = asset;
  if (isStorageSrc(asset.src)) {
    const sb = serverClient(await cookies());
    const url = await resolveSrc(sb, asset.src);
    if (!url) {
      return NextResponse.json(
        { ok: false, error: "The source file could not be read from storage. It may have been deleted." },
        { status: 409 },
      );
    }
    source = { ...asset, src: url };
  }

  const results = await renderForFormats(source, edit, formats.length ? formats : ["reel"]);
  mutate((d) => {
    const a = d.media.find((m) => m.id === assetId);
    if (!a) return;
    a.edit = edit;
    // Only a real render goes on the record. A simulated one produced no file,
    // and storing its path made the composer offer a publish target that would
    // fail at the platform.
    for (const r of results) if (r.ok && !r.simulated) a.renders[r.aspect] = r.outputPath;
  });
  return NextResponse.json({ ok: true, results });
}
