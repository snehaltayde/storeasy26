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
//            reading orders. No settings, no Shopify pushes, no sync, no
//            team — and since S55, NO PUBLISHING (edit ≠ publish: staff
//            drafts, admin+ flips live/rolls back — the audit's basic
//            author/publisher separation).
//   admin    everything operational + settings/secrets + team management.
//   owner    admin + owner-only team actions (granting/transferring owner).

const SUPPORT = ["offers.read", "orders.read", "storefront.read", "upsells.read", "apps.read"];
const STAFF = [...SUPPORT, "offers.write", "storefront.write", "upsells.write", "returns.decide"];
const ADMIN = [...STAFF, "orders.push", "orders.cancel", "storefront.publish", "sync.run", "settings.read", "settings.write", "audit.read", "team.manage", "apps.manage"];
const OWNER = [...ADMIN, "team.owner"];

const PERMS = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  staff: new Set(STAFF),
  support: new Set(SUPPORT),
};

export const ROLES = Object.keys(PERMS);

// Every action string any role holds (owner holds them all). The permission
// suite (scripts/test-permissions.js) checks each route-table row against it.
export const ACTIONS = Object.freeze([...OWNER]);

export const roleAllows = (role, action) => PERMS[role]?.has(action) ?? false;

// Reads never mutate; everything else gets the CSRF origin check too.
export const isWriteAction = (action) => !String(action).endsWith(".read");

// Phase 4: what a plugin may be granted, in the project's <area>.<verb> names,
// with the words the install dialog shows. Read-only in v1. Owner decision
// (Phase 4): no scope reaches customer contact details.
export const APP_PERMISSIONS = Object.freeze({
  "storefront.read": "See your live store content, products and collections",
  "offers.read": "See your offers and bundles",
  "orders.read": "See your orders, without customer details",
});

export const scopeAllows = (scopes, action) => Array.isArray(scopes) && scopes.includes(action);
