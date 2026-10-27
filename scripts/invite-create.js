// Invite someone to a tenant's console (Session 26 / MC01).
//   pnpm invite:create -- --tenant beastlife --email teammate@example.com [--role admin]
// Emails a 7-day single-use acceptance link (console MOCK when no mail
// provider is configured — the link prints here instead).
import { getTenant } from "../lib/platform/control.js";
import { createInvite } from "../lib/platform/identity.js";
import { sendMail } from "../lib/mail.js";

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const tenantSlug = flag("tenant");
const email = flag("email");
const role = flag("role") || "admin";

if (!tenantSlug || !email) {
  console.error("Usage: pnpm invite:create -- --tenant <slug> --email <email> [--role owner|admin|staff|support]");
  process.exit(1);
}

const tenant = await getTenant(tenantSlug);
if (!tenant) {
  console.error(`✗ tenant "${tenantSlug}" not found in the control plane`);
  process.exit(1);
}

const { token, expiresAt } = await createInvite({ email, tenantId: tenant.id, role, invitedBy: "cli" });
const host = tenant.domains?.[0] || `<${tenant.id} host>`;
const proto = String(host).includes("localhost") || String(host).includes("127.0.0.1") ? "http" : "https";
const link = `${proto}://${host}/admin/accept-invite?token=${token}`;

const mail = await sendMail({
  to: email,
  subject: `You're invited to the ${tenant.name} store console`,
  text: `You've been invited to the ${tenant.name} store console as ${role}.\n\nAccept here (valid 7 days, single use):\n${link}\n`,
});

console.log(`✓ invitation created for ${email} → ${tenant.id} as ${role} (expires ${expiresAt})`);
console.log(mail.mock ? "  (mail is MOCKED — the link above was printed, not sent)" : `  mail sent: ${mail.ok ? mail.id || "ok" : `FAILED: ${mail.error}`}`);
process.exit(0);
