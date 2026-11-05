import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { startPolicyPage, markPolicyRead } from "@/lib/first-run/policy-start";
import { tenantHandler } from "@/lib/tenant-request";

// P6-POLICY-START (PUB-12, GEN-06 partly): the policy starters, for the
// "Before you open your store" panel and the onboarding checklist.
//   POST { kind: "privacy" | "returns" }       start a draft page from a template
//   POST { markRead: { id, revision } }        "I've read it": the founder takes
//                                              the starter's text as their own
// Anything else is a 400. storefront.write. Never publishes, never writes to
// Shopify. The work and its refusals are in lib/first-run/policy-start.js.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BAD_REQUEST = "We couldn't tell what to do. Choose 'Start a privacy page', 'Start a returns page' or 'I've read it', then try again.";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Exactly one action per request.
function parse(body) {
  if (!isObj(body)) return null;
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "kind" && typeof body.kind === "string") return { kind: "start", policy: body.kind };
  if (keys.length === 1 && keys[0] === "markRead" && isObj(body.markRead)) {
    const { id, revision } = body.markRead;
    if (typeof id === "string" && id && Number.isInteger(revision) && Object.keys(body.markRead).every((k) => k === "id" || k === "revision")) return { kind: "markRead", id, revision };
  }
  return null;
}

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => undefined);
  const op = parse(body);
  if (!op) return NextResponse.json({ error: BAD_REQUEST, code: "BAD_REQUEST" }, { status: 400 });
  try {
    const r = op.kind === "start" ? await startPolicyPage({ kind: op.policy, actor: auth.actor }) : await markPolicyRead({ id: op.id, revision: op.revision, actor: auth.actor });
    if (r.status === 200) {
      const id = r.body.document?.id;
      slog("policy_start", { op: op.kind, kind: op.kind === "start" ? op.policy : null, document: id });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `document:${id}`, diff: { op: op.kind === "start" ? "policyStart" : "policyMarkRead", kind: op.kind === "start" ? op.policy : null } }); // best-effort, never throws
    }
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    if (e?.code === "CMS_MODE_UNAVAILABLE") return NextResponse.json({ error: "We couldn't check which editor this store uses, so nothing changed. Try again in a minute.", code: "CMS_MODE_UNAVAILABLE" }, { status: 503 });
    const infra = infraResponse(e, { route: "admin/policy-start" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: "We couldn't start that page. Try again in a minute.", code: "INTERNAL" }, { status: 500 });
  }
});
