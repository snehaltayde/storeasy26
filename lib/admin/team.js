// The team view (Phase 2 line 8): this store's members, owners first, and its
// pending invites (never a token: only the hash is stored). Shared by
// GET /api/admin/team and the team page; the caller checks team.manage first.
//   teamView(tenantId, actor) -> { members, invites, you: { id, role } | null }
import { platformDb } from "../platform/control.js";

export async function teamView(tenantId, actor = null) {
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
  // the caller's own row as it is now (after a transfer it says admin)
  const you = actor ? { id: actor.id, role: members.find((m) => m.id === actor.id)?.role ?? actor.role } : null;
  return { members, invites, you };
}
