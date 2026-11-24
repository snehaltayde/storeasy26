import { NextResponse, after } from "next/server";
import { platformOperator, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin, requestOrigin } from "@/lib/origin-check";
import { listOnboarding, onboardingSubject, ACTIONS } from "@/lib/platform/onboarding-ops";
import { runJobById } from "@/lib/platform/worker";

// Phase 1 line 8: the operator's "Signups & onboarding" screen.
//   GET  ?view=&stuck=&q=&sort=&cursor=   -> { rows, next, counts, params }
//   GET  ?subject=signup:<id>|tenant:<id> -> the detail sheet
//   POST { action, subject, ... }          -> one help action (lib/platform/onboarding-ops.js ACTIONS)
// Operators only (platformOperator: a TOTP operator session, or the bootstrap
// token while no operator exists); every write is audited with the operator's
// id. No answer carries a token or a link.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unauthorized = () => json({ error: "Unauthorized" }, 401);

export async function GET(request) {
  const operator = await platformOperator(request.cookies.get(PLATFORM_COOKIE)?.value);
  if (!operator) return unauthorized();
  const sp = request.nextUrl.searchParams;
  try {
    if (sp.get("subject")) {
      const r = await onboardingSubject(sp.get("subject"));
      return r.error ? json({ error: r.error }, r.status) : json(r);
    }
    const r = await listOnboarding({ view: sp.get("view"), stuck: sp.get("stuck"), q: sp.get("q"), sort: sp.get("sort"), cursor: sp.get("cursor") });
    return json({ ok: true, ...r });
  } catch {
    return json({ error: "We couldn't load signups and stores just now. Try again." }, 500);
  }
}

export async function POST(request) {
  if (!sameOrigin(request)) return json({ error: "Cross-origin request rejected" }, 403);
  const operator = await platformOperator(request.cookies.get(PLATFORM_COOKIE)?.value);
  if (!operator) return unauthorized();
  const body = await request.json().catch(() => ({}));
  const fn = Object.hasOwn(ACTIONS, String(body?.action)) ? ACTIONS[body.action] : null;
  if (!fn) return json({ error: "Unknown action. Reload the page and try again." }, 400);
  const opts = {
    origin: requestOrigin(request),
    email: typeof body.email === "string" ? body.email : undefined,
    reason: body.reason,
    hours: body.hours,
    grant: body.grant,
    notify: body.notify === true,
    text: body.text,
  };
  let r;
  try {
    r = await fn(String(body.subject || ""), opts, operator);
  } catch {
    return json({ error: "That didn't work. Nothing was changed that we know of. Reload the sheet and try again." }, 500);
  }
  if (r.error) return json({ error: r.error, ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}) }, r.status || 409);
  const { jobId, ...rest } = r;
  if (jobId) after(() => runJobById(jobId, { budgetMs: 50_000 }));
  return json(rest);
}
