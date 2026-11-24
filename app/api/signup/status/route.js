import { NextResponse } from "next/server";
import { sameOrigin, requestOrigin } from "@/lib/origin-check";
import { rateLimitAsync } from "@/lib/rate-limit";
import { signupClosedAnswer, signupStatus, SIGNUP_COOKIE } from "@/lib/platform/signup";

// Where the founder's store setup stands (Phase 1 line 2). Marketing host only;
// answers only for the signup bound to this browser's se_signup cookie. The
// waiting page polls it; when the signup's job is due it runs here.
//   POST {} -> 200 { ok, status: "code" }                          (code not yet entered)
//            | 200 { ok, status: "provisioning", steps, note? }     (note: the retry words)
//            | 200 { ok, status: "failed", steps, error, failureKind, canRetry }
//            | 200 { ok, status: "done", steps, redirect | loginUrl } (neither: poll again)
//            | 400 { error } (no signup in this browser: the same words for every case)
// steps: [{ label, state: waiting | working | done | failed }] in order.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request) {
  const closed = await signupClosedAnswer(request.headers.get("host"));
  if (closed) return NextResponse.json(closed.body, { status: closed.status });
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  const limited = await rateLimitAsync(request, { name: "signup-status", limit: 900, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;
  const r = await signupStatus({ browserToken: request.cookies.get(SIGNUP_COOKIE)?.value || null, origin: requestOrigin(request) });
  if (r.error && !r.ok) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
  return NextResponse.json(r);
}
