// Support-grant CLI (S34 / OP10).
//   pnpm support -- grant  --tenant demo --reason "debug order BL-X" [--hours 4]
//   pnpm support -- revoke --id sg_…
//   pnpm support -- list [--tenant demo]
import { createSupportGrant, revokeSupportGrant, listSupportGrants } from "../lib/platform/support.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const cmd = args[0];

try {
  if (cmd === "grant") {
    const g = await createSupportGrant({ tenantId: flag("tenant"), reason: flag("reason"), hours: flag("hours"), operator: "cli" });
    console.log(`✓ grant ${g.id} on ${g.tenantId} until ${g.expiresAt}`);
    console.log("→ with your operator session (_platform cookie), that tenant's /admin now opens as the read-only SUPPORT role; the merchant sees the banner.");
  } else if (cmd === "revoke") {
    console.log((await revokeSupportGrant(flag("id"), { operator: "cli" })) ? "✓ revoked (effective on the operator's next request)" : "• no active grant with that id");
  } else if (cmd === "list") {
    const rows = await listSupportGrants({ tenantId: flag("tenant") });
    if (!rows.length) console.log("(no grants)");
    for (const r of rows) {
      const state = r.revoked_at ? "revoked" : new Date(r.expires_at) < new Date() ? "expired" : "ACTIVE";
      console.log(`${r.id}  ${r.tenant_id}  ${state}  until ${r.expires_at}  — ${r.reason}`);
    }
  } else {
    console.error('Usage: pnpm support -- (grant --tenant <slug> --reason "…" [--hours N] | revoke --id <id> | list [--tenant <slug>])');
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
