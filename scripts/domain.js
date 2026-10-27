// Domain registry CLI (S28 / BE12).
//   pnpm domain -- claim   --tenant demo --host shop.example.com [--pre-verified]
//   pnpm domain -- verify  --host shop.example.com     (DNS TXT lookup)
//   pnpm domain -- remove  --host shop.example.com
//   pnpm domain -- primary --host shop.example.com
//   pnpm domain -- list    [--tenant demo]
import { claimDomain, verifyDomain, removeDomain, setPrimaryDomain, listDomains } from "../lib/platform/domains.js";

// pnpm forwards a literal "--" separator into argv — drop it before parsing.
const args = process.argv.slice(2).filter((a) => a !== "--");
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}
const cmd = args[0];
const host = flag("host");
const tenant = flag("tenant");

try {
  if (cmd === "claim") {
    const r = await claimDomain({ host, tenantId: tenant, preVerified: process.argv.includes("--pre-verified") });
    if (r.verified) {
      console.log(`✓ ${r.host} is verified and active for ${tenant}`);
    } else {
      console.log(`✓ claimed ${r.host} for ${tenant} — prove ownership with this DNS record, then run verify:`);
      console.log(`    TXT  ${r.txtRecord.name}  →  ${r.txtRecord.value}`);
    }
  } else if (cmd === "verify") {
    const r = await verifyDomain({ host });
    if (r.ok) console.log(`✓ ${host} verified${r.already ? " (already was)" : " and activated"}`);
    else {
      console.error(`✗ ${r.error}`);
      process.exit(1);
    }
  } else if (cmd === "remove") {
    console.log((await removeDomain({ host })) ? `✓ ${host} removed and deactivated` : `• ${host} was not registered`);
  } else if (cmd === "primary") {
    await setPrimaryDomain({ host });
    console.log(`✓ ${host} is now its tenant's primary host (config.primary_host)`);
  } else if (cmd === "list") {
    const rows = await listDomains({ tenantId: tenant || null });
    if (!rows.length) console.log("(no registered domains)");
    for (const r of rows) {
      console.log(
        `${r.host}  tenant=${r.tenant_id}  ${r.verified_at ? `verified(${r.method})` : "PENDING"}${Number(r.is_primary) ? "  PRIMARY" : ""}`,
      );
    }
  } else {
    console.error("Usage: pnpm domain -- (claim|verify|remove|primary|list) [--tenant <slug>] [--host <host>] [--pre-verified]");
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
