import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/origin-check";
import { rateLimitAsync } from "@/lib/rate-limit";
import { signupClosedAnswer, resendCode, SIGNUP_COOKIE } from "@/lib/platform/signup";

// A new email code (Phase 1 line 1): at most once a minute and five times per
// signup, each one a new code. Marketing host only; acts only on the signup
// bound to this browser's se_signup cookie.
//   POST -> { ok, signup } | 400 { error } | 429 { error, retry_after_seconds? }
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const closed = await signupClosedAnswer(request.headers.get("host"));
  if (closed) return NextResponse.json(closed.body, { status: closed.status });
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  const limited = await rateLimitAsync(request, { name: "signup-resend", limit: 10, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;
  const r = await resendCode({ browserToken: request.cookies.get(SIGNUP_COOKIE)?.value || null });
  if (!r.ok) {
    return NextResponse.json({ error: r.error, ...(r.retryAfter ? { retry_after_seconds: r.retryAfter } : {}) }, { status: r.status, headers: r.retryAfter ? { "Retry-After": String(r.retryAfter) } : undefined });
  }
  return NextResponse.json(r);
}
