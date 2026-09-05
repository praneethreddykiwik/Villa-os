import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { cleanup, isolate } from "./helpers";

/**
 * The video hand-off to n8n.
 *
 * Every behaviour pinned here is one whose absence is silent rather than loud:
 * a submission accepted with no platform selected (uploaded, then dropped by a
 * workflow with nothing to do), a JPEG accepted as the "Video File" (which fails
 * deep inside somebody else's automation, after the Drive folder was created), a
 * misconfigured URL that forwards the video over plaintext, and a submission row
 * that never leaves "queued" so nobody can tell what actually happened.
 */

const dir = isolate("automation");
after(() => cleanup(dir));

const V = require("../src/lib/automation/video-post") as typeof import("../src/lib/automation/video-post");
const { FIELDS, MAX_IMAGE_BYTES } = require("../src/lib/automation/types") as typeof import("../src/lib/automation/types");
const { read } = require("../src/lib/db") as typeof import("../src/lib/db");

/** Minimal ISO-BMFF header — enough for the magic-byte check, as a real mp4 is. */
function mp4(): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
}

function jpeg(bytes = 64): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes)]);
}

function form(over: Record<string, string | string[]> = {}): FormData {
  const f = new FormData();
  const base: Record<string, string | string[]> = {
    [FIELDS.title]: "Villa walkthrough",
    [FIELDS.description]: "Two-minute tour of the show villa.",
    [FIELDS.platforms]: ["YouTube"],
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) {
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  }
  return f;
}

describe("submission fields", () => {
  test("title and description are required — an empty one is not silently forwarded", () => {
    for (const field of [FIELDS.title, FIELDS.description]) {
      const r = V.readFields(form({ [field]: "" }));
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.error, new RegExp(field.split(" ")[1], "i"));
    }
  });

  test("at least one platform is required", () => {
    const r = V.readFields(form({ [FIELDS.platforms]: [] }));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /at least one platform/i);
  });

  test("an unknown platform is named and refused, not dropped", () => {
    const r = V.readFields(form({ [FIELDS.platforms]: ["TikTok"] }));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /TikTok/);
  });

  test("both the repeated-part and the comma-separated shape are accepted, deduplicated", () => {
    const repeated = V.readFields(form({ [FIELDS.platforms]: ["YouTube", "Instagram", "YouTube"] }));
    assert.equal(repeated.ok, true);
    assert.deepEqual(repeated.ok && repeated.fields.platforms, ["YouTube", "Instagram"]);

    const joined = V.readFields(form({ [FIELDS.platforms]: "YouTube, Instagram" }));
    assert.equal(joined.ok, true);
    assert.deepEqual(joined.ok && joined.fields.platforms, ["YouTube", "Instagram"]);
  });

  test("the Drive selects default to create-yes and share-no", () => {
    const r = V.readFields(form());
    assert.equal(r.ok && r.fields.createFolder, "yes");
    // Defaulting this to yes would publish unreleased marketing material to
    // anyone holding the folder link, as a side effect of leaving a select alone.
    assert.equal(r.ok && r.fields.publicLink, "no");
  });

  test("a select value that is neither yes nor no is refused", () => {
    const r = V.readFields(form({ [FIELDS.publicLink]: "maybe" }));
    assert.equal(r.ok, false);
  });
});

describe("file checks", () => {
  /** The refusal message, or "" when the check passed. */
  function why(r: import("../src/lib/automation/video-post").FileCheck): string {
    return r.ok ? "" : r.error;
  }

  test("the video is confirmed from its own bytes, not its part name", () => {
    const good = V.checkVideo(mp4());
    assert.equal(good.ok, true);
    // The proved container is carried forward, so the forwarded part is typed
    // from what the bytes are rather than what the browser said they were.
    assert.equal(good.ok && good.mime, "video/mp4");
    assert.match(why(V.checkVideo(jpeg())), /must be a video/i);
    assert.equal(V.checkVideo(Buffer.alloc(0)).ok, false);
  });

  test("a thumbnail must be an image, and is capped well below the video limit", () => {
    assert.equal(V.checkImage(FIELDS.finalThumbnail, jpeg()).ok, true);
    assert.match(why(V.checkImage(FIELDS.finalThumbnail, mp4())), /must be an image/i);
    assert.match(why(V.checkImage(FIELDS.finalThumbnail, jpeg(MAX_IMAGE_BYTES + 1))), /image limit/i);
  });

  test("more than three reference photos is refused", () => {
    assert.equal(V.checkReferenceCount(3), null);
    assert.match(V.checkReferenceCount(4) ?? "", /at most 3/);
  });
});

describe("workflow URL configuration", () => {
  test("an unset URL names the setting instead of failing vaguely", () => {
    delete process.env.N8N_VIDEO_FORM_URL;
    assert.match(V.videoFormUrlProblem() ?? "", /N8N_VIDEO_FORM_URL/);
  });

  test("a blank value counts as unset, not as a usable URL", () => {
    process.env.N8N_VIDEO_FORM_URL = "   ";
    assert.notEqual(V.videoFormUrlProblem(), null);
  });

  test("plaintext and private hosts are refused — the video would carry the brand's material", () => {
    for (const url of ["http://n8n.example.com/webhook/x", "https://127.0.0.1/webhook/x"]) {
      process.env.N8N_VIDEO_FORM_URL = url;
      assert.notEqual(V.videoFormUrlProblem(), null, `${url} should be refused`);
    }
  });

  test("a normal https workflow URL is accepted", () => {
    process.env.N8N_VIDEO_FORM_URL = "https://n8n.example.com/form/abc";
    assert.equal(V.videoFormUrlProblem(), null);
  });
});

describe("submission log", () => {
  test("a submission is recorded as queued before the forward and settled after", () => {
    const row = V.openSubmission({ by: "someone@test.invalid", title: "Villa walkthrough", platforms: ["YouTube"] });
    assert.equal(row.status, "queued");
    assert.equal(read().n8nSubmissions.at(-1)?.id, row.id);

    const settled = V.settleSubmission(row.id, { status: "forwarded", n8nStatus: 200 });
    assert.equal(settled?.status, "forwarded");
    assert.equal(read().n8nSubmissions.find((s) => s.id === row.id)?.n8nStatus, 200);
  });

  test("a failure keeps the row and the reason rather than deleting the evidence", () => {
    const row = V.openSubmission({ by: "someone@test.invalid", title: "Failed one", platforms: ["Instagram"] });
    V.settleSubmission(row.id, { status: "failed", n8nStatus: 500, error: "The workflow answered 500." });
    const stored = read().n8nSubmissions.find((s) => s.id === row.id);
    assert.equal(stored?.status, "failed");
    assert.match(stored?.error ?? "", /500/);
  });

  test("history is newest first, so the last attempt is the one on screen", () => {
    const recent = V.recentSubmissions(10);
    assert.equal(recent[0]?.title, "Failed one");
  });
});
