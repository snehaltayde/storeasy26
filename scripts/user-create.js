// Create a merchant console user + membership (Session 26 / MC01).
//   pnpm user:create -- --tenant beastlife --email you@example.com --role owner [--name "You"]
// Password comes from USER_PASSWORD env or --password (prefer the env var so
// the password stays out of shell history). Creating the first member user
// switches that tenant's console from the bootstrap password to account login.
import { getTenant } from "../lib/platform/control.js";
import { createUser, findUserByEmail, addMembership, setUserPassword } from "../lib/platform/identity.js";

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const tenantSlug = flag("tenant");
const email = flag("email");
const role = flag("role") || "admin";
const name = flag("name");
const password = process.env.USER_PASSWORD || flag("password");
const resetPassword = process.argv.includes("--reset-password");

if (!tenantSlug || !email) {
  console.error('Usage: pnpm user:create -- --tenant <slug> --email <email> [--role owner|admin|staff|support] [--name "Name"] [--reset-password]');
  console.error("       password via USER_PASSWORD env (preferred) or --password");
  process.exit(1);
}

const tenant = await getTenant(tenantSlug);
if (!tenant) {
  console.error(`✗ tenant "${tenantSlug}" not found in the control plane`);
  process.exit(1);
}

let user = await findUserByEmail(email);
if (!user) {
  if (!password) {
    console.error("✗ new user needs a password — set USER_PASSWORD env or pass --password");
    process.exit(1);
  }
  user = await createUser({ email, name, password });
  console.log(`✓ user created: ${user.email} (${user.id})`);
} else {
  console.log(`• user exists: ${user.email} (${user.id})`);
  if (resetPassword) {
    if (!password) {
      console.error("✗ --reset-password needs USER_PASSWORD env or --password");
      process.exit(1);
    }
    await setUserPassword(user.id, password);
    console.log("✓ password updated (all sessions revoked)");
  }
}

await addMembership(user.id, tenant.id, role);
console.log(`✓ membership: ${user.email} → ${tenant.id} as ${role}`);
console.log(`→ sign in at https://<${tenant.id} host>/admin/login with email + password.`);
console.log("  NOTE: the tenant's bootstrap console password no longer works for this store.");
process.exit(0);
