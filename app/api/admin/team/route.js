import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { platformDb, platformConfigured } from "@/lib/platform/control";
import { createInvite, addMembership, removeMembership } from "@/lib/platform/identity";
import { currentTenant } from "@/lib/tenant-context";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { roleAllows } from "@/lib/platform/authz";

// Team & permissions API (S43 / MC23) over the S26/S27 identity primitives.
//   GET  → members (email, name, role) + pending invites
//   POST {action:"invite", email, role} → invitation link (shown once)
//   POST {action:"role", userId, role}  → change role
//   POST {action:"remove", userId}      → remove membership
// team.manage guards the surface; granting OWNER, or changing or removing an
// existing owner, additionally needs team.owner. Final-owner protection is
// enforced in the identity layer.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES = ["owner", "admin", "staff", "support"];

async function view(tenantId) {
  const members = (
    await platformDb().execute({
      sql: `SELECT u.id, u.email, u.name, u.status, m.role, m.created_at
            FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'staff' THEN 2 ELSE 3 END, u.email`,
      args: [tenantId],
    })
  ).rows.map((r) => ({ ...r }));
  const invites = (
    await platformDb().execute({
      sql: `SELECT id, email, role, created_at, expires_at FROM invitations
            WHERE tenant_id = ? AND kind = 'invite' AND accepted_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC`,
      args: [tenantId, new Date().toISOString()],
    })
  ).rows.map((r) => ({ ...r }));
  return { members, invites };
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "team.manage");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default" || !platformConfigured()) {
    return NextResponse.json({ ok: true, supported: false, reason: "Team accounts need the platform control plane." });
  }
  return NextResponse.json({ ok: true, supported: true, ...(await view(tenant.id)) });
});

export const POST = tenantHandler(async (request) => {
  // a JSON null body reads as {} (400 below), never a TypeError
  const body = (await request.json().catch(() => null)) ?? {};
  // owner-role grants are owner-only; everything else is team.manage
  const needsOwner = body.role === "owner";
  const auth = await requireAdmin(request, needsOwner ? "team.owner" : "team.manage");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default" || !platformConfigured()) {
    return NextResponse.json({ error: "Team accounts need the platform control plane" }, { status: 503 });
  }
  try {
    // Phase 0 (F1): changing or removing an OWNER is owner-only too; team.manage
    // alone could demote or remove any owner but the last one. Read directly
    // (not membershipRole, which reads a failure as "no role"): a failed lookup
    // is a 5xx below, never a pass. Owner changes are audited as team.owner.
    let targetWasOwner = false;
    if (body.action === "role" || body.action === "remove") {
      const target = await platformDb().execute({ sql: "SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?", args: [String(body.userId || ""), tenant.id] });
      targetWasOwner = target.rows[0]?.role === "owner";
      if (targetWasOwner && !roleAllows(auth.actor.role, "team.owner")) return NextResponse.json({ error: `Your role (${auth.actor.role}) can't change an owner` }, { status: 403 });
    }
    const auditAction = targetWasOwner || needsOwner ? "team.owner" : "team.manage";
    if (body.action === "invite") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return NextResponse.json({ error: "valid email required" }, { status: 422 });
      if (!ROLES.includes(body.role)) return NextResponse.json({ error: `role must be one of ${ROLES.join(", ")}` }, { status: 422 });
      const inv = await createInvite({ email, tenantId: tenant.id, role: body.role, invitedBy: auth.actor.id });
      slog("team_invited", { email, role: body.role });
      await audit({ actor: auth.actor, action: auditAction, resource: `invite:${email}`, diff: { role: body.role } });
      return NextResponse.json({
        ok: true,
        // shown ONCE — the token is hashed at rest
        inviteUrl: `/admin/accept-invite?token=${inv.token}`,
        expiresAt: inv.expiresAt,
        ...(await view(tenant.id)),
      });
    }
    if (body.action === "role") {
      if (!ROLES.includes(body.role)) return NextResponse.json({ error: `role must be one of ${ROLES.join(", ")}` }, { status: 422 });
      await addMembership(String(body.userId || ""), tenant.id, body.role); // final-owner guard inside
      slog("team_role_set", { user: body.userId, role: body.role });
      await audit({ actor: auth.actor, action: auditAction, resource: `member:${body.userId}`, diff: { role: body.role, targetWasOwner } });
      return NextResponse.json({ ok: true, ...(await view(tenant.id)) });
    }
    if (body.action === "remove") {
      await removeMembership(String(body.userId || ""), tenant.id); // final-owner guard inside
      slog("team_removed", { user: body.userId });
      await audit({ actor: auth.actor, action: auditAction, resource: `member:${body.userId}`, diff: { removed: true, targetWasOwner } });
      return NextResponse.json({ ok: true, ...(await view(tenant.id)) });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/team" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
