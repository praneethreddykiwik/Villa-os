"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Clock,
  Film,
  FolderSync,
  Instagram,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  Video,
  Youtube,
  Facebook,
  Bot,
  Layers,
} from "lucide-react";
import clsx from "clsx";
import { Badge, Card, SectionTitle } from "../ui";

export interface V2FormProps {
  brandId: string;
  brandName: string;
}

export interface V2Submission {
  id: string;
  title: string;
  status: "forwarded" | "queued" | "failed" | string;
  at?: string;
  createdAt?: string;
  platforms?: string[];
  channels?: string[];
  error?: string;
  elapsedMs?: number;
}

const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB
const ACCEPTED_TYPES = [".mp4", ".mov", ".webm", "video/mp4", "video/quicktime", "video/webm"];

function XIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const PIPELINE_STEPS = [
  {
    number: "01",
    emoji: "🎬",
    icon: Film,
    title: "Overlay Video",
    subtitle: "Branding & formatting",
    description: "Automatic visual watermark injection, 9:16 aspect ratio framing, color grading, and dynamic brand outro.",
  },
  {
    number: "02",
    emoji: "📁",
    icon: FolderSync,
    title: "Drive Archival",
    subtitle: "Google Drive sync",
    description: "Master render saved to company Drive cloud vault, organized into date-stamped property folders.",
  },
  {
    number: "03",
    emoji: "🤖",
    icon: Bot,
    title: "AI Captions & Tags",
    subtitle: "OpenRouter AI generation",
    description: "LLM analyzes scene context to craft viral hook captions, platform-specific emojis, and optimal search tags.",
  },
  {
    number: "04",
    emoji: "🚀",
    icon: Sparkles,
    title: "Direct Distribution",
    subtitle: "Instagram, YouTube, Facebook, X",
    description: "Concurrent autonomous dispatch via official APIs to all 4 connected brand channels simultaneously.",
  },
];

const TARGET_CHANNELS = [
  { name: "Instagram", icon: Instagram, color: "from-pink-500 to-purple-500", handle: "Reels / Feed" },
  { name: "YouTube", icon: Youtube, color: "from-red-600 to-red-500", handle: "Shorts / Video" },
  { name: "Facebook", icon: Facebook, color: "from-blue-600 to-blue-500", handle: "Watch / Page" },
  { name: "X", customIcon: XIcon, color: "from-zinc-400 to-zinc-200", handle: "Native Video Post" },
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

function formatTimestamp(isoString?: string): string {
  if (!isoString) return "Just now";
  try {
    const d = new Date(isoString);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

export function V2Form({ brandId, brandName }: V2FormProps) {
  // Video file state
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [isDragging, setIsDragging] = useState(false);

  // Form details state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  // Pipeline step active selection
  const [selectedStep, setSelectedStep] = useState<number>(0);

  // Submit and Progress state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgressText, setUploadProgressText] = useState("");
  const [submissionSuccess, setSubmissionSuccess] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // History state
  const [submissions, setSubmissions] = useState<V2Submission[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Clean up object URL when video changes or unmounts
  useEffect(() => {
    return () => {
      if (videoPreviewUrl) {
        URL.revokeObjectURL(videoPreviewUrl);
      }
    };
  }, [videoPreviewUrl]);

  // Handle Video Selection
  const handleSelectVideo = useCallback((file: File) => {
    setFormError(null);
    setSubmissionSuccess(null);

    // Validate size
    if (file.size > MAX_VIDEO_BYTES) {
      setFormError(`Video file exceeds the 500 MB limit (${formatBytes(file.size)}). Please compress or choose a smaller clip.`);
      return;
    }

    // Validate format
    const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.name);
    if (!isVideo) {
      setFormError("Unsupported file type. Please upload an .mp4, .mov, or .webm video file.");
      return;
    }

    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl);
    }

    const objectUrl = URL.createObjectURL(file);
    setVideoFile(file);
    setVideoPreviewUrl(objectUrl);
    setVideoDuration(0);

    // If title is currently empty, pre-fill with file base name
    if (!title.trim()) {
      const cleanName = file.name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");
      setTitle(cleanName.slice(0, 100));
    }
  }, [videoPreviewUrl, title]);

  // Remove Video
  const handleRemoveVideo = useCallback(() => {
    if (videoPreviewUrl) {
      URL.revokeObjectURL(videoPreviewUrl);
    }
    setVideoFile(null);
    setVideoPreviewUrl(null);
    setVideoDuration(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [videoPreviewUrl]);

  // Drag & Drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleSelectVideo(e.dataTransfer.files[0]);
    }
  }, [handleSelectVideo]);

  // Multi-select channels state
  const [selectedChannels, setSelectedChannels] = useState<string[]>([
    "YouTube",
    "Instagram",
    "Facebook",
    "X",
  ]);

  const toggleChannel = (channelName: string) => {
    setSelectedChannels((prev) =>
      prev.includes(channelName)
        ? prev.filter((c) => c !== channelName)
        : [...prev, channelName]
    );
  };

  const selectAllChannels = () => {
    setSelectedChannels(["YouTube", "Instagram", "Facebook", "X"]);
  };

  const clearAllChannels = () => {
    setSelectedChannels([]);
  };

  // Fetch recent history
  const fetchSubmissions = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/automation/v2/submissions?brandId=${encodeURIComponent(brandId)}`);
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.submissions ?? [];
        setSubmissions(list);
      }
    } catch {
      // Graceful fallback: Keep existing submissions list
    } finally {
      setLoadingHistory(false);
    }
  }, [brandId]);

  // Initial fetch and 10-second real-time live polling
  useEffect(() => {
    fetchSubmissions();
    const interval = setInterval(fetchSubmissions, 10000);
    return () => clearInterval(interval);
  }, [fetchSubmissions]);

  // Clear submission history
  const handleClearHistory = async () => {
    if (!confirm("Clear submission history?")) return;
    try {
      const res = await fetch("/api/automation/v2/submissions", { method: "DELETE" });
      if (res.ok) {
        setSubmissions([]);
      }
    } catch {}
  };

  // Form Submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmissionSuccess(null);

    if (!videoFile) {
      setFormError("Please select or drop a video file to publish.");
      return;
    }

    if (!title.trim()) {
      setFormError("Please provide a title for the video.");
      return;
    }

    if (selectedChannels.length === 0) {
      setFormError("Please select at least one platform to publish to (e.g. YouTube, Instagram).");
      return;
    }

    setIsSubmitting(true);
    setUploadProgressText("Uploading video & triggering pipeline...");

    try {
      const formData = new FormData();
      formData.append("video", videoFile);
      formData.append("title", title.trim());
      formData.append("description", description.trim());
      formData.append("brandId", brandId);

      const normalizedPlatforms = selectedChannels.map((c) => (c === "X" ? "X (Twitter)" : c));
      formData.append("platforms", normalizedPlatforms.join(","));
      formData.append("Which Platforms to Post To", normalizedPlatforms.join(","));

      // Progress animation update
      const progressTimer = setTimeout(() => {
        setUploadProgressText("Generating AI metadata & formatting pipeline...");
      }, 2500);

      // Submit directly to v2 post-video API route
      const res = await fetch("/api/automation/v2/post-video", {
        method: "POST",
        body: formData,
      });

      clearTimeout(progressTimer);

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(json?.error || "Pipeline trigger failed. Please check endpoint configuration.");
      }

      setSubmissionSuccess(
        `"${title.trim()}" dispatched successfully to ${selectedChannels.join(", ")} via the Version 2 autonomous pipeline!`
      );
      // Reset form
      handleRemoveVideo();
      setTitle("");
      setDescription("");

      // Refresh submissions immediately
      await fetchSubmissions();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to upload video to the pipeline.";
      setFormError(msg);
    } finally {
      setIsSubmitting(false);
      setUploadProgressText("");
    }
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* ========================================================================= */}
      {/* HERO / PIPELINE BANNER                                                    */}
      {/* ========================================================================= */}
      <Card variant="liquid" className="relative overflow-hidden border-brand-500/30 p-7">
        <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-brand-500/10 blur-3xl pointer-events-none" />
        <div className="absolute -left-20 -bottom-20 h-64 w-64 rounded-full bg-purple-500/10 blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-ink-800/80">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-brand-500/35 bg-brand-500/10 px-3 py-1 mb-3 shadow-inner">
              <Sparkles className="w-3.5 h-3.5 text-brand-400" />
              <span className="text-[11.5px] font-semibold text-brand-300">Next-Gen Autonomous Pipeline</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-mist-100">
              Publish v2 — Autonomous Multi-Channel Pipeline
            </h1>
            <p className="mt-2 text-sm text-mist-300 leading-relaxed">
              Upload your video once. The automation pipeline automatically overlays graphics, backs up to Google Drive, generates AI captions &amp; tags, and publishes across Instagram, YouTube, Facebook, and X.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2.5">
            <div className="rounded-xl border border-ink-700/80 bg-ink-900/80 px-4 py-2.5 backdrop-blur-xl">
              <span className="text-[11px] font-medium text-mist-400 uppercase tracking-wider block">Target Brand</span>
              <span className="text-sm font-semibold text-mist-100">{brandName}</span>
            </div>
          </div>
        </div>

        {/* Interactive Pipeline Steps Visualizer */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-mist-400 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-brand-400" />
              Autonomous Pipeline Flow (Click any stage to inspect)
            </span>
            <span className="text-[11px] text-mist-400 hidden sm:inline">
              Step {selectedStep + 1} of {PIPELINE_STEPS.length}: <span className="text-mist-200 font-medium">{PIPELINE_STEPS[selectedStep].title}</span>
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {PIPELINE_STEPS.map((step, idx) => {
              const isActive = selectedStep === idx;
              return (
                <button
                  key={step.number}
                  type="button"
                  onClick={() => setSelectedStep(idx)}
                  className={clsx(
                    "text-left p-4 rounded-xl border transition-all duration-200 relative group cursor-pointer",
                    isActive
                      ? "bg-brand-500/15 border-brand-500/60 shadow-lg shadow-brand-500/10"
                      : "bg-ink-900/60 border-ink-800/80 hover:border-ink-700 hover:bg-ink-850/60",
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-lg">{step.emoji}</span>
                    <span className={clsx("text-[10.5px] font-bold tracking-wider", isActive ? "text-brand-300" : "text-mist-500")}>
                      {step.number}
                    </span>
                  </div>
                  <div className="font-semibold text-[13.5px] text-mist-100 group-hover:text-white flex items-center gap-1.5">
                    {step.title}
                  </div>
                  <div className="text-[11.5px] text-mist-400 mt-0.5 truncate">{step.subtitle}</div>
                </button>
              );
            })}
          </div>

          {/* Active Step Details Pill */}
          <div className="mt-3.5 p-3 rounded-lg border border-brand-500/20 bg-brand-500/5 flex items-center gap-2.5 text-xs text-mist-200">
            <span className="text-base">{PIPELINE_STEPS[selectedStep].emoji}</span>
            <span className="font-semibold text-brand-300">{PIPELINE_STEPS[selectedStep].title}:</span>
            <span className="text-mist-300">{PIPELINE_STEPS[selectedStep].description}</span>
          </div>
        </div>
      </Card>

      {/* ========================================================================= */}
      {/* MAIN UPLOAD & DETAILS FORM                                               */}
      {/* ========================================================================= */}
      <form onSubmit={handleSubmit} className="space-y-6">
        <Card variant="panel" className="p-6 space-y-6">
          <SectionTitle
            title="Upload Video & Workflow Details"
            hint="The autonomous pipeline ingests your raw footage, overlays brand assets, creates AI copies, and fans out across all channels."
          />

          {/* Feedback alerts */}
          {formError && (
            <div className="p-4 rounded-xl border border-bad-500/30 bg-bad-500/10 flex items-start gap-3 text-bad-400">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <div className="text-xs">
                <span className="font-semibold block">Submission Error</span>
                {formError}
              </div>
            </div>
          )}

          {submissionSuccess && (
            <div className="p-4 rounded-xl border border-good-500/30 bg-good-500/10 flex items-start gap-3 text-good-400">
              <Check className="w-5 h-5 shrink-0 mt-0.5" />
              <div className="text-xs">
                <span className="font-semibold block">Pipeline Triggered</span>
                {submissionSuccess}
              </div>
            </div>
          )}

          {/* VIDEO FILE DROPZONE & PREVIEW */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-mist-300 mb-2">
              Master Video File <span className="text-bad-400">*</span>
            </label>

            {!videoPreviewUrl ? (
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={clsx(
                  "relative flex flex-col items-center justify-center p-8 rounded-2xl border-2 border-dashed transition-all cursor-pointer text-center",
                  isDragging
                    ? "border-brand-500 bg-brand-500/10 scale-[0.99]"
                    : "border-ink-700 bg-ink-900/60 hover:border-ink-600 hover:bg-ink-850/60",
                )}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_TYPES.join(",")}
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      handleSelectVideo(e.target.files[0]);
                    }
                  }}
                />

                <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-500/10 border border-brand-500/25 mb-3 text-brand-400 shadow-inner">
                  <Upload className="w-6 h-6" />
                </div>
                <div className="text-sm font-semibold text-mist-100">
                  Drag &amp; drop your video here, or <span className="text-brand-400 underline underline-offset-2">browse files</span>
                </div>
                <p className="mt-1 text-xs text-mist-400">
                  Accepts MP4, MOV, or WEBM formats (up to 500 MB)
                </p>
                <div className="mt-4 flex items-center gap-2 text-[11px] text-mist-500">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-good-400" />
                  Direct cloud ingestion enabled
                </div>
              </div>
            ) : (
              /* Inline HTML5 Video Preview Player */
              <div className="rounded-2xl border border-ink-700/80 bg-ink-900/90 overflow-hidden shadow-xl">
                <div className="relative aspect-video max-h-[420px] w-full bg-black flex items-center justify-center">
                  <video
                    ref={videoRef}
                    src={videoPreviewUrl}
                    controls
                    preload="metadata"
                    onLoadedMetadata={(e) => {
                      const target = e.currentTarget;
                      setVideoDuration(target.duration);
                    }}
                    className="h-full w-full object-contain"
                  />
                </div>

                <div className="p-4 border-t border-ink-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-ink-950/70">
                  <div className="flex items-center gap-3">
                    <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-500/15 border border-brand-500/30 text-brand-400">
                      <Video className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-mist-100 truncate max-w-sm">
                        {videoFile?.name}
                      </div>
                      <div className="text-xs text-mist-400 flex items-center gap-3 mt-0.5">
                        <span>Size: <strong className="text-mist-200">{videoFile ? formatBytes(videoFile.size) : "-"}</strong></span>
                        <span>•</span>
                        <span>Duration: <strong className="text-mist-200">{formatDuration(videoDuration)}</strong></span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-center">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs font-medium text-mist-200 hover:bg-ink-800 transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={handleRemoveVideo}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-bad-500/30 bg-bad-500/10 px-3 py-1.5 text-xs font-medium text-bad-400 hover:bg-bad-500/20 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* VIDEO TITLE */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="video-title" className="text-xs font-semibold uppercase tracking-wider text-mist-300">
                Video Title <span className="text-bad-400">*</span>
              </label>
              <span
                className={clsx(
                  "text-[11.5px] font-mono",
                  title.length > 100 ? "text-warn-400 font-semibold" : "text-mist-500",
                )}
              >
                {title.length} / 100 <span className="text-mist-600 font-normal">(max 200)</span>
              </span>
            </div>
            <input
              id="video-title"
              type="text"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Modern Minimalist Villa Tour in Dubai Hills"
              className="w-full rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-2.5 text-sm text-mist-100 placeholder:text-mist-500 outline-none focus:border-brand-500 transition-colors shadow-inner"
            />
            <p className="mt-1 text-[11px] text-mist-400">
              Used as the base title across YouTube and formatted into hooks for social reels. Keep within 100 characters for optimal visibility.
            </p>
          </div>

          {/* VIDEO DESCRIPTION / AI CONTEXT */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="video-desc" className="text-xs font-semibold uppercase tracking-wider text-mist-300">
                Video Context &amp; AI Prompt Instructions
              </label>
              <span className="text-[11.5px] text-brand-400 font-medium flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> AI Expanded
              </span>
            </div>
            <textarea
              id="video-desc"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter property highlights, pricing, location specifics, or key features. The OpenRouter AI engine will expand this context into custom captions, hashtags, and call-to-actions per channel..."
              className="w-full rounded-xl border border-ink-700 bg-ink-850 p-3.5 text-sm text-mist-100 placeholder:text-mist-500 outline-none focus:border-brand-500 transition-colors shadow-inner resize-y"
            />
            <p className="mt-1 text-[11px] text-mist-400">
              Provide talking points or keywords. OpenRouter generates channel-appropriate copy (Reels captions, YouTube SEO tags, X post threads).
            </p>
          </div>

          {/* TARGET CHANNELS MULTI-SELECT */}
          <div className="pt-2 border-t border-ink-800">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-mist-300 block">
                  Target Channels (Multi-Select)
                </span>
                <p className="text-[11px] text-mist-400">
                  Click to select which platforms you want the workflow to post to. Only selected channels will run.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAllChannels}
                  className="text-[11px] text-brand-400 hover:text-brand-300 font-medium transition-colors"
                >
                  Select all
                </button>
                <span className="text-ink-700">·</span>
                <button
                  type="button"
                  onClick={clearAllChannels}
                  className="text-[11px] text-mist-400 hover:text-mist-300 transition-colors"
                >
                  Clear
                </button>
                <Badge tone={selectedChannels.length > 0 ? "good" : "bad"}>
                  {selectedChannels.length} of {TARGET_CHANNELS.length} selected
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {TARGET_CHANNELS.map((ch) => {
                const Icon = ch.icon;
                const Custom = ch.customIcon;
                const isSelected = selectedChannels.includes(ch.name);

                return (
                  <button
                    key={ch.name}
                    type="button"
                    onClick={() => toggleChannel(ch.name)}
                    className={clsx(
                      "flex items-center gap-3 p-3 rounded-xl border text-left transition-all cursor-pointer select-none",
                      isSelected
                        ? "border-brand-500/60 bg-brand-500/10 shadow-sm shadow-brand-500/10 ring-1 ring-brand-500/20"
                        : "border-ink-800/80 bg-ink-950/40 opacity-50 hover:opacity-85 hover:border-ink-700",
                    )}
                  >
                    <div
                      className={clsx(
                        "grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br text-white shadow-sm transition-opacity",
                        ch.color,
                        !isSelected && "opacity-40 grayscale-[40%]",
                      )}
                    >
                      {Icon ? <Icon className="w-4 h-4" /> : Custom ? <Custom className="w-4 h-4" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-mist-100 flex items-center justify-between">
                        <span>{ch.name}</span>
                        {isSelected ? (
                          <span className="grid h-4 w-4 place-items-center rounded-full bg-good-500/20 text-good-400">
                            <Check className="w-2.5 h-2.5 stroke-[3]" />
                          </span>
                        ) : (
                          <span className="h-4 w-4 rounded-full border border-ink-700" />
                        )}
                      </div>
                      <div className="text-[10px] text-mist-400 truncate">
                        {isSelected ? ch.handle : "Not selected"}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            {selectedChannels.length === 0 && (
              <p className="mt-2 text-xs text-bad-400 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                Select at least one destination platform above before submitting.
              </p>
            )}
          </div>

          {/* SUBMIT BUTTON */}
          <div className="pt-4 border-t border-ink-800 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs text-mist-400">
              {isSubmitting ? (
                <span className="text-brand-300 font-medium flex items-center gap-2">
                  <span className="beacon-dot bg-brand-400" />
                  {uploadProgressText}
                </span>
              ) : (
                <span>
                  Dispatches video to{" "}
                  <strong className="text-mist-200">
                    {selectedChannels.length > 0 ? selectedChannels.join(", ") : "selected channels"}
                  </strong>{" "}
                  via the autonomous pipeline.
                </span>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !videoFile || selectedChannels.length === 0}
              className={clsx(
                "w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-white shadow-lg transition-all",
                isSubmitting || !videoFile || selectedChannels.length === 0
                  ? "bg-ink-800 text-mist-500 border border-ink-700 cursor-not-allowed"
                  : "bg-gradient-to-r from-brand-500 to-brand-400 hover:from-brand-400 hover:to-brand-300 shadow-brand-500/20 active:scale-[0.98]",
              )}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Uploading &amp; Triggering Pipeline…</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>
                    Publish to{" "}
                    {selectedChannels.length === TARGET_CHANNELS.length
                      ? "all channels"
                      : selectedChannels.length === 1
                      ? selectedChannels[0]
                      : `${selectedChannels.length} channels`}{" "}
                    (v2)
                  </span>
                </>
              )}
            </button>
          </div>
        </Card>
      </form>

      {/* ========================================================================= */}
      {/* SUBMISSION HISTORY                                                        */}
      {/* ========================================================================= */}
      <Card variant="panel" className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[15.5px] font-semibold tracking-tight text-mist-100 flex items-center gap-2">
              <Clock className="w-4 h-4 text-mist-400" />
              Recent v2 Pipeline Submissions
            </h2>
            <p className="mt-0.5 text-xs text-mist-400">
              Live audit log of multi-channel autonomous dispatches and delivery results (auto-refreshes every 10s).
            </p>
          </div>
          <div className="flex items-center gap-2">
            {submissions.length > 0 && (
              <button
                type="button"
                onClick={handleClearHistory}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-800 bg-ink-900 px-3 py-1.5 text-xs font-medium text-mist-400 hover:text-bad-400 hover:border-bad-500/30 transition-colors"
                title="Clear submission log"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            )}
            <button
              type="button"
              onClick={fetchSubmissions}
              disabled={loadingHistory}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs font-medium text-mist-200 hover:bg-ink-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={clsx("w-3.5 h-3.5", loadingHistory && "animate-spin")} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {submissions.length === 0 ? (
          <div className="py-12 px-4 rounded-xl border border-ink-800 bg-ink-950/40 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-ink-900 border border-ink-800 mx-auto text-mist-500 mb-3">
              <Film className="w-5 h-5" />
            </div>
            <h3 className="text-sm font-semibold text-mist-200">No v2 submissions yet</h3>
            <p className="mt-1 text-xs text-mist-400 max-w-sm mx-auto">
              Your autonomous pipeline runs will appear here as soon as you publish a video above.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-mist-400 font-medium">
                  <th className="pb-3 pl-2">Status</th>
                  <th className="pb-3">Video Title</th>
                  <th className="pb-3">Channels</th>
                  <th className="pb-3 pr-2 text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800/60">
                {submissions.map((sub) => {
                  const statusNormalized = (sub.status || "queued").toLowerCase();
                  const tone =
                    statusNormalized === "forwarded" || statusNormalized === "published"
                      ? "good"
                      : statusNormalized === "failed" || statusNormalized === "received_workflow_error"
                      ? "bad"
                      : "warn";

                  const displayStatus =
                    statusNormalized === "forwarded" || statusNormalized === "published"
                      ? "Forwarded"
                      : statusNormalized === "failed" || statusNormalized === "received_workflow_error"
                      ? "Failed"
                      : "Queued";

                  const channels = sub.platforms || sub.channels || ["Instagram", "YouTube", "Facebook", "X"];

                  return (
                    <tr key={sub.id} className="hover:bg-ink-850/40 transition-colors">
                      <td className="py-3.5 pl-2">
                        <Badge tone={tone}>{displayStatus}</Badge>
                      </td>
                      <td className="py-3.5 font-medium text-mist-100 max-w-[260px] truncate">
                        <div className="truncate">{sub.title || "Untitled Video"}</div>
                        {sub.error && (
                          <div className="text-[10.5px] text-bad-400 truncate mt-0.5" title={sub.error}>
                            {sub.error}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5">
                        <div className="flex flex-wrap gap-1">
                          {channels.map((ch) => (
                            <span
                              key={ch}
                              className="inline-flex items-center rounded-md bg-ink-800/80 px-2 py-0.5 text-[10.5px] text-mist-300 border border-ink-700/60"
                            >
                              {ch}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-3.5 pr-2 text-right text-mist-400 font-mono">
                        {formatTimestamp(sub.at || sub.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
