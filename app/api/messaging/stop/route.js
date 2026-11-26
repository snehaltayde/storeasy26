import { NextResponse } from "next/server";
import { storefrontHandler } from "@/lib/storefront-request";
import { rateLimitAsync } from "@/lib/rate-limit";
import { requestOrigin, sameOrigin } from "@/lib/origin-check";
import { revokeById, verifyStopToken } from "@/lib/messaging/consent";

// Phase 9 line 3: the stop page's form (app/(storefront)/m/stop). The signed
// token (lib/messaging/consent.js stopToken) is the only proof: it names one
// consent, and every live WhatsApp consent for that consent's phone is
// revoked. A bad or expired token changes nothing. Answers with a 303 back to
// the stop page (no script needed). 20 per 10 minutes.
//   POST form { t }
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = storefrontHandler(async (request) => {
  if (!sameOrigin(request)) return NextResponse.json({ error: "This request isn't allowed." }, { status: 403 });
  const limited = await rateLimitAsync(request, { name: "wa-stop", limit: 20, windowMs: 10 * 60_000 });
  if (limited) return limited;
  const form = await request.formData().catch(() => null);
  const t = String(form?.get("t") ?? "");
  const id = await verifyStopToken(t);
  const back = new URL("/m/stop", requestOrigin(request));
  if (!id) {
    back.searchParams.set("bad", "1");
    return NextResponse.redirect(back, 303);
  }
  await revokeById(id, "stop_link");
  back.searchParams.set("done", "1");
  return NextResponse.redirect(back, 303);
});
