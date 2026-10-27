// Change or remove a user's membership on a tenant (Session 27 / BE03).
//   pnpm member:set -- --tenant beastlife --email teammate@x.com --role staff
//   pnpm member:set -- --tenant beastlife --email teammate@x.com --remove
// Final-owner protection: the last owner can be neither demoted nor removed.
// Takes effect immediately — authorization is a fresh membership lookup per
// request, so even already-open tabs lose access on their next call.
import { getTenant } from "../lib/platform/control.js";
import { findUserByEmail, addMembership, removeMembership } from "../lib/platform/identity.js";
import { audit } from "../lib/platform/audit.js";

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const tenantSlug = flag("tenant");
const email = flag("email");
const role = flag("role");
const remove = process.argv.includes("--remove");

if (!tenantSlug || !email || (!role && !remove)) {
  console.error("Usage: pnpm member:set -- --tenant <slug> --email <email> (--role owner|admin|staff|support | --remove)");
  process.exit(1);
}

const tenant = await getTenant(tenantSlug);
if (!tenant) {
  console.error(`✗ tenant "${tenantSlug}" not found`);
  process.exit(1);
}
const user = await findUserByEmail(email);
if (!user) {
  console.error(`✗ no user with email "${email}" — create one with pnpm user:create or invite:create`);
  process.exit(1);
}

try {
  if (remove) {
    const removed = await removeMembership(user.id, tenant.id);
    if (!removed) {
      console.log(`• ${email} had no membership on ${tenant.id} — nothing to do`);
      process.exit(0);
    }
    await audit({ actor: { kind: "cli", id: "cli" }, action: "team.removed", tenantId: tenant.id, resource: `user:${user.id}` });
    console.log(`✓ removed ${email} from ${tenant.id} (access ends on their next request)`);
  } else {
    await addMembership(user.id, tenant.id, role);
    await audit({ actor: { kind: "cli", id: "cli" }, action: "team.role_set", tenantId: tenant.id, resource: `user:${user.id}`, diff: { role } });
    console.log(`✓ ${email} → ${tenant.id} as ${role}`);
  }
  process.exit(0);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
