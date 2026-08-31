"use client";

import { useMemo, useState } from "react";
import { Film, Loader2, Plus, Scissors, Sparkles, Terminal, Trash2, Type } from "lucide-react";
import clsx from "clsx";
import type { Brand, MediaAsset, MediaEdit, MediaOverlay, PostFormat } from "@/lib/types";
import { Badge, Card, SectionTitle } from "./ui";

/**
 * VIDEO STUDIO
 *
 * A declarative editor: every control writes into a `MediaEdit` recipe, and the
 * server turns that recipe into an ffmpeg filtergraph. Nothing is destructive —
 * the master file is never touched, and each aspect ratio is a separate cached
 * render, because a 9:16 reel and a 4:5 feed post genuinely need different crops.
 */

const ASPECT_BOX: Record<string, { w: number; h: number }> = {
  "9:16": { w: 9, h: 16 },
  "4:5": { w: 4, h: 5 },
  "1:1": { w: 1, h: 1 },
  "16:9": { w: 16, h: 9 },
};

const TARGETS: Array<{ format: PostFormat; label: string; aspect: string }> = [
  { format: "reel", label: "Reel / TikTok / Short", aspect: "9:16" },
  { format: "story", label: "Story", aspect: "9:16" },
  { format: "feed", label: "Feed post", aspect: "4:5" },
  { format: "carousel", label: "Carousel", aspect: "1:1" },
];

export function Studio({ brand, media, defaultEdit }: { brand: Brand; media: MediaAsset[]; defaultEdit: MediaEdit }) {
  const [assetId, setAssetId] = useState(media[0]?.id ?? "");
  const asset = media.find((m) => m.id === assetId);
  const [edit, setEdit] = useState<MediaEdit>(asset?.edit ?? defaultEdit);
  const [formats, setFormats] = useState<PostFormat[]>(["reel"]);
  const [busy, setBusy] = useState(false);
  const [renders, setRenders] = useState<Array<{ aspect: string; outputPath: string; simulated: boolean; command: string; ok: boolean }>>([]);
  const [hooks, setHooks] = useState<string[]>([]);
  const [hooksBusy, setHooksBusy] = useState(false);

  const duration = asset?.durationSec ?? 30;
  const set = <K extends keyof MediaEdit>(k: K, v: MediaEdit[K]) => setEdit((e) => ({ ...e, [k]: v }));

  const aspects = useMemo(() => [...new Set(formats.map((f) => TARGETS.find((t) => t.format === f)?.aspect ?? "9:16"))], [formats]);

  async function render() {
    if (!asset) return;
    setBusy(true);
    try {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId: asset.id, edit, formats }),
      });
      const json = await res.json();
      setRenders(json.results ?? []);
    } finally {
      setBusy(false);
    }
  }

  async function suggestHooks() {
    setHooksBusy(true);
    try {
      const res = await fetch("/api/ai/copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brandId: brand.id,
          topic: asset?.tags.join(" ") ?? "this video",
          format: "reel",
          channels: ["instagram"],
          hooksFor: edit.overlays[0]?.text ?? "Welcome to our place",
        }),
      });
      const json = await res.json();
      setHooks(json.hooks ?? []);
    } finally {
      setHooksBusy(false);
    }
  }

  function addOverlay(text: string) {
    const o: MediaOverlay = {
      id: `ov_${Math.random().toString(36).slice(2, 8)}`,
      type: "text",
      text,
      x: 0.5,
      y: 0.18,
      startSec: 0,
      endSec: Math.min(3, edit.trimEndSec),
      size: 54,
      color: "white",
    };
    set("overlays", [...edit.overlays, o]);
  }

  const box = ASPECT_BOX[aspects[0] ?? "9:16"];

  return (
    <div className="grid gap-5 xl:grid-cols-[300px_1fr_320px]">
      {/* ---- Asset picker --------------------------------------------------- */}
      <Card className="h-fit">
        <SectionTitle title="Clips" hint={`${media.length} in the library`} />
        <div className="grid grid-cols-3 gap-2">
          {media.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                setAssetId(m.id);
                setEdit(m.edit ?? defaultEdit);
                setRenders([]);
              }}
              className={clsx("relative aspect-[9/16] overflow-hidden rounded-lg border-2", m.id === assetId ? "border-brand-500" : "border-ink-700 hover:border-ink-600")}
              style={{ background: `linear-gradient(150deg, ${brand.color}55, #10141f)` }}
            >
              <span className="absolute left-1 top-1 rounded bg-black/50 px-1 text-[8px] text-white">{m.durationSec}s</span>
              <span className="absolute inset-x-1 bottom-1 truncate text-left text-[8.5px] text-mist-200">{m.tags[0]}</span>
            </button>
          ))}
        </div>
      </Card>

      {/* ---- Preview + timeline --------------------------------------------- */}
      <div className="space-y-5">
        <Card>
          <SectionTitle
            title="Preview"
            hint={`Cropping to ${aspects.join(", ")} around the focal point`}
            action={<Badge tone="brand">{edit.trimEndSec - edit.trimStartSec}s</Badge>}
          />
          <div className="flex justify-center">
            <div
              className="relative overflow-hidden rounded-xl border border-ink-700"
              style={{
                width: 260,
                height: (260 * box.h) / box.w,
                background: `linear-gradient(${160 + edit.focalX * 40}deg, ${brand.color}66, #0b0e16)`,
                filter: `brightness(${1 + edit.brightness}) saturate(${edit.saturation})`,
              }}
            >
              {/* Focal-point marker: this is what the crop centres on. */}
              <span
                className="absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/70"
                style={{ left: `${edit.focalX * 100}%`, top: `${edit.focalY * 100}%` }}
              />
              {edit.overlays.map((o) => (
                <span
                  key={o.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-black/40 px-2 py-0.5 text-center font-bold leading-tight"
                  style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, color: o.color, fontSize: o.size / 4.2 }}
                >
                  {o.text}
                </span>
              ))}
              {edit.captionsEnabled && (
                <span
                  className={clsx(
                    "absolute inset-x-3 rounded bg-black/45 px-1 py-0.5 text-center text-[10px] font-semibold text-white",
                    edit.captionStyle === "bold-center" ? "top-1/2" : "bottom-6",
                  )}
                >
                  burned-in captions
                </span>
              )}
            </div>
          </div>

          {/* Trim timeline */}
          <div className="mt-5">
            <div className="mb-1.5 flex items-center gap-2 text-[11px] text-mist-400">
              <Scissors size={12} /> Trim
              <span className="tnum ml-auto text-mist-200">
                {edit.trimStartSec.toFixed(1)}s → {edit.trimEndSec.toFixed(1)}s
              </span>
            </div>
            <div className="relative h-9 overflow-hidden rounded-lg bg-ink-800">
              <div
                className="absolute inset-y-0 bg-brand-500/25 border-x-2 border-brand-500"
                style={{
                  left: `${(edit.trimStartSec / duration) * 100}%`,
                  right: `${100 - (edit.trimEndSec / duration) * 100}%`,
                }}
              />
              {Array.from({ length: 24 }).map((_, i) => (
                <span key={i} className="absolute top-0 h-full w-px bg-ink-700" style={{ left: `${(i / 24) * 100}%` }} />
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label className="text-[11px] text-mist-400">
                Start
                <input type="range" min={0} max={duration} step={0.5} value={edit.trimStartSec}
                  onChange={(e) => set("trimStartSec", Math.min(Number(e.target.value), edit.trimEndSec - 1))}
                  className="mt-1 w-full accent-[var(--color-brand-500)]" />
              </label>
              <label className="text-[11px] text-mist-400">
                End
                <input type="range" min={1} max={duration} step={0.5} value={edit.trimEndSec}
                  onChange={(e) => set("trimEndSec", Math.max(Number(e.target.value), edit.trimStartSec + 1))}
                  className="mt-1 w-full accent-[var(--color-brand-500)]" />
              </label>
            </div>
          </div>
        </Card>

        <Card>
          <SectionTitle title="Render targets" hint="One file per aspect ratio, cached by edit recipe" />
          <div className="flex flex-wrap gap-2">
            {TARGETS.map((t) => {
              const on = formats.includes(t.format);
              return (
                <button
                  key={t.format}
                  onClick={() => setFormats((f) => (on ? f.filter((x) => x !== t.format) : [...f, t.format]))}
                  className={clsx("rounded-lg border px-2.5 py-1.5 text-[11.5px]", on ? "border-brand-500 bg-brand-500/12 text-mist-100" : "border-ink-700 text-mist-300 hover:border-ink-600")}
                >
                  {t.label} <span className="text-mist-400">· {t.aspect}</span>
                </button>
              );
            })}
          </div>

          <button
            onClick={render}
            disabled={busy || !formats.length}
            className="mt-3 flex items-center gap-2 rounded-lg bg-brand-500 px-3.5 py-2 text-[12.5px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />}
            Render {aspects.length} version{aspects.length === 1 ? "" : "s"}
          </button>

          {renders.length > 0 && (
            <div className="mt-3 space-y-2">
              {renders.map((r) => (
                <div key={r.aspect} className="rounded-lg border border-ink-700 p-2.5">
                  <div className="flex items-center gap-2">
                    <Badge tone={r.ok ? "good" : "bad"}>{r.aspect}</Badge>
                    <span className="truncate text-[11.5px] text-mist-200">{r.outputPath}</span>
                    {r.simulated && <Badge tone="warn">ffmpeg not installed — command shown</Badge>}
                  </div>
                  <details className="mt-1.5">
                    <summary className="flex cursor-pointer items-center gap-1 text-[10.5px] text-mist-400 hover:text-mist-200">
                      <Terminal size={10} /> show ffmpeg command
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-ink-950 p-2 text-[10px] leading-relaxed text-mist-300">{r.command}</pre>
                  </details>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ---- Controls -------------------------------------------------------- */}
      <div className="space-y-5">
        <Card>
          <SectionTitle title="Framing" hint="Where the crop centres when changing aspect" />
          <div className="space-y-3 text-[11px] text-mist-400">
            <label className="block">
              Focal X <span className="tnum float-right text-mist-200">{edit.focalX.toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.01} value={edit.focalX} onChange={(e) => set("focalX", Number(e.target.value))} className="mt-1 w-full accent-[var(--color-brand-500)]" />
            </label>
            <label className="block">
              Focal Y <span className="tnum float-right text-mist-200">{edit.focalY.toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.01} value={edit.focalY} onChange={(e) => set("focalY", Number(e.target.value))} className="mt-1 w-full accent-[var(--color-brand-500)]" />
            </label>
            <label className="block">
              Speed <span className="tnum float-right text-mist-200">{edit.speed.toFixed(2)}x</span>
              <input type="range" min={0.5} max={2} step={0.05} value={edit.speed} onChange={(e) => set("speed", Number(e.target.value))} className="mt-1 w-full accent-[var(--color-brand-500)]" />
            </label>
            <label className="block">
              Brightness <span className="tnum float-right text-mist-200">{edit.brightness.toFixed(2)}</span>
              <input type="range" min={-0.3} max={0.3} step={0.01} value={edit.brightness} onChange={(e) => set("brightness", Number(e.target.value))} className="mt-1 w-full accent-[var(--color-brand-500)]" />
            </label>
            <label className="block">
              Saturation <span className="tnum float-right text-mist-200">{edit.saturation.toFixed(2)}</span>
              <input type="range" min={0} max={2} step={0.02} value={edit.saturation} onChange={(e) => set("saturation", Number(e.target.value))} className="mt-1 w-full accent-[var(--color-brand-500)]" />
            </label>
            <label className="block">
              Music volume <span className="tnum float-right text-mist-200">{edit.musicVolume.toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.05} value={edit.musicVolume} onChange={(e) => set("musicVolume", Number(e.target.value))} className="mt-1 w-full accent-[var(--color-brand-500)]" />
            </label>
          </div>
        </Card>

        <Card>
          <SectionTitle title="Captions" hint="Burned in — most feeds autoplay muted" />
          <label className="flex items-center gap-2 text-[12px] text-mist-200">
            <input type="checkbox" checked={edit.captionsEnabled} onChange={(e) => set("captionsEnabled", e.target.checked)} className="accent-[var(--color-brand-500)]" />
            Burn captions into the video
          </label>
          {edit.captionsEnabled && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(["bold-center", "karaoke", "subtle-bottom"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => set("captionStyle", s)}
                  className={clsx("rounded-lg border px-2 py-1 text-[11px]", edit.captionStyle === s ? "border-brand-500 bg-brand-500/12" : "border-ink-700 text-mist-300")}
                >
                  {s.replace("-", " ")}
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle
            title="Hook overlay"
            hint="The first 3 seconds decide the reach"
            action={
              <button onClick={suggestHooks} disabled={hooksBusy} className="flex items-center gap-1 rounded-lg border border-ink-700 px-2 py-1 text-[11px] text-mist-200 hover:border-ink-600">
                {hooksBusy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />} AI hooks
              </button>
            }
          />
          {hooks.length > 0 && (
            <div className="mb-3 space-y-1">
              {hooks.map((h) => (
                <button key={h} onClick={() => addOverlay(h)} className="flex w-full items-center gap-1.5 rounded-lg border border-ink-700 px-2 py-1.5 text-left text-[11.5px] text-mist-200 hover:border-brand-500">
                  <Plus size={11} className="shrink-0 text-brand-400" /> {h}
                </button>
              ))}
            </div>
          )}
          <div className="space-y-2">
            {edit.overlays.map((o) => (
              <div key={o.id} className="rounded-lg border border-ink-700 p-2">
                <div className="flex items-center gap-1.5">
                  <Type size={11} className="text-mist-400" />
                  <input
                    value={o.text ?? ""}
                    onChange={(e) => set("overlays", edit.overlays.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)))}
                    className="min-w-0 flex-1 bg-transparent text-[11.5px] text-mist-100 outline-none"
                  />
                  <button onClick={() => set("overlays", edit.overlays.filter((x) => x.id !== o.id))} className="text-mist-400 hover:text-bad-400">
                    <Trash2 size={11} />
                  </button>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-2 text-[10px] text-mist-400">
                  <label>x<input type="range" min={0} max={1} step={0.01} value={o.x} onChange={(e) => set("overlays", edit.overlays.map((x) => (x.id === o.id ? { ...x, x: Number(e.target.value) } : x)))} className="w-full accent-[var(--color-brand-500)]" /></label>
                  <label>y<input type="range" min={0} max={1} step={0.01} value={o.y} onChange={(e) => set("overlays", edit.overlays.map((x) => (x.id === o.id ? { ...x, y: Number(e.target.value) } : x)))} className="w-full accent-[var(--color-brand-500)]" /></label>
                </div>
              </div>
            ))}
            <button onClick={() => addOverlay("Your hook here")} className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-ink-600 py-1.5 text-[11.5px] text-mist-400 hover:border-ink-500 hover:text-mist-200">
              <Plus size={12} /> Add text overlay
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
