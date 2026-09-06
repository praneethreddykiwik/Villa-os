import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { guard } from "@/lib/auth/guard";
import { rateLimit } from "@/lib/ops/ratelimit";
import { classifyProbe, videoFormUrl, videoFormUrlProblem } from "@/lib/automation/video-post";

/**
 * "Test connection" for the video hand-off.
 *
 * A GET of the form URL, nothing more: an active Form trigger serves its page
 * (200), an inactive or mistyped one answers 404 / "Problem loading form". No
 * video, no field, so nothing can run in the workflow. `workflows.manage`
 * because the answer reveals whether the configured URL is live.
 */

export const runtime = "nodejs";

const PROBE_TIMEOUT_MS = 10_000;

export async function POST() {
  try {
    const denied = await guard("workflows.manage");
    if (denied) return denied;

    const limit = rateLimit("automation:test-connection", { max: 30, windowSeconds: 60, lockoutSeconds: 60 });
    if (!limit.allowed) return apiFail("Too many connection tests. Wait a minute.", 429);

    const problem = videoFormUrlProblem();
    if (problem) return apiOk({ state: "inactive", detail: problem, elapsedMs: 0 });

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(videoFormUrl(), {
        method: "GET",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (e) {
      return apiOk({
        state: "unreachable",
        detail: `The publishing workflow could not be reached: ${e instanceof Error ? e.message : String(e)}`,
        elapsedMs: Date.now() - startedAt,
      });
    }
    const body = await res.text().catch(() => "");
    return apiOk({ ...classifyProbe(res.status, body), httpStatus: res.status, elapsedMs: Date.now() - startedAt });
  } catch (e) {
    return apiError(e);
  }
}
