import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listAudit, auditFacets, auditChanges } from "@/lib/platform/audit";
import { currentTenant, tenantId } from "@/lib/tenant-context";
import { platformConfigured } from "@/lib/platform/control";
import { tenantHandler } from "@/lib/tenant-request";
import { getUser } from "@/lib/platform/identity";

// Tenant audit trail, read-only (S27 / BE16). Scoped to the HOST-RESOLVED
// tenant — a console can never read another store's rows. Owner/admin only
// (action audit.read). The UI is Settings → Audit log (Phase 2 line 7):
//   ?limit, ?before (the previous page's `next`), and the filters ?actor
//   (an actor id), ?action, ?since / ?until (ISO times); ?facets=1 adds the
//   filter choices. Each entry also carries `changes`: its diff as short
//   lines, redacted again on the way out (never a secret value).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;

// Who, in words: a member by their email (this store's audit.read callers see
// the team anyway), Storeasy's team for operators, Storeasy for the system.
async function whoLabels(list) {
  const out = new Map();
  for (const { actor, kind } of list) {
    if (out.has(actor)) continue;
    let label = kind === "operator" ? "Storeasy's team" : kind === "merchant" ? null : kind === "bootstrap" ? "Setup sign-in" : "Storeasy";
    if (kind === "merchant") label = (await getUser(actor).catch(() => null))?.email || "A former team member";
    out.set(actor, label);
  }
  return out;
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "audit.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!(platformConfigured() && currentTenant())) {
    return NextResponse.json({ ok: true, entries: [], note: "audit log needs the platform control plane" });
  }
  const p = request.nextUrl.searchParams;
  const time = (k) => (ISO.test(p.get(k) || "") ? p.get(k) : null);
  const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), 200);
  const rows = await listAudit({
    tenantId: tenantId(),
    limit,
    before: p.get("before"),
    actor: p.get("actor") || null,
    action: p.get("action") || null,
    since: time("since"),
    until: time("until"),
  });
  const facets = p.get("facets") === "1" ? await auditFacets({ tenantId: tenantId() }) : null;
  const labels = await whoLabels([...rows.map((r) => ({ actor: r.actor, kind: r.actor_kind })), ...(facets?.actors || []).map((a) => ({ actor: a.actor, kind: a.kind }))]);
  const entries = rows.map((r) => ({ ...r, who: labels.get(r.actor), changes: auditChanges(r.diff) }));
  const last = entries.at(-1);
  return NextResponse.json({
    ok: true,
    entries,
    next: entries.length === limit && last ? `${last.at}|${last.id}` : null,
    ...(facets ? { facets: { actions: facets.actions, actors: facets.actors.map((a) => ({ ...a, label: labels.get(a.actor) })) } } : {}),
  });
});
