import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { forEachActiveTenant, runAsTenant } from "@/lib/platform/ops";
import { listPrivacyRequests, redactCustomer } from "@/lib/privacy";
import { db } from "@/lib/db";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";

// Operator privacy ops (S43 / OP11): the fleet's privacy requests in one
// queue + manual execution of a pending/manual redaction (audited). The
// automated path stays the S33 webhook flow — this is the backstop for
// "manual" rows and direct merchant asks.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const results = await forEachActiveTenant(async () => listPrivacyRequests({ limit: 30 }));
  const requests = [];
  for (const r of results) {
    if (!r.ok) {
      requests.push({ tenant: r.tenant, unreachable: true, error: r.error });
      continue;
    }
    for (const row of r.result) requests.push({ tenant: r.tenant, ...row });
  }
  requests.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return NextResponse.json({ ok: true, requests });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  if (body.action !== "redact") return NextResponse.json({ error: "action must be redact" }, { status: 400 });
  try {
    const result = await runAsTenant(String(body.tenant || ""), async () => {
      const req = await db.selectFrom("privacy_requests").selectAll().where("id", "=", String(body.requestId || "")).executeTakeFirst();
      if (!req) throw new Error("request not found");
      if (req.status === "done") return { already: true };
      const r = await redactCustomer({ email: req.email, phone: req.phone });
      await db
        .updateTable("privacy_requests")
        .set({ status: "done", completed_at: new Date().toISOString(), notes: `operator-executed: ${r.orders} orders, ${r.events} events redacted` })
        .where("id", "=", req.id)
        .execute();
      return r;
    });
    slog("privacy_redact_operator", { tenant: body.tenant, request: body.requestId });
    await audit({ actor: auth.operator, action: "tenant.status", tenantId: body.tenant, diff: { privacy_redact: body.requestId } });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
