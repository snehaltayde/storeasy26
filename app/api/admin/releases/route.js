import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { snapshotContent, validateRelease, createRelease, rollbackRelease, cancelScheduledRelease, listReleases, getLiveRelease, previewToken, releaseDiff } from "@/lib/releases";
import { tenantHandler } from "@/lib/tenant-request";

// Releases console API (S36 / BE09+MC13).
//   GET → history + live pointer + draft dirtiness (draft hash vs live hash)
//         + current validation result for the draft set
//   POST {action:"publish", note}                    → snapshot + validate + flip now
//   POST {action:"schedule", note, at}               → snapshot now, flip at `at`
//        (`at` = UTC ISO instant; the CONSOLE converts the merchant's local
//        datetime-local input via lib/admin/schedule.js in the browser, so
//        the merchant's own timezone — not the server's — decides the moment)
//   POST {action:"rollback", id}                     → point live at an older release
//   POST {action:"cancel", id}                       → S52: cancel a scheduled release
//   POST {action:"preview", to?}                     → mint a signed preview URL
//        (S52: `to` deep-links the preview to a specific storefront path)
// GET also returns `diff` (S52): the per-item draft-vs-live change list.
// Everything is storefront.* gated: support stays read-only by construction.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function view() {
  const [list, live, snap, diff] = await Promise.all([listReleases({ limit: 20 }), getLiveRelease(), snapshotContent(), releaseDiff()]);
  const validation = await validateRelease(snap.content);
  return {
    ...list,
    liveHash: live?.content_hash || null,
    draftHash: snap.hash,
    dirty: !live || live.content_hash !== snap.hash,
    diff,
    validation,
  };
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, ...(await view()) });
});

export const POST = tenantHandler(async (request) => {
  const body = await request.json().catch(() => ({}));
  const action = body.action;
  const auth = await requireAdmin(request, action === "preview" ? "storefront.read" : "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    // S53 (0B-1): expectedDraftHash binds publish/schedule to the EXACT
    // reviewed candidate; a mismatch is a 409 carrying the fresh view.
    const expectedDraftHash = typeof body.expectedDraftHash === "string" && body.expectedDraftHash ? body.expectedDraftHash : null;
    if (action === "publish") {
      const r = await createRelease({ note: body.note, actor: auth.actor, expectedDraftHash });
      return NextResponse.json({ ok: true, published: r, ...(await view()) });
    }
    if (action === "schedule") {
      const at = new Date(String(body.at || ""));
      if (Number.isNaN(at.getTime())) return NextResponse.json({ error: "Scheduled time is invalid" }, { status: 422 });
      if (at <= new Date()) return NextResponse.json({ error: "Scheduled time must be in the future" }, { status: 422 });
      const r = await createRelease({ note: body.note, actor: auth.actor, scheduledFor: at.toISOString(), expectedDraftHash });
      return NextResponse.json({ ok: true, scheduled: r, ...(await view()) });
    }
    if (action === "rollback") {
      await rollbackRelease(String(body.id || ""), { actor: auth.actor });
      return NextResponse.json({ ok: true, ...(await view()) });
    }
    if (action === "cancel") {
      await cancelScheduledRelease(String(body.id || ""), { actor: auth.actor });
      return NextResponse.json({ ok: true, ...(await view()) });
    }
    if (action === "preview") {
      const token = await previewToken();
      // S52: deep-link the preview — a path only, same-site, no protocol tricks
      const to = typeof body.to === "string" && /^\/[^\s]*$/.test(body.to) && !body.to.startsWith("//") ? body.to : "/";
      return NextResponse.json({ ok: true, url: `/api/preview?token=${token}&to=${encodeURIComponent(to)}` });
    }
    return NextResponse.json({ error: "action must be publish|schedule|rollback|cancel|preview" }, { status: 400 });
  } catch (e) {
    if (e.code === "RELEASE_INVALID") {
      return NextResponse.json({ error: "Publish blocked by validation", errors: e.errors, warnings: e.warnings }, { status: 422 });
    }
    if (e.code === "DRAFTS_CHANGED") {
      // carry the FRESH view so the client can re-render the updated diff
      return NextResponse.json({ error: String(e.message), code: e.code, ...(await view()) }, { status: 409 });
    }
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: e.status || 422 });
  }
});
