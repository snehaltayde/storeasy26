import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { appErrorAnswer } from "@/lib/plugins/installs";
import { pauseEndpoint, resumeEndpoint, rotateSecret, saveEndpoint, sendTestEvent, webhooksView } from "@/lib/plugins/custom-apps";
import { resend } from "@/lib/plugins/deliveries";

// An app's webhooks (Phase 4 line 3). [id] is the install id (pin_…).
//   GET  apps.read  ?status=&topic= → { endpoint, topics, deliveries, canSeePayloads }
//        (the last 50 deliveries; payloads only for roles without PII
//        redaction; the signing secret is never returned)
//   POST apps.manage, one of
//        { endpoint: { url, topics? } } | { rotate_secret: true } (→ { secret }, once)
//        | { test: true } | { pause: true } | { resume: true } | { resend: "<dlv_…>" }
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });
const appFailure = (e) => {
  const f = appErrorAnswer(e, "admin/apps/[id]/webhooks");
  return NextResponse.json(f.body, { status: f.status });
};
const ACTIONS = ["endpoint", "rotate_secret", "test", "pause", "resume", "resend"];
const NO_STORE = { headers: { "cache-control": "no-store" } };

export const GET = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.read");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const q = new URL(request.url).searchParams;
  try {
    const view = await webhooksView(String(id || ""), { role: auth.actor.role, status: q.get("status"), topic: q.get("topic") });
    return NextResponse.json({ ok: true, ...view });
  } catch (e) {
    return appFailure(e);
  }
});

export const POST = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.manage");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const asked = ACTIONS.filter((a) => body && body[a] !== undefined && body[a] !== false);
  if (asked.length !== 1) return NextResponse.json({ error: "Choose one thing to change.", code: "BAD_REQUEST" }, { status: 400 });
  const installId = String(id || "");
  const opts = { actor: auth.actor };
  try {
    switch (asked[0]) {
      case "endpoint":
        return NextResponse.json({ ok: true, ...(await saveEndpoint(installId, typeof body.endpoint === "object" && body.endpoint ? body.endpoint : {}, opts)) });
      case "rotate_secret":
        return NextResponse.json({ ok: true, ...(await rotateSecret(installId, opts)) }, NO_STORE);
      case "test":
        return NextResponse.json({ ok: true, ...(await sendTestEvent(installId, opts)) });
      case "pause":
        return NextResponse.json({ ok: true, ...(await pauseEndpoint(installId, opts)) });
      case "resume":
        return NextResponse.json({ ok: true, ...(await resumeEndpoint(installId, opts)) });
      default:
        return NextResponse.json({ ok: true, delivery: await resend(installId, String(body.resend), opts) });
    }
  } catch (e) {
    return appFailure(e);
  }
});
