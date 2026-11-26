import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { sameOrigin, requestOrigin } from "@/lib/origin-check";
import { tenantHandler } from "@/lib/tenant-request";
import { slog } from "@/lib/log";
import { REFUSED, ReviewError, recordOptOut, reviewsActive, submitReview } from "@/lib/reviews/store";
import { verifyOptOutToken } from "@/lib/reviews/tokens";

// Phase 9 line 1: a buyer's review from a signed invite link, and the
// "Don't ask me for reviews" opt-out. No sign-in: the link is the proof
// (lib/reviews/tokens.js), checked against this store's own invite rows (the
// store comes from the host). 10 posts an hour per address.
//   POST { t, rating, title?, body, display_name }    → the review, pending
//   POST { kind: "optout", t }                         → the email's opt-out
// A plain HTML form (no JavaScript) posts form fields and gets a 303 back to
// the page; a script posting JSON gets JSON. Every refused link (used,
// expired, tampered, another store's, Reviews off) gets the same words.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isForm = (request) => /application\/x-www-form-urlencoded|multipart\/form-data/i.test(request.headers.get("content-type") || "");
async function readBody(request) {
  if (isForm(request)) {
    const f = await request.formData().catch(() => null);
    return f ? Object.fromEntries([...f.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""])) : {};
  }
  return (await request.json().catch(() => ({}))) || {};
}
const back = (request, path) => NextResponse.redirect(`${requestOrigin(request)}${path}`, 303);

export const POST = tenantHandler(async (request) => {
  const limited = rateLimit(request, { name: "reviews", limit: 10, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;
  if (!sameOrigin(request)) return NextResponse.json({ error: "This form can only be sent from the store's own page." }, { status: 403 });
  const form = isForm(request);
  const body = await readBody(request);
  const token = String(body.t || "").slice(0, 200);

  if (body.kind === "optout") {
    const hash = await verifyOptOutToken(token);
    if (!hash) {
      slog("review_token_refused", { kind: "optout" });
      return form ? back(request, "/reviews/optout?refused=1") : NextResponse.json({ error: "This link isn't valid." }, { status: 400 });
    }
    await recordOptOut(hash);
    return form ? back(request, "/reviews/optout?done=1") : NextResponse.json({ ok: true });
  }

  try {
    if (!(await reviewsActive())) throw new ReviewError("REFUSED", REFUSED);
    const r = await submitReview(token, { rating: body.rating, title: body.title, body: body.body, display_name: body.display_name });
    slog("review_submitted", { id: r.id });
    return form ? back(request, "/reviews/write?done=1") : NextResponse.json({ ok: true, status: "pending" });
  } catch (e) {
    if (e instanceof ReviewError && e.code === "INVALID") {
      const fields = Object.keys(e.errors || {}).join(",");
      return form ? back(request, `/reviews/write?t=${encodeURIComponent(token)}&err=${encodeURIComponent(fields)}`) : NextResponse.json({ error: e.message, errors: e.errors }, { status: 422 });
    }
    if (e instanceof ReviewError) {
      slog("review_token_refused", { kind: "review" });
      return form ? back(request, "/reviews/write?refused=1") : NextResponse.json({ error: REFUSED, code: "REFUSED" }, { status: 410 });
    }
    slog("review_submit_failed", { error: String(e?.name || "Error") });
    return form ? back(request, `/reviews/write?t=${encodeURIComponent(token)}&err=server`) : NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
});
