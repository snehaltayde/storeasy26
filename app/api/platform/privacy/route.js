import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { forEachActiveTenant, runAsTenant } from "@/lib/platform/ops";
import { listPrivacyRequests, redactCustomer } from "@/lib/privacy";
import { db } from "@/lib/db";
import { audit, operatorActor } from "@/lib/platform/audit";
import { listTenants, platformConfigured } from "@/lib/platform/control.js";
import { slog } from "@/lib/log";

// Operator privacy ops (S43 / OP11): the fleet's privacy requests in one
// queue + manual execution of a pending/manual redaction (audited). The
// automated path stays the S33 webhook flow — this is the backstop for
// "manual" rows and direct merchant asks.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Phase 3 line 6: a request goes out through requestView, an allowlist with
// no shopper email, phone or customer id (the operator acts on the request, not
// the person); an unreachable store shows a fixed sentence, never the driver's
// error (it can name the database). Each row carries its store's name for the
// typed-name confirmation.
const requestView = (tenant, storeName, r) => ({
  tenant,
  storeName,
  id: r.id,
  kind: r.kind,
  status: r.status,
  notes: r.notes || null,
  created_at: r.created_at || null,
  completed_at: r.completed_at || null,
});

async function storeNames() {
  if (!platformConfigured()) return {};
  try {
    return Object.fromEntries((await listTenants()).map((t) => [t.id, t.name || t.id]));
  } catch {
    return {};
  }
}

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const [results, names] = await Promise.all([forEachActiveTenant(async () => listPrivacyRequests({ limit: 30 })), storeNames()]);
  const requests = [];
  for (const r of results) {
    if (!r.ok) {
      requests.push({ tenant: r.tenant, storeName: names[r.tenant] || r.tenant, unreachable: true, error: "We couldn't read this store's privacy requests just now." });
      continue;
    }
    for (const row of r.result) requests.push(requestView(r.tenant, names[r.tenant] || r.tenant, row));
  }
  requests.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return NextResponse.json({ ok: true, requests });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  if (body.action !== "redact") return NextResponse.json({ error: "action must be redact" }, { status: 400 });
  // an empty store would run against the default database (runAsTenant)
  const tenant = String(body.tenant || "");
  if (!tenant) return NextResponse.json({ error: "Name the store the request belongs to." }, { status: 400 });
  try {
    const result = await runAsTenant(tenant, async () => {
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
    slog("privacy_redact_operator", { tenant, request: body.requestId });
    if (!result?.already) await audit({ actor: operatorActor(auth.operator), action: "privacy.redact", resource: `privacy:${String(body.requestId)}`, tenantId: tenant, diff: { orders: result?.orders ?? 0, events: result?.events ?? 0 } });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
