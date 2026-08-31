import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MediaAsset, MediaEdit, PostFormat } from "../types";

/**
 * VIDEO RENDER PIPELINE
 *
 * The Studio UI produces a declarative `MediaEdit` recipe. This module turns that
 * recipe into an ffmpeg filtergraph and renders one file per required aspect
 * ratio, because a single master cannot be posted to a 9:16 reel and a 1:1 feed
 * without one of them being letterboxed or badly cropped.
 *
 * Rendering is per-aspect and cached by a hash of (assetId + recipe + aspect), so
 * re-publishing the same edit to a second network is free.
 */

export const ASPECTS: Record<string, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
  "16:9": { w: 1920, h: 1080 },
};

/** Which aspect each network/format actually wants. */
export function aspectForFormat(format: PostFormat): keyof typeof ASPECTS {
  if (format === "reel" || format === "story" || format === "short") return "9:16";
  if (format === "feed") return "4:5";
  return "16:9";
}

export function hasFfmpeg(): boolean {
  try {
    const { status } = require("node:child_process").spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return status === 0;
  } catch {
    return false;
  }
}

/**
 * Build the ffmpeg filter chain for one aspect.
 *
 * Order matters: trim → speed → colour → scale/crop around the focal point →
 * overlays → captions. Cropping last would throw away the pixels the overlays
 * were positioned against.
 */
export function buildFilterGraph(edit: MediaEdit, aspect: keyof typeof ASPECTS, source: { width: number; height: number }): string {
  const { w, h } = ASPECTS[aspect];
  const filters: string[] = [];

  if (edit.speed !== 1) filters.push(`setpts=${(1 / edit.speed).toFixed(4)}*PTS`);
  if (edit.brightness !== 0 || edit.saturation !== 1) {
    filters.push(`eq=brightness=${edit.brightness.toFixed(2)}:saturation=${edit.saturation.toFixed(2)}`);
  }

  // Scale so the frame covers the target box, then crop to it around the focal point.
  const scaleFactor = Math.max(w / source.width, h / source.height);
  const scaledW = Math.ceil(source.width * scaleFactor);
  const scaledH = Math.ceil(source.height * scaleFactor);
  const cropX = Math.round(Math.min(Math.max(0, edit.focalX * scaledW - w / 2), scaledW - w));
  const cropY = Math.round(Math.min(Math.max(0, edit.focalY * scaledH - h / 2), scaledH - h));
  filters.push(`scale=${scaledW}:${scaledH}`);
  filters.push(`crop=${w}:${h}:${cropX}:${cropY}`);

  for (const o of edit.overlays) {
    if (o.type !== "text" && o.type !== "cta") continue;
    const text = (o.text ?? "").replace(/[':\\]/g, "\\$&");
    filters.push(
      `drawtext=text='${text}':fontsize=${Math.round(o.size * (w / 1080))}:fontcolor=${o.color}:` +
        `x=(w*${o.x.toFixed(3)})-text_w/2:y=(h*${o.y.toFixed(3)})-text_h/2:` +
        `box=1:boxcolor=black@0.35:boxborderw=18:` +
        `enable='between(t,${o.startSec},${o.endSec})'`,
    );
  }

  if (edit.captionsEnabled) {
    // Burned-in subtitles from the sidecar .srt the transcription step writes.
    const style =
      edit.captionStyle === "bold-center"
        ? "FontSize=22,Bold=1,Alignment=10,Outline=2,Shadow=0"
        : edit.captionStyle === "karaoke"
          ? "FontSize=20,Bold=1,Alignment=2,Outline=3,PrimaryColour=&H00FFFF&"
          : "FontSize=16,Alignment=2,Outline=1";
    filters.push(`subtitles=CAPTION_SRT:force_style='${style}'`);
  }

  return filters.join(",");
}

export function buildFfmpegArgs(
  input: string,
  output: string,
  edit: MediaEdit,
  aspect: keyof typeof ASPECTS,
  source: { width: number; height: number },
  srtPath?: string,
): string[] {
  let graph = buildFilterGraph(edit, aspect, source);
  graph = srtPath ? graph.replace("CAPTION_SRT", srtPath.replace(/:/g, "\\:")) : graph.replace(/,?subtitles=[^,]*/, "");

  return [
    "-y",
    "-ss", String(edit.trimStartSec),
    "-to", String(edit.trimEndSec),
    "-i", input,
    ...(graph ? ["-vf", graph] : []),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    // Faststart puts the moov atom first so platforms can begin transcoding
    // before the whole file is read — measurably faster IG container processing.
    "-movflags", "+faststart",
    "-c:a", "aac",
    "-b:a", "128k",
    "-af", `volume=${edit.musicVolume.toFixed(2)}`,
    "-r", "30",
    output,
  ];
}

export interface RenderResult {
  aspect: string;
  outputPath: string;
  ok: boolean;
  simulated: boolean;
  command: string;
  error?: string;
}

/**
 * Render one aspect. When ffmpeg is not installed we return the exact command we
 * *would* have run and mark the result simulated, so the UI stays fully usable
 * on a machine without ffmpeg instead of erroring.
 */
export async function renderAspect(
  asset: MediaAsset,
  edit: MediaEdit,
  aspect: keyof typeof ASPECTS,
  outDir = path.join(process.cwd(), "public", "renders"),
): Promise<RenderResult> {
  const key = hashRecipe(asset.id, edit, aspect);
  const outputPath = path.join(outDir, `${key}.mp4`);
  const publicPath = `/renders/${key}.mp4`;
  const args = buildFfmpegArgs(asset.src, outputPath, edit, aspect, { width: asset.width, height: asset.height });
  const command = `ffmpeg ${args.join(" ")}`;

  if (fs.existsSync(outputPath)) {
    return { aspect, outputPath: publicPath, ok: true, simulated: false, command };
  }
  if (!hasFfmpeg() || !fs.existsSync(asset.src)) {
    return { aspect, outputPath: publicPath, ok: true, simulated: true, command };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const ok = await new Promise<boolean>((resolve) => {
    const proc = spawn("ffmpeg", args, { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
  return { aspect, outputPath: publicPath, ok, simulated: false, command, error: ok ? undefined : "ffmpeg failed" };
}

/** Render every aspect the chosen formats need, deduplicated. */
export async function renderForFormats(asset: MediaAsset, edit: MediaEdit, formats: PostFormat[]): Promise<RenderResult[]> {
  const aspects = [...new Set(formats.map(aspectForFormat))];
  return Promise.all(aspects.map((a) => renderAspect(asset, edit, a)));
}

function hashRecipe(assetId: string, edit: MediaEdit, aspect: string): string {
  const s = `${assetId}|${aspect}|${JSON.stringify(edit)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${assetId}-${aspect.replace(":", "x")}-${h.toString(36)}`;
}

export const DEFAULT_EDIT: MediaEdit = {
  trimStartSec: 0,
  trimEndSec: 15,
  aspect: "9:16",
  focalX: 0.5,
  focalY: 0.45,
  captionsEnabled: true,
  captionStyle: "bold-center",
  overlays: [],
  musicVolume: 0.6,
  speed: 1,
  brightness: 0.02,
  saturation: 1.08,
};
