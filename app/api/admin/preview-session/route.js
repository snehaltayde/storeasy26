import { NextResponse } from "next/server";
import { handlePreviewSessionPost } from "@/lib/admin/preview-session-api";
import { tenantHandler } from "@/lib/tenant-request";

// P2-PREVIEW (PV-03, spec 8.8): preview sessions for stores in documents mode.
//   POST { create: true }               a session and its token (p.<exp>.<sid>.<hmac>)
//   POST { showDesign: { sid, on } }    add (or drop) the design draft in that preview;
//                                       on: true also reaches the session this browser's
//                                       _preview cookie names (P3-FIX5, finding D1)
//   POST { revoke: sid }                end the session now
// storefront.read, same origin. Legacy stores get 409 STORE_USES_LEGACY: they
// keep the releases preview. The handler lives in lib/admin/preview-session-api.js
// so scripts/test-preview-overlay.js runs the real dispatch.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = tenantHandler(async (request) => {
  const r = await handlePreviewSessionPost(request);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
});
