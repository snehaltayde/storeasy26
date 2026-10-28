// Role → action permission map (Session 27 / BE03). Pure and plain-Node.
//
// Roles (per membership, stored since S26): owner ⊇ admin ⊇ staff ⊇ support.
// Actions are "<area>.<verb>" strings checked server-side by requireAdmin()
// in lib/admin-auth.js on EVERY admin API route — the tenant is always the
// host-resolved context (lib/tenant-request.js), never a URL/body id, so
// tenant spoofing has nothing to attach to.
//
//   support  read-only: look, never touch.
//   staff    day-to-day merchandising: offers, storefront content, upsells,
//            reading orders. No settings, no Shopify pushes, no sync, no team.
//   admin    everything operational + settings/secrets + team management.
//   owner    admin + owner-only team actions (granting/transferring owner).

const SUPPORT = ["offers.read", "orders.read", "storefront.read", "upsells.read"];
const STAFF = [...SUPPORT, "offers.write", "storefront.write", "upsells.write", "returns.decide"];
const ADMIN = [...STAFF, "orders.push", "sync.run", "settings.read", "settings.write", "audit.read", "team.manage"];
const OWNER = [...ADMIN, "team.owner"];

const PERMS = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  staff: new Set(STAFF),
  support: new Set(SUPPORT),
};

export const ROLES = Object.keys(PERMS);

export const roleAllows = (role, action) => PERMS[role]?.has(action) ?? false;

// Reads never mutate; everything else gets the CSRF origin check too.
export const isWriteAction = (action) => !String(action).endsWith(".read");
