import { NextResponse, after } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { requestOrigin } from "@/lib/origin-check";
import { checkOperatorStore, createOperatorStore, operatorStoreStatus } from "@/lib/platform/operator-stores";
import { runJobById } from "@/lib/platform/worker";

// Phase 1 line 9: an operator creates a store for a founder.
//   GET  ?check=1&slug=&shop=&email=  -> the form's live checks
//   GET  ?signup=sgn_…                -> progress, then the done screen's facts
//   POST { storeName, email, founderName, shop, slug, clientId, clientSecret }
//        -> { ok, signup } (the provision_store job runs in after())
// Operators only (requireOperator); the POST is audited with the operator's
// id. No answer carries a token, an invite link or the app's secret.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const { operator } = auth;
  const sp = request.nextUrl.searchParams;
  try {
    if (sp.get("signup")) {
      const r = await operatorStoreStatus(sp.get("signup"), { origin: requestOrigin(request) });
      return r.error ? json({ error: r.error }, r.status) : json(r);
    }
    if (sp.get("check")) return json({ ok: true, ...(await checkOperatorStore({ slug: sp.get("slug"), shop: sp.get("shop"), email: sp.get("email") })) });
    return json({ error: "Ask for a check or a store setup." }, 400);
  } catch {
    return json({ error: "We couldn't check that just now. Try again." }, 500);
  }
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const { operator } = auth;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Fill in the form, then press Create store." }, 400);
  let r;
  try {
    r = await createOperatorStore({ input: body, operator, origin: requestOrigin(request) });
  } catch {
    return json({ error: "That didn't work, and no store was created. Try again." }, 500);
  }
  if (r.errors) return json({ errors: r.errors }, r.status || 400);
  if (r.error) return json({ error: r.error }, r.status || 409);
  if (r.jobId) after(() => runJobById(r.jobId, { budgetMs: 50_000 }));
  return json({ ok: true, signup: r.signup });
}
