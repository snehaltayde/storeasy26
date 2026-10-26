// Register/repair the catalog webhook subscriptions for a tenant (Session 21):
//   pnpm webhooks:register <slug> [--url https://storeasy26.vercel.app]
// Idempotent — creates missing topics, repoints stale callback URLs.
import { getTenant } from "../lib/platform/control.js";
import { registerWebhooks } from "../lib/platform/shopify-webhooks.js";

const slug = process.argv[2];
const urlIdx = process.argv.indexOf("--url");
const base = urlIdx >= 0 ? process.argv[urlIdx + 1] : process.env.PLATFORM_URL || "https://storeasy26.vercel.app";

if (!slug || slug.startsWith("--")) {
  console.error("usage: pnpm webhooks:register <slug> [--url https://…]");
  process.exit(1);
}
const tenant = await getTenant(slug);
if (!tenant) {
  console.error(`✗ tenant "${slug}" not found`);
  process.exit(1);
}

try {
  const callbackUrl = `${base.replace(/\/$/, "")}/api/shopify/webhooks`;
  console.log(`→ registering webhooks for "${slug}" → ${callbackUrl}`);
  const results = await registerWebhooks(tenant, { callbackUrl });
  for (const r of results) {
    const mark = r.status === "error" ? "✗" : "✓";
    console.log(`  ${mark} ${r.topic}: ${r.status}${r.errors ? " " + JSON.stringify(r.errors) : ""}`);
  }
  process.exit(results.some((r) => r.status === "error") ? 1 : 0);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
