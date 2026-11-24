import { NextResponse } from "next/server";
import { sameOrigin, requestOrigin } from "@/lib/origin-check";
import { rateLimitAsync, clientIp } from "@/lib/rate-limit";
import { signupClosedAnswer, verifySignup, retrySignup, SIGNUP_COOKIE } from "@/lib/platform/signup";

// Verify the email code, then create the store (Phase 1 line 1). Marketing
// host only; acts only on the signup bound to this browser's se_signup cookie.
//   POST { code }        -> 200 { ok, status: "done", redirect } (redirect: the
//                           store's /admin/handoff#t=<token>)
//                           | 200 { ok: false, status: "failed", error, canRetry }
//                           | 400 { error } (every bad code: the same words)
//   POST { retry: true } -> the same answers, resuming the same provision run
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const closed = await signupClosedAnswer(request.headers.get("host"));
  if (closed) return NextResponse.json(closed.body, { status: closed.status });
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  const limited = await rateLimitAsync(request, { name: "signup-verify", limit: 20, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  const browserToken = request.cookies.get(SIGNUP_COOKIE)?.value || null;
  const origin = requestOrigin(request);
  const r = body?.retry === true ? await retrySignup({ browserToken, origin }) : await verifySignup({ browserToken, code: body?.code, ip: clientIp(request), origin });
  if (r.error && r.status !== "failed" && r.status !== "provisioning") return NextResponse.json({ error: r.error }, { status: r.status || 400 });
  return NextResponse.json(r);
}
