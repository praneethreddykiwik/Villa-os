import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { actorLabel, requirePermission } from "@/lib/auth/session";
import { logActivity } from "@/lib/engine/publisher";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { rateLimit } from "@/lib/ops/ratelimit";
import { checkVideo, videoFormUrl } from "@/lib/automation/video-post";
import type { N8nSubmission } from "@/lib/automation/types";
import { uid } from "@/lib/ids";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB
const DEFAULT_FALLBACK_URL = "https://n8n-fthf.srv1957365.hstgr.cloud/form/08aff311-d3ec-4696-b160-9597c47fe57e";
const FORWARD_TIMEOUT_MS = 180_000;

function extractFile(form: FormData, ...names: string[]): File | undefined {
  for (const name of names) {
    const v = form.get(name);
    if (v instanceof File && v.size > 0) return v;
  }
  return undefined;
}

function extractString(form: FormData, ...names: string[]): string {
  for (const name of names) {
    const v = form.get(name);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export async function POST(req: Request) {
  try {
    const session = await requirePermission("marketing.publish");

    // Rate limiting
    const limit = rateLimit(`automation:v2:post-video:${session.userId}`, {
      max: 12,
      windowSeconds: 3600,
      lockoutSeconds: 900,
    });
    if (!limit.allowed) {
      return apiFail(
        `Too many video submissions. Try again in ${limit.retryAfterSeconds ?? 900} seconds.`,
        429,
      );
    }

    // Validate Content-Type
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return apiFail("Send the submission as multipart/form-data.", 415);
    }

    // Safe formData extraction
    let form: FormData;
    try {
      form = await req.formData();
    } catch (err) {
      return apiFail(
        `Failed to parse upload: ${err instanceof Error ? err.message : String(err)}. Check that the video file is valid.`,
        400,
      );
    }

    // Extract fields
    const video = extractFile(form, "videoFile", "field-0", "video", "Video File");
    const title = extractString(form, "videoTitle", "field-1", "title", "Video Title");
    const description = extractString(form, "Video Description", "field-2", "description", "videoDescription");

    // Validation
    if (!video) {
      return apiFail("Video file is required.", 400);
    }
    if (video.size > MAX_VIDEO_BYTES) {
      return apiFail(
        `Video is ${(video.size / (1024 * 1024)).toFixed(0)} MB. The limit is 500 MB.`,
        413,
      );
    }
    if (!title) {
      return apiFail("Title is required.", 400);
    }

    // Magic byte verification (first 64 bytes)
    const videoHead = Buffer.from(await video.slice(0, 64).arrayBuffer());
    const videoCheck = checkVideo(videoHead);
    if (!videoCheck.ok) {
      return apiFail(videoCheck.error, 415);
    }

    // Extract platforms from form (handles array, JSON string, or comma-separated)
    let selectedPlatforms: string[] = [];
    const platformsRaw = form.getAll("platforms");
    for (const item of platformsRaw) {
      if (typeof item === "string") {
        try {
          const parsed = JSON.parse(item);
          if (Array.isArray(parsed)) {
            selectedPlatforms.push(...parsed.filter((p) => typeof p === "string"));
            continue;
          }
        } catch {}
        selectedPlatforms.push(...item.split(",").map((p) => p.trim()).filter(Boolean));
      }
    }
    const whichRaw = form.getAll("Which Platforms to Post To");
    for (const item of whichRaw) {
      if (typeof item === "string") {
        selectedPlatforms.push(...item.split(",").map((p) => p.trim()).filter(Boolean));
      }
    }
    selectedPlatforms = Array.from(new Set(selectedPlatforms)).filter(Boolean);
    if (selectedPlatforms.length === 0) {
      selectedPlatforms = ["YouTube", "Instagram", "Facebook", "X (Twitter)"];
    }

    // Construct outbound FormData for n8n
    const filename = video.name?.slice(0, 200) || "video.mp4";
    const videoSlice = video.slice(0, video.size, videoCheck.mime);

    const outbound = new FormData();
    outbound.append("field-0", videoSlice, filename);
    outbound.append("videoFile", videoSlice, filename);
    outbound.append("Video File", videoSlice, filename);
    outbound.append("field-1", title);
    outbound.append("videoTitle", title);
    outbound.append("Video Title", title);
    outbound.append("field-2", description);
    outbound.append("Video Description", description);
    outbound.append("videoDescription", description);
    outbound.append("platforms", selectedPlatforms.join(","));
    outbound.append("Which Platforms to Post To", selectedPlatforms.join(","));
    for (const p of selectedPlatforms) {
      outbound.append("selectedPlatforms", p);
    }

    // Destination workflow URL
    const configuredUrl = videoFormUrl();
    const url = configuredUrl || DEFAULT_FALLBACK_URL;

    // Forward to workflow
    let res: Response | null = null;
    let fetchError: string | null = null;
    try {
      res = await fetch(url, {
        method: "POST",
        body: outbound,
        redirect: "manual",
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
    } catch (e) {
      fetchError = e instanceof Error ? e.message : "The workflow could not be reached.";
    }

    const accepted = Boolean(!fetchError && res && res.status >= 200 && res.status < 400);
    const now = new Date().toISOString();
    const submissionId = uid("n8nsub");

    const submission: N8nSubmission = {
      id: submissionId,
      at: now,
      by: actorLabel(session),
      title,
      platforms: selectedPlatforms as any,
      version: "v2",
      status: accepted ? "forwarded" : "failed",
      n8nStatus: res?.status,
      ...(fetchError
        ? { error: fetchError }
        : !accepted && res
          ? { error: `Workflow responded with status ${res.status}` }
          : {}),
      settledAt: now,
    };

    // Persist submission record in db.n8nSubmissions
    mutate((db) => {
      db.n8nSubmissions = [...(db.n8nSubmissions ?? []), submission].slice(-200);
    });

    // Log activity
    const brandId = resolveBrandId(read(), null);
  {
    const { getSession, assertBrandAccess } = require("@/lib/auth/session");
    const session = await getSession();
    if (session) assertBrandAccess(session, brandId);
  }
    if (brandId) {
      logActivity(
        brandId,
        "integrations",
        `Video "${title}" (v2) ${accepted ? "forwarded to" : "failed to forward to"} publishing workflow for ${submission.platforms.join(", ")}`,
        actorLabel(session),
      );
    }

    if (!accepted) {
      return apiFail(
        fetchError || (res ? `Publishing workflow failed with status ${res.status}` : "Workflow unreachable"),
        502,
      );
    }

    return apiOk({ submission });
  } catch (e) {
    return apiError(e);
  }
}
