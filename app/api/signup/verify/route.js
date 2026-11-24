import { NextResponse, after } from "next/server";
import { sameOrigin, requestOrigin } from "@/lib/origin-check";
import { rateLimitAsync, clientIp } from "@/lib/rate-limit";
import { signupClosedAnswer, verifySignup, retrySignup, SIGNUP_COOKIE } from "@/lib/platform/signup";
import { runJobById } from "@/lib/platform/worker";

// Verify the email code (Phase 1 line 1), then queue the store's setup (line 2).
// Marketing host only; acts only on the signup bound to this browser's
// se_signup cookie.
//   POST { code }        -> 200 { ok, status: "provisioning" } (the provision_store
//                           job runs in after(); the page polls /api/signup/status)
//                           | 400 { error } (every bad code: the same words)
//   POST { retry: true } -> 200 { ok, status: "provisioning" }, the same job and
//                           run made due | 200 { ok, status: "done", loginUrl }
//                           | 400 { error } (no signup here, or lapsed: start again)
//   503 { error } when no store database can be made (production without the Turso API)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// the job's share of this route's 60 s
const JOB_BUDGET_MS = 50_000;

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
  if (r.error && !r.ok) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
  const { jobId, ...answer } = r;
  if (jobId) after(() => runJobById(jobId, { budgetMs: JOB_BUDGET_MS }));
  return NextResponse.json(answer);
}
