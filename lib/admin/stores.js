// The stores a signed-in member can switch to (S41 / MC03; moved here from
// app/api/admin/stores/route.js in Phase 0 line 8 so the console layout and the
// route share it). Control-plane rows only, never a client-supplied list:
// the caller's OWN memberships in ACTIVE stores, each linking to that store's
// console on its own host (sessions are tenant-bound: the switcher navigates,
// it never shares cookies across stores). A bootstrap (shared password) or an
// operator-support session has no memberships of its own: [].
//   → [{ id, name, role, url, current }]
import { platformDb, platformConfigured } from "../platform/control.js";
import { currentTenant } from "../tenant-context.js";

// domains[0] → that store's console. A local host keeps the port its own
// site_url names (the local harnesses serve every store on one port).
export const consoleUrl = (domain, siteUrl = null) => {
  if (!domain) return null;
  const local = /localhost|127\.0\.0\.1/.test(domain);
  let port = "";
  if (local && siteUrl) {
    try {
      const u = new URL(siteUrl);
      if (u.hostname === domain && u.port) port = `:${u.port}`;
    } catch {
      /* no usable site_url */
    }
  }
  return `${local ? "http" : "https"}://${domain}${port}/admin`;
};

export async function listMyStores(actor) {
  if (!platformConfigured() || actor?.kind !== "merchant" || !actor.id) return [];
  const here = currentTenant();
  const r = await platformDb().execute({
    sql: `SELECT m.tenant_id, m.role, t.name, t.domains, t.status, t.config
          FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = ? ORDER BY t.name`,
    args: [actor.id],
  });
  return r.rows
    .filter((row) => row.status === "active")
    .map((row) => {
      const json = (text, empty) => {
        try {
          return JSON.parse(text || empty);
        } catch {
          return JSON.parse(empty); // a malformed row
        }
      };
      const domains = json(row.domains, "[]");
      const siteUrl = json(row.config, "{}")?.site_url || null;
      return { id: row.tenant_id, name: row.name, role: row.role, url: consoleUrl(domains[0], siteUrl), current: row.tenant_id === here?.id };
    })
    .filter((s) => s.url);
}
