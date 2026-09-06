import { guard } from "@/lib/auth/guard";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import {
  checkUploadPostStatus,
  isUploadPostConfigured,
  uploadPostPhotos,
  uploadPostVideo,
} from "@/lib/uploadpost/client";

export async function GET() {
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  try {
    const status = await checkUploadPostStatus();
    return apiOk({ ...status });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  if (!isUploadPostConfigured()) {
    return apiFail("The publishing connector is not configured.", 503);
  }

  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const action = String(formData.get("action") ?? "upload_video");
      const platforms = formData.getAll("platforms[]").map(String);
      const title = formData.get("title") ? String(formData.get("title")) : undefined;
      const description = formData.get("description") ? String(formData.get("description")) : undefined;

      if (action === "upload_video") {
        const file = formData.get("video");
        const videoUrl = formData.get("video_url") ? String(formData.get("video_url")) : undefined;

        if (!file && !videoUrl) {
          return apiFail("A video file or video_url is required.", 400);
        }

        const res = await uploadPostVideo({
          platforms: platforms.length ? platforms : ["instagram", "youtube"],
          video: (file as Blob) || videoUrl!,
          title,
          description,
        });

        if (!res.ok) return apiFail(res.error || "Publishing connector publish failed", 502);
        return apiOk((res.data as Record<string, unknown>) ?? { success: true });
      }

      if (action === "upload_photos") {
        const photos = formData.getAll("photos[]").map((p) => p as Blob);
        if (!photos.length) return apiFail("At least one photo is required.", 400);

        const res = await uploadPostPhotos({
          platforms: platforms.length ? platforms : ["instagram"],
          photos,
          title,
          description,
        });

        if (!res.ok) return apiFail(res.error || "Publishing connector photo publish failed", 502);
        return apiOk((res.data as Record<string, unknown>) ?? { success: true });
      }

      return apiFail(`Unknown action "${action}".`, 400);
    }

    // JSON payload
    const body = (await req.json()) as {
      action?: string;
      platforms?: string[];
      video_url?: string;
      photos?: string[];
      title?: string;
      description?: string;
    };

    if (body.action === "upload_video") {
      if (!body.video_url) return apiFail("video_url is required for JSON request.", 400);
      const res = await uploadPostVideo({
        platforms: body.platforms ?? ["instagram", "youtube"],
        video: body.video_url,
        title: body.title,
        description: body.description,
      });

      if (!res.ok) return apiFail(res.error || "Publishing connector publish failed", 502);
      return apiOk((res.data as Record<string, unknown>) ?? { success: true });
    }

    if (body.action === "upload_photos") {
      if (!body.photos || !body.photos.length) return apiFail("photos array of URLs is required.", 400);
      const res = await uploadPostPhotos({
        platforms: body.platforms ?? ["instagram"],
        photos: body.photos,
        title: body.title,
        description: body.description,
      });

      if (!res.ok) return apiFail(res.error || "Publishing connector photo publish failed", 502);
      return apiOk((res.data as Record<string, unknown>) ?? { success: true });
    }

    // Default action: probe status
    const status = await checkUploadPostStatus();
    return apiOk({ ...status });
  } catch (e) {
    return apiError(e);
  }
}
