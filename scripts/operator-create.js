// Create (or promote) a PLATFORM OPERATOR (Session 26 / OP01).
//   pnpm operator:create -- --email you@example.com [--name "You"]
// Password via USER_PASSWORD env (preferred) or --password. TOTP enrolls at
// the operator's first /platform sign-in (mandatory). Creating the first
// operator DISABLES the legacy PLATFORM_ADMIN_PASSWORD login.
import { createOperator } from "../lib/platform/identity.js";

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const email = flag("email");
const name = flag("name");
const password = process.env.USER_PASSWORD || flag("password");

if (!email) {
  console.error('Usage: pnpm operator:create -- --email <email> [--name "Name"]');
  console.error("       password via USER_PASSWORD env (preferred) or --password");
  process.exit(1);
}

try {
  const user = await createOperator({ email, name, password });
  console.log(`✓ operator ready: ${user.email} (${user.id})`);
  console.log("→ sign in at /platform with email + password; the first sign-in enrolls your authenticator (TOTP).");
  console.log("  NOTE: the legacy PLATFORM_ADMIN_PASSWORD login is now disabled.");
  process.exit(0);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
