import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/origin-check";
import { rateLimitAsync, clientIp } from "@/lib/rate-limit";
import { signupClosedAnswer, slugAvailable, slugFor, startSignup, storeHostFor, SLUG_WORDS, SIGNUP_COOKIE, SIGNUP_COOKIE_OPTS } from "@/lib/platform/signup";

// Self-serve signup (Phase 1 line 1). Marketing host only; a store host gets 404.
//   GET  ?slug=<address> or ?storeName=<name>  -> { slug, available, reason?, message?, address }
//   POST { name, email, password, storeName, slug? } -> { ok, signup } and the se_signup cookie;
//        422 { error, errors: { field: words } }; 429 when limited
// An email that already has an account gets the same 200 and the same keys.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const answer = (a) => NextResponse.json(a.body, { status: a.status });

export async function GET(request) {
  const closed = await signupClosedAnswer(request.headers.get("host"));
  if (closed) return answer(closed);
  const limited = await rateLimitAsync(request, { name: "signup-check", limit: 60 });
  if (limited) return limited;
  const q = new URL(request.url).searchParams;
  const slug = String(q.get("slug") || "").trim().toLowerCase() || slugFor(q.get("storeName") || "");
  const r = await slugAvailable(slug);
  return NextResponse.json({ slug, available: r.ok, ...(r.ok ? {} : { reason: r.reason, message: SLUG_WORDS[r.reason] }), address: slug ? storeHostFor(slug) : null });
}

export async function POST(request) {
  const closed = await signupClosedAnswer(request.headers.get("host"));
  if (closed) return answer(closed);
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  const limited = await rateLimitAsync(request, { name: "signup", limit: 5, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const r = await startSignup({ input: body && typeof body === "object" ? body : {}, ip: clientIp(request) });
  if (r.limited) return NextResponse.json({ error: "Too many signups from here. Try again in an hour." }, { status: 429 });
  if (r.errors) return NextResponse.json({ error: "Check the highlighted fields.", errors: r.errors }, { status: 422 });
  const res = NextResponse.json({ ok: true, signup: r.signup });
  res.cookies.set(SIGNUP_COOKIE, r.browserToken, { ...SIGNUP_COOKIE_OPTS });
  return res;
}
