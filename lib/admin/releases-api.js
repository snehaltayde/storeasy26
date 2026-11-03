// Releases console API handler (S36 / BE09+MC13), extracted from the route in
// DOC-04 the way S53 extracted the storefront one: the route file is a thin
// NextResponse wrapper, so scripts/test-failure-matrix.js can drive the REAL
// publish path (authorization, snapshot, validation, storage) in plain node.
//   GET → history + live pointer + draft dirtiness (draft hash vs live hash)
//         + current validation result for the draft set
//   POST {action:"publish", note}                    → snapshot + validate + flip now
//   POST {action:"schedule", note, at}               → snapshot now, flip at `at`
//        (`at` = UTC ISO instant; the CONSOLE converts the merchant's local
//        datetime-local input via lib/admin/schedule.js in the browser, so
//        the merchant's own timezone — not the server's — decides the moment)
//   POST {action:"rollback", id}                     → point live at an older release
//   POST {action:"cancel", id}                       → S52: cancel a scheduled release
//   POST {action:"approve", note, expectedDraftHash} → S60: bless the reviewed candidate
//   POST {action:"preview", to?}                     → mint a signed preview URL
//        (S52: `to` deep-links the preview to a specific storefront path)
// GET also returns `diff` (S52): the per-item draft-vs-live change list.
// Everything is storefront.* gated: support stays read-only by construction.
//
// DOC-04: every answer is JSON. Validation is 422 with the structured issue
// list (same shape as save and preview). A deliberate refusal (too late to
// cancel, not found) keeps its 4xx. Anything else, a database failure above
// all, is 5xx with a code and a plain message. It used to be
// `e.status || 422`, so a failed snapshot read reached the founder as a
// validation message, and a failed GET was an unhandled 500 page.
import { requireAdmin } from "../admin-auth.js";
import { snapshotContent, validateRelease, createRelease, rollbackRelease, cancelScheduledRelease, listReleases, getLiveRelease, previewToken, releaseDiff } from "../releases.js";
import { approveCandidate, currentApproval } from "../cms/approvals.js";
import { audit } from "../platform/audit.js";
import { failure, issue, validationBody } from "../cms/issues.js";
import { captureError } from "../errors.js";
import { slog } from "../log.js";

async function view() {
  const [list, live, snap, diff, approval] = await Promise.all([listReleases({ limit: 20 }), getLiveRelease(), snapshotContent(), releaseDiff(), currentApproval()]);
  const validation = await validateRelease(snap.content);
  return {
    ...list,
    liveHash: live?.content_hash || null,
    draftHash: snap.hash,
    dirty: !live || live.content_hash !== snap.hash,
    diff,
    validation,
    approval, // S60: latest approval of THIS candidate (hash-bound), or null
  };
}

// After the change itself went through, the panel's refresh can still fail.
// Saying "nothing was published" then would be false: the live store HAS
// changed. So the answer is a success that says the page is out of date.
const RELOAD_NOTICES = {
  publish: "Published. Your live store has the new version, but this page couldn't refresh, so it may show old details. Reload it.",
  schedule: "Scheduled, but this page couldn't refresh, so it may show old details. Reload it to see the pending publish.",
  rollback: "Rolled back. Your live store shows that version, but this page couldn't refresh, so it may show old details. Reload it.",
  cancel: "Schedule cancelled, but this page couldn't refresh, so it may still list it. Reload it.",
  approve: "Approved, but this page couldn't refresh, so it may show old details. Reload it.",
};

async function withView(action, result) {
  try {
    return { status: 200, body: { ok: true, ...result, ...(await view()) } };
  } catch (e) {
    slog("releases_view_failed_after_write", { action, error: String(e?.message || e).slice(0, 300) });
    return { status: 200, body: { ok: true, ...result, code: "RELOAD_NEEDED", notice: RELOAD_NOTICES[action] } };
  }
}

async function failed(e, doing) {
  const f = failure(e, { doing });
  if (f.status >= 500 || f.kind === "conflict") {
    slog("releases_api_failure", { doing, status: f.status, code: f.body.code, error: String(e?.message || e).slice(0, 300) });
    if (f.kind === "internal") await captureError({ source: "releases-api", error: e, extra: { doing } });
  }
  return { status: f.status, body: f.body };
}

export async function handleReleasesGet(request) {
  try {
    const auth = await requireAdmin(request, "storefront.read");
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
    return { status: 200, body: { ok: true, ...(await view()) } };
  } catch (e) {
    return failed(e, "load");
  }
}

export async function handleReleasesPost(request) {
  const body = (await request.json().catch(() => ({}))) || {};
  const action = body.action;
  const doing = action === "preview" ? "preview" : action === "publish" || action === "schedule" || action === "rollback" ? "publish" : "save";
  try {
    // S55: publishing is its OWN capability — staff edit drafts and preview,
    // but flipping live (publish/schedule/rollback/cancel) is admin+.
    const auth = await requireAdmin(request, action === "preview" ? "storefront.read" : "storefront.publish");
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
    return await act(body, action, auth);
  } catch (e) {
    if (e.code === "RELEASE_INVALID") {
      return { status: 422, body: validationBody(e.issues || [], { error: "Publishing is blocked until these are fixed", sections: e.sections || [] }) };
    }
    if (e.code === "DRAFTS_CHANGED") {
      // carry the FRESH view so the client can re-render the updated diff
      try {
        return { status: 409, body: { error: String(e.message), code: e.code, ...(await view()) } };
      } catch (viewError) {
        return failed(viewError, "load");
      }
    }
    return failed(e, doing);
  }
}

async function act(body, action, auth) {
  // S53 (0B-1): expectedDraftHash binds publish/schedule to the EXACT
  // reviewed candidate; a mismatch is a 409 carrying the fresh view.
  const expectedDraftHash = typeof body.expectedDraftHash === "string" && body.expectedDraftHash ? body.expectedDraftHash : null;
  // Each write below has gone through once its call returns; the refresh
  // after it (withView) can no longer turn the answer into a failure.
  if (action === "publish") {
    const r = await createRelease({ note: body.note, actor: auth.actor, expectedDraftHash });
    return withView(action, { published: r });
  }
  if (action === "schedule") {
    const at = new Date(String(body.at || ""));
    const when = (message) => ({ status: 422, body: validationBody([issue({ field: "at", code: "SCHEDULE_INVALID", message })]) });
    if (Number.isNaN(at.getTime())) return when("Scheduled time is invalid");
    if (at <= new Date()) return when("Scheduled time must be in the future");
    const r = await createRelease({ note: body.note, actor: auth.actor, scheduledFor: at.toISOString(), expectedDraftHash });
    return withView(action, { scheduled: r });
  }
  if (action === "rollback") {
    await rollbackRelease(String(body.id || ""), { actor: auth.actor });
    return withView(action, {});
  }
  if (action === "cancel") {
    await cancelScheduledRelease(String(body.id || ""), { actor: auth.actor });
    return withView(action, {});
  }
  if (action === "approve") {
    // S60: bless EXACTLY the reviewed candidate — stale hash = 409 with
    // the fresh view, same contract as publish.
    const a = await approveCandidate({ expectedHash: expectedDraftHash, actor: `${auth.actor.kind}:${auth.actor.id}`, note: body.note });
    await audit({ actor: auth.actor, action: "storefront.publish", resource: `approval:${a.draft_hash.slice(0, 12)}` });
    return withView(action, { approved: a });
  }
  if (action === "preview") {
    const token = await previewToken();
    // S52: deep-link the preview — a path only, same-site, no protocol tricks
    const to = typeof body.to === "string" && /^\/[^\s]*$/.test(body.to) && !body.to.startsWith("//") ? body.to : "/";
    return { status: 200, body: { ok: true, url: `/api/preview?token=${token}&to=${encodeURIComponent(to)}` } };
  }
  return { status: 400, body: { error: "action must be publish|schedule|rollback|cancel|preview" } };
}
