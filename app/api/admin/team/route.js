import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { platformDb, platformConfigured } from "@/lib/platform/control";
import { createInvite, setMemberRole, removeMembership, expirePendingInvites, revokeInvite, transferOwnership } from "@/lib/platform/identity";
import { sendPlatformMail } from "@/lib/platform/platform-mail";
import { mailConfigured } from "@/lib/mail";
import { storeOrigin } from "@/lib/platform/onboarding-ops";
import { currentTenant } from "@/lib/tenant-context";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { roleAllows } from "@/lib/platform/authz";
import { teamView } from "@/lib/admin/team";

// Team & permissions API (S43 / MC23) over the S26/S27 identity primitives.
//   GET  → members (email, name, role) + pending invites
//   POST {action:"invite", email, role} → invitation link (shown once)
//   POST {action:"role", userId, role}  → change role
//   POST {action:"remove", userId}      → remove membership
//   POST {action:"revoke-invite", inviteId}       → expire a pending invite (line 8)
//   POST {action:"transfer", userId, confirm}     → hand ownership over (line 8)
// team.manage guards the surface; granting OWNER, or changing or removing an
// existing owner, revoking an owner invite and transfer additionally need
// team.owner. Final-owner protection is enforced in the identity layer, in the
// statement that writes (Phase 2 line 8). A role change, a removal and a
// transfer expire the member's pending invites (Phase 1 audit, P1-A).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES = ["owner", "admin", "staff", "support"];

const view = teamView; // lib/admin/team.js, shared with the team page

const LAST_OWNER_WORDS = "A store needs at least one owner, so the last owner can't be changed or removed. Make someone else an owner first.";
const NOT_MEMBER_WORDS = "That person isn't on this store's team any more. Reload the page to see the team as it is now.";
const fail = (error, status) => NextResponse.json({ error }, { status });
const ALREADY_MEMBER_WORDS = "That person is already on this store's team with this role or a higher one. To change their role, use Change role on the team list.";

// The invite email, only when mail is set up (lib/mail.js). The link is in
// the answer either way; a failed send never undoes the invite.
//   -> { status: "sent" | "failed" | "mock" | "not-configured" }
async function mailInvite({ tenant, email, role, token, request }) {
  if (!mailConfigured()) return { status: "not-configured" };
  const base = storeOrigin(tenant, request.headers.get("origin") || request.nextUrl?.origin || null);
  if (!base) return { status: "failed" };
  try {
    const sent = await sendPlatformMail({
      kind: "team_invite",
      to: email,
      ref: `tenant:${tenant.id}`,
      subject: `You're invited to ${tenant.name || "a store"} on Storeasy`,
      text: `You've been invited to join ${tenant.name || "a store"}'s console on Storeasy as ${role}.\n\nAccept here. If you're new to Storeasy you'll choose a password; if you already have an account, sign in with your current one. The link works once, for 7 days:\n${base}/admin/accept-invite?token=${token}\n\nIf you didn't expect this, ignore this email.`,
    });
    slog(sent.status === "failed" ? "team_invite_mail_failed" : "team_invite_mailed", { email, status: sent.status });
    return { status: sent.status };
  } catch (e) {
    slog("team_invite_mail_failed", { email, error: String(e?.message || e).slice(0, 200) });
    return { status: "failed" };
  }
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "team.manage");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default" || !platformConfigured()) {
    return NextResponse.json({ ok: true, supported: false, reason: "Team accounts need the platform control plane." });
  }
  return NextResponse.json({ ok: true, supported: true, ...(await view(tenant.id, auth.actor)) });
});

export const POST = tenantHandler(async (request) => {
  // a JSON null body reads as {} (400 below), never a TypeError
  const body = (await request.json().catch(() => null)) ?? {};
  // owner-role grants are owner-only; everything else is team.manage
  const needsOwner = body.role === "owner" || body.action === "transfer";
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
    // the early check below is for the answer and the audit label; the write
    // itself refuses an owner target for a non-owner in the same statement
    // (ownerTargets), so a promotion at the same moment can't slip through
    const canOwner = roleAllows(auth.actor.role, "team.owner");
    const userId = String(body.userId || "");
    if (body.action === "role" || body.action === "remove") {
      const target = await platformDb().execute({ sql: "SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?", args: [userId, tenant.id] });
      // Phase 2 line 8: only a member of this store can be changed or removed
      if (!target.rows[0]) return fail(NOT_MEMBER_WORDS, 404);
      targetWasOwner = target.rows[0].role === "owner";
      if (targetWasOwner && !roleAllows(auth.actor.role, "team.owner")) return fail("Only an owner can change or remove an owner.", 403);
    }
    // Phase 2 line 8: revoking an owner invite is owner-only, like sending one.
    // Read the invite in any state, so the answer to a non-owner is the same
    // 403 whether or not it is still pending.
    let revoking = null;
    if (body.action === "revoke-invite") {
      const r = await platformDb().execute({ sql: "SELECT id, email, role FROM invitations WHERE id = ? AND tenant_id = ? AND kind = 'invite'", args: [String(body.inviteId || ""), tenant.id] });
      revoking = r.rows[0] ? { ...r.rows[0] } : null;
      if (!revoking) return fail("That invite isn't pending any more. Reload the page to see the invites as they are now.", 404);
      if (revoking.role === "owner" && !roleAllows(auth.actor.role, "team.owner")) return fail("Only an owner can revoke an owner invite.", 403);
    }
    const auditAction = targetWasOwner || needsOwner || revoking?.role === "owner" ? "team.owner" : "team.manage";
    if (body.action === "invite") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("Enter a full email address, like name@example.com.", 422);
      if (!ROLES.includes(body.role)) return fail(`Pick a role: ${ROLES.join(", ")}.`, 422);
      // P2-G: an invite only raises a role (acceptInvite never lowers one), so a
      // member already at or above it is refused before any row or mail
      const existing = await platformDb().execute({ sql: "SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND lower(u.email) = ?", args: [tenant.id, email] });
      const have = existing.rows[0]?.role;
      if (have && ROLES.indexOf(have) <= ROLES.indexOf(body.role)) return NextResponse.json({ error: ALREADY_MEMBER_WORDS, code: "ALREADY_MEMBER" }, { status: 409 });
      const inv = await createInvite({ email, tenantId: tenant.id, role: body.role, invitedBy: auth.actor.id });
      slog("team_invited", { email, role: body.role });
      await audit({ actor: auth.actor, action: auditAction, resource: `invite:${email}`, diff: { role: body.role } });
      const mail = await mailInvite({ tenant, email, role: body.role, token: inv.token, request });
      return NextResponse.json({
        ok: true,
        // shown ONCE — the token is hashed at rest
        inviteUrl: `/admin/accept-invite?token=${inv.token}`,
        expiresAt: inv.expiresAt,
        mail,
        ...(await view(tenant.id, auth.actor)),
      });
    }
    if (body.action === "revoke-invite") {
      const gone = await revokeInvite(revoking.id, tenant.id);
      if (!gone) return fail("That invite isn't pending any more. Reload the page to see the invites as they are now.", 404);
      slog("team_invite_revoked", { invite: gone.id, role: gone.role });
      await audit({ actor: auth.actor, action: auditAction, resource: `invite-revoked:${gone.id}`, diff: { email: gone.email, role: gone.role } });
      return NextResponse.json({ ok: true, ...(await view(tenant.id, auth.actor)) });
    }
    if (body.action === "role") {
      if (!ROLES.includes(body.role)) return fail(`Pick a role: ${ROLES.join(", ")}.`, 422);
      // final-owner and owner-target guards inside the one UPDATE; never adds a member
      const set = await setMemberRole(userId, tenant.id, body.role, { ownerTargets: canOwner });
      if (!set) return fail(NOT_MEMBER_WORDS, 404);
      await expirePendingInvites(userId, tenant.id); // Phase 1 audit (P1-A)
      slog("team_role_set", { user: userId, role: body.role });
      await audit({ actor: auth.actor, action: auditAction, resource: `member:${userId}`, diff: { role: body.role, targetWasOwner } });
      return NextResponse.json({ ok: true, ...(await view(tenant.id, auth.actor)) });
    }
    if (body.action === "remove") {
      if (userId === auth.actor.id) return fail("You can't remove yourself. Ask another admin or the owner to do it.", 422);
      if (!(await removeMembership(userId, tenant.id, { ownerTargets: canOwner }))) return fail(NOT_MEMBER_WORDS, 404); // both guards inside the DELETE
      await expirePendingInvites(userId, tenant.id); // Phase 1 audit (P1-A)
      slog("team_removed", { user: userId });
      await audit({ actor: auth.actor, action: auditAction, resource: `member:${userId}`, diff: { removed: true, targetWasOwner } });
      return NextResponse.json({ ok: true, ...(await view(tenant.id, auth.actor)) });
    }
    if (body.action === "transfer") {
      // Phase 2 line 8: owner only (requireAdmin above asked for team.owner)
      if (userId === auth.actor.id) return fail("You already own this store. Pick another member.", 422);
      const target = await platformDb().execute({ sql: "SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?", args: [userId, tenant.id] });
      if (!target.rows[0]) return fail(NOT_MEMBER_WORDS, 404);
      const norm = (v) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
      const storeName = tenant.name || tenant.id; // never "null" in the words
      if (!norm(body.confirm) || norm(body.confirm) !== norm(storeName)) return fail(`Type the store name, ${storeName}, to confirm.`, 422);
      // both people's pending invites expire in the same batch (Phase 1 audit, P1-A)
      if (!(await transferOwnership(auth.actor.id, userId, tenant.id))) return fail("Ownership didn't move: you're no longer an owner here, or that member left. Reload the page.", 409);
      slog("team_ownership_transferred", { from: auth.actor.id, to: userId });
      await audit({ actor: auth.actor, action: "team.owner", resource: `ownership:${auth.actor.id}→${userId}`, diff: { from: auth.actor.id, to: userId, fromRole: "admin" } });
      return NextResponse.json({ ok: true, ...(await view(tenant.id, auth.actor)) });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    if (e?.code === "OWNER_TARGET") return fail("Only an owner can change or remove an owner.", 403);
    const infra = infraResponse(e, { route: "admin/team" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    if (/last owner/.test(String(e?.message))) return fail(LAST_OWNER_WORDS, 422);
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
