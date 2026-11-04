import { NextResponse, after } from "next/server";
import { submitContactMessage } from "@/lib/notifications";
import { rateLimit } from "@/lib/rate-limit";
import { tenantCfg } from "@/lib/tenant-context";
import { siteName } from "@/lib/site";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { closedStoreGate, STORE_CLOSED_CODE, STORE_CLOSED_MESSAGE } from "@/lib/content/resolve";

// Contact form endpoint (S39 / SF15). Rate-limited per IP, honeypot-guarded,
// server-validated. The message is STORED first (console inbox), the merchant
// copy rides the BE23 notification queue — the shopper gets an honest
// "received" (delivery to the merchant is asynchronous and tracked).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = tenantHandler(async (request) => {
  const limited = rateLimit(request, { name: "contact", limit: 5, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;
  // PUB-06: a store that has never published takes no messages, except from
  // a founder's valid preview session (a test from the console).
  const closed = await closedStoreGate();
  if (closed && !closed.preview) return NextResponse.json({ error: STORE_CLOSED_MESSAGE, code: STORE_CLOSED_CODE }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  // honeypot: real shoppers never fill "website" — bots do; answer 200 so the
  // bot learns nothing, store nothing.
  if (String(body.website || "").trim()) return NextResponse.json({ ok: true, received: true });

  try {
    const site = tenantCfg("site", null, null) || {};
    const r = await submitContactMessage(
      { name: body.name, email: body.email, message: body.message },
      { supportEmail: site.support_email || "", storeName: siteName() },
    );
    if (r.jobId) {
      after(async () => {
        const { runJobById } = await import("@/lib/platform/worker.js");
        await runJobById(r.jobId).catch(() => {});
      });
    }
    slog("contact_message", { id: r.id });
    return NextResponse.json({ ok: true, received: true, id: r.id });
  } catch (e) {
    if (e.code === "CONTACT_INVALID") return NextResponse.json({ error: e.message, errors: e.errors }, { status: 422 });
    return NextResponse.json({ error: "Something went wrong — please try again." }, { status: 500 });
  }
});
