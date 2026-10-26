// Seed/refresh BeastLife as tenant #1 in the control plane (Session 20).
// Lifts the current single-store env (.env.local) into a tenant row — the
// exact values the env-fallback path already uses, so tenant-path behavior is
// identical by construction.
//   pnpm tenant:seed-beastlife [--staging]
// --staging seeds a second row for the staging deployment (its own Turso DB +
// Typesense collection; run with the merged env: --env-file=.env.local
// --env-file=.env.staging).
import { upsertTenant } from "../lib/platform/control.js";

const staging = process.argv.includes("--staging");
const id = staging ? "beastlife-staging" : "beastlife";

const domains = staging
  ? ["storeasy26-staging.vercel.app"]
  : ["storeasy26.vercel.app", "localhost", "localhost:3007", "localhost:3008"];

const tenant = await upsertTenant({
  id,
  name: staging ? "BeastLife (staging)" : "BeastLife",
  domains,
  dbUrl: process.env.TURSO_DB_URL || process.env.DATABASE_URL || "file:local.db",
  dbToken: process.env.TURSO_DB_AUTH_TOKEN || null,
  config: {
    shopify_store_domain: process.env.SHOPIFY_STORE_DOMAIN,
    shopify_api_version: process.env.SHOPIFY_API_VERSION || "2025-10",
    razorpay_key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    ga4_measurement_id: process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID || null,
    meta_pixel_id: process.env.NEXT_PUBLIC_META_PIXEL_ID || null,
    meta_test_event_code: process.env.META_TEST_EVENT_CODE || null,
    typesense_collection: process.env.TYPESENSE_COLLECTION || "products",
    site_url: process.env.NEXT_PUBLIC_SITE_URL || null,
    site: { name: "BeastLife", support_email: "care@beastlife.in", support_phone: "+91-9599339358" },
  },
  secrets: {
    shopify_admin_token: process.env.SHOPIFY_ADMIN_TOKEN || null,
    razorpay_key_secret: process.env.RAZORPAY_KEY_SECRET || null,
    razorpay_webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET || null,
    ga4_api_secret: process.env.GA4_API_SECRET || null,
    meta_capi_token: process.env.META_CAPI_TOKEN || null,
    admin_password: process.env.ADMIN_PASSWORD || null,
    order_link_secret: process.env.ORDER_LINK_SECRET || null,
  },
});

console.log(`✓ tenant "${tenant.id}" seeded — domains: ${tenant.domains.join(", ")}`);
console.log(`  db: ${tenant.dbUrl.slice(0, 40)}… · secrets encrypted: ${Object.keys(tenant.secrets).filter((k) => tenant.secrets[k]).length}`);
process.exit(0);
