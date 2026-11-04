// Provision a new tenant end-to-end (Session 21):
//   pnpm tenant:provision <slug> --shop <x.myshopify.com> [--name "Store"] \
//     [--domain host ...] [--client-id ID --client-secret SECRET] \
//     [--db-url libsql://… --db-token …] [--force] [--legacy-content]
// Creates the tenant Turso DB via the authed `turso` CLI (or TURSO_API_TOKEN),
// applies the commerce schema, registers the tenant (no brand content seeded).
// P4-PROVISION (MIG-03, OQ-4): a new, empty store starts on the new editor and
// stays private ("Opening soon") until its first publish. A database that
// already holds store content keeps the old editor (move it with the cutover).
// --legacy-content starts the store on the old editor (an operator escape;
// recorded in the run).
import { provisionTenant, editorSummary } from "../lib/platform/provision.js";

const args = process.argv.slice(2);
const slug = args[0] && !args[0].startsWith("--") ? args[0] : null;
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const domains = args.flatMap((a, i) => (a === "--domain" ? [args[i + 1]] : []));

// Env fallbacks cover the v1 design-partner flow where the operator's shell
// already carries the app creds (and the demo tenant shares the dev store).
const shop = flag("shop") || process.env.SHOPIFY_STORE_DOMAIN;
const clientId = flag("client-id") || process.env.SHOPIFY_CLIENT_ID || null;
const clientSecret = flag("client-secret") || process.env.SHOPIFY_CLIENT_SECRET || null;

if (!slug || !shop) {
  console.error("usage: pnpm tenant:provision <slug> --shop <x.myshopify.com> [--name …] [--domain host …] [--client-id … --client-secret …] [--db-url … --db-token …] [--force] [--legacy-content]");
  process.exit(1);
}

try {
  const { tenant, generated, run } = await provisionTenant({
    id: slug,
    name: flag("name") || slug,
    domains,
    shopDomain: shop,
    clientId,
    clientSecret,
    siteName: flag("name"),
    dbUrl: flag("db-url"),
    dbToken: flag("db-token"),
    force: args.includes("--force"),
    contentMode: args.includes("--legacy-content") ? "legacy" : "documents",
    log: console.log,
  });
  console.log(`\n✓ tenant "${tenant.id}" provisioned`);
  console.log(`  domains:        ${tenant.domains.join(", ") || "(none yet)"}`);
  console.log(`  db:             ${tenant.dbUrl}`);
  console.log(`  admin password: ${generated.admin_password}   ← save this; shown once`);
  console.log(`\n${editorSummary(run?.refs)}`);
  console.log(`\nNext: connect Shopify → GET /api/connect/shopify/start?tenant=${tenant.id}&secret=$CRON_SECRET`);
  process.exit(0);
} catch (e) {
  console.error(`✗ provision failed: ${e.message}`);
  process.exit(1);
}
