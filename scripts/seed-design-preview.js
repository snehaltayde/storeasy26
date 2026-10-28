// Design-preview seed (S50). Builds a LOCAL, file-DB environment with
// realistic data for reviewing the redesigned consoles — every status the
// UI can render, so screenshots exercise real states, not lorem ipsum.
// Credentials are LOCAL TEST VALUES from env (scripts/dev-design.js
// generates them into .design-env on first run; nothing hosted, nothing
// real). Deliberately non-default brand on the tenant, to prove tenant
// brand variables no longer leak into the console.
//   pnpm seed:design
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.RESEND_API_KEY = "";
process.env.DATABASE_URL = "file:.design-default.db";
process.env.PLATFORM_DB_URL = "file:.design-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = process.env.PLATFORM_SECRET || "design-preview-secret";

const ADMIN_PW = process.env.DESIGN_ADMIN_PASSWORD;
if (!ADMIN_PW) {
  console.error("DESIGN_ADMIN_PASSWORD missing — run via `pnpm seed:design` / `pnpm dev:design` (scripts/dev-design.js supplies it).");
  process.exit(1);
}

for (const f of [".design-default.db", ".design-platform.db", ".design-tenant.db"]) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});

await C.upsertTenant({
  id: "design",
  name: "Design Demo Co",
  domains: ["localhost", "127.0.0.1"],
  dbUrl: "file:.design-tenant.db",
  config: {
    currency: "INR",
    merchant_timezone: "Asia/Kolkata",
    site: { name: "Design Demo Co", title: "Design Demo Co", tagline: "Realistic data for the console redesign", support_email: "support@design.test" },
    // deliberately NON-default brand: if the console ever shows teal/huge
    // type again, tenant vars are leaking.
    brand: { accent: "#0d9488", background: "#fffdf8", foreground: "#1c1917", radius: "xl", type_scale: "large" },
    returns_window_days: 14,
  },
  secrets: { admin_password: ADMIN_PW, order_link_secret: "design-order-secret" },
});

const t = await C.getTenant("design");
const nowMs = Date.now();
const iso = (daysAgo, h = 10) => new Date(nowMs - daysAgo * 86400000 + h * 3600000 - 10 * 3600000).toISOString();

await withTenant(t, async () => {
  await libsql.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
  await runMigrations(libsql, await loadMigrations("tenant"));

  // ---- catalog: 8 products, 3 collections -----------------------------------
  const products = [
    ["gid://p/1", "glow-serum", "Radiance Glow Serum 30ml", 1, 1299, "Serums", '["glow","serum","bestseller"]'],
    ["gid://p/2", "night-repair-cream", "Night Repair Cream 50g", 1, 1799, "Moisturizers", '["repair","night"]'],
    ["gid://p/3", "spf-50-sunscreen", "Daily Defence SPF 50", 1, 899, "Sun care", '["spf","daily"]'],
    ["gid://p/4", "vitamin-c-booster", "Vitamin C Booster 15ml", 1, 1499, "Serums", '["glow","vitamin-c"]'],
    ["gid://p/5", "gentle-cleanser", "Gentle Oat Cleanser 150ml", 1, 649, "Cleansers", '["cleanser","gentle"]'],
    ["gid://p/6", "clay-mask", "Detox Clay Mask 100g", 0, 999, "Masks", '["mask","detox"]'],
    ["gid://p/7", "rose-mist", "Rose Hydration Mist 100ml", 1, 749, "Toners", '["hydration","rose"]'],
    ["gid://p/8", "lip-sleeping-mask", "Lip Sleeping Mask 20g", 1, 549, "Masks", '["lip","night"]'],
  ];
  for (const [id, handle, title, avail, price, type, tags] of products) {
    await libsql.execute({
      sql: "INSERT INTO products (id, handle, title, available, currency, price_min, price_max, product_type, tags, description) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [id, handle, title, avail, "INR", price, price, type, tags, `${title} — part of the Design Demo Co routine.`],
    });
    await libsql.execute({
      sql: "INSERT INTO variants (id, product_id, title, price, available, position) VALUES (?,?,?,?,?,0)",
      args: [id.replace("gid://p/", "gid://v/"), id, "Default", price, avail],
    });
  }
  for (const [id, handle, title] of [["gid://c/1", "bestsellers", "Bestsellers"], ["gid://c/2", "serums", "Serums"], ["gid://c/3", "night-routine", "Night routine"]]) {
    await libsql.execute({ sql: "INSERT INTO collections (id, handle, title) VALUES (?,?,?)", args: [id, handle, title] });
  }

  // ---- orders: every status the UI renders ----------------------------------
  const mkOrder = async (id, status, daysAgo, total, method, extra = {}) => {
    const snap = JSON.stringify({
      items: [
        { variantId: "gid://v/1", title: "Radiance Glow Serum 30ml", quantity: 2, price: 1299, lineTotal: 2598 },
        { variantId: "gid://v/3", title: "Daily Defence SPF 50", quantity: 1, price: 899, lineTotal: 899 },
      ],
      consent: JSON.stringify({ v: 2, a: 1, m: daysAgo % 2 === 0 ? 1 : 0, at: iso(daysAgo) }),
    });
    await libsql.execute({
      sql: `INSERT INTO orders (id, email, phone, name, total, subtotal, shipping_total, discount_total, currency, status, payment_method, snapshot, created_at, updated_at, paid_at, sync_attempts, sync_error, refunded_total, shopify_order_id)
            VALUES (?,?,?,?,?,?,?,?, 'INR', ?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        `shopper${daysAgo}@example.test`,
        "9876500000",
        ["Aarav Shah", "Priya Nair", "Kabir Mehta", "Ishita Rao", "Dev Patel"][daysAgo % 5],
        total,
        total - 49,
        49,
        0,
        status,
        method,
        snap,
        iso(daysAgo),
        iso(daysAgo, 12),
        ["pending_payment", "cod_pending"].includes(status) ? null : iso(daysAgo, 11),
        extra.attempts ?? (status === "sync_failed" ? 5 : 0),
        extra.error ?? (status === "sync_failed" ? "Shopify 502: upstream timeout after 3 retries" : null),
        extra.refunded ?? 0,
        ["synced", "cancelled"].includes(status) ? `gid://shopify/Order/90${daysAgo}` : null,
      ],
    });
  };
  let day = 0;
  for (const [prefix, status, n, method] of [
    ["SYNC", "synced", 9, "razorpay"],
    ["PAID", "paid", 4, "razorpay"],
    ["CODP", "cod_pending", 3, "cod"],
    ["PUSH", "syncing_shopify", 1, "razorpay"],
    ["FAIL", "sync_failed", 2, "razorpay"],
    ["PEND", "pending_payment", 2, "razorpay"],
    ["CANC", "cancelled", 3, "cod"],
  ]) {
    for (let i = 0; i < n; i++) await mkOrder(`DD-${prefix}${i + 1}`, status, day++ % 28, 3497 + i * 250, method);
  }
  await libsql.execute("UPDATE orders SET refunded_total = 899 WHERE id = 'DD-SYNC1'");
  await libsql.execute({
    sql: "INSERT INTO order_refunds (id, order_id, amount, created_at, note) VALUES ('rf_1','DD-SYNC1',899,?, 'damaged in transit — SPF refunded')",
    args: [iso(2)],
  });

  // ---- returns: one per status ----------------------------------------------
  await libsql.execute({ sql: "INSERT INTO customers (id, email, name, created_at) VALUES ('cus_d1','shopper1@example.test','Priya Nair',?)", args: [iso(20)] });
  await libsql.execute("UPDATE orders SET customer_id = 'cus_d1' WHERE id IN ('DD-SYNC1','DD-SYNC2','DD-SYNC3','DD-SYNC4')");
  for (const [id, order, status, note, daysAgo] of [
    ["ret_d1", "DD-SYNC1", "requested", null, 1],
    ["ret_d2", "DD-SYNC2", "approved", "send it back in the original box", 3],
    ["ret_d3", "DD-SYNC3", "completed", "received — refund via provider", 6],
    ["ret_d4", "DD-SYNC4", "rejected", "outside the 14-day window", 8],
  ]) {
    await libsql.execute({
      sql: "INSERT INTO return_requests (id, order_id, customer_id, reason, status, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      args: [id, order, "cus_d1", "The texture wasn't right for my skin — would like to return it.", status, note, iso(daysAgo), iso(daysAgo)],
    });
  }

  // ---- offers in three lifecycle states + an upsell --------------------------
  const { upsertOffer } = await import("../lib/offers/store.js");
  await upsertOffer({
    offer: { id: "serum-duo", type: "TIERED_QTY", scope: "line", title: "Serum duo — 15% off 2+", target: { kind: "handle", value: "glow-serum" }, tiers: [{ minQty: 2, percent: 15 }] },
    enabled: true,
  });
  await upsertOffer({
    offer: { id: "festive-10", type: "COUPON", scope: "order", title: "FESTIVE10 — 10% off", code: "FESTIVE10", discount: { kind: "percent", value: 10 } },
    enabled: true,
    startsAt: new Date(nowMs + 5 * 86400000).toISOString(),
    endsAt: new Date(nowMs + 20 * 86400000).toISOString(),
  });
  await upsertOffer({
    offer: { id: "gift-lip-mask", type: "FREE_GIFT", scope: "gift", title: "Free lip mask over ₹2,999", threshold: 2999, gift: { variantId: "gid://shopify/ProductVariant/designlip", title: "Lip Sleeping Mask 20g" } },
    enabled: false,
  });
  const { upsertPlacement } = await import("../lib/cms/placements.js");
  await upsertPlacement({ kind: "pdp_pairs", sourceProductId: "gid://p/1", targetProductIds: ["gid://p/4", "gid://p/3"], title: "Pairs well with", enabled: true }).catch(() => {});

  // ---- CMS: customized blocks + a page + a release ---------------------------
  const { setBlock, upsertContentPage } = await import("../lib/cms/store.js");
  await setBlock("announcement", { enabled: true, text: "Festive sale — free shipping over ₹1,499", href: "/collections" });
  await setBlock("hero", {
    title: "Skin first. Makeup second.",
    highlight: "Skin first",
    subtitle: "Clinically-tested routines for Indian skin — serums, SPF and repair that actually show up in the mirror.",
    primary: { label: "Shop bestsellers", href: "/collections" },
    secondary: { label: "What's new", href: "#new" },
  });
  await upsertContentPage({
    slug: "shipping",
    title: "Shipping policy",
    family: "page",
    sections: [{ kind: "text", heading: "Dispatch", body: ["Orders dispatch within 24 hours on business days."] }],
  });
  const { createRelease, publishReleaseById } = await import("../lib/releases.js");
  const rel = await createRelease({ note: "Launch content", actor: "seed" });
  await publishReleaseById(rel.id);
  await setBlock("hero", {
    title: "Winter repair, started.",
    highlight: "Winter repair",
    subtitle: "The night-cream routine your skin asked for in October.",
    primary: { label: "Shop night routine", href: "/collections" },
  }); // → UNPUBLISHED CHANGES state on Releases

  // ---- experiments: running + completed --------------------------------------
  const X = await import("../lib/experiments.js");
  await X.upsertExperiment({
    slug: "hero-promise",
    name: "Hero promise test",
    hypothesis: "a benefit-led headline beats the brand-led control",
    min_sample: 200,
    variants: [
      { key: "control", weight: 50 },
      { key: "b", weight: 50, payload: { title: "Visibly brighter in 14 days", highlight: "14 days", subtitle: "Or your money back." } },
    ],
  });
  await X.startExperiment("hero-promise");
  for (let i = 0; i < 46; i++) await X.recordExposure("hero-promise", `unit-${i}`);
  await X.recordConversions("unit-3", "DD-SYNC1", 3497);
  await X.upsertExperiment({
    slug: "cta-copy",
    name: "CTA copy test",
    hypothesis: "h",
    min_sample: 100,
    variants: [
      { key: "control", weight: 50 },
      { key: "b", weight: 50, payload: { title: "Start your routine" } },
    ],
  });
  await libsql.execute("UPDATE experiments SET status='completed', ended_at=datetime('now') WHERE slug='cta-copy'");

  // ---- automations + run history ---------------------------------------------
  const M = await import("../lib/automations.js");
  await M.setAutomationsDisabled(false);
  const rule = await M.upsertAutomation(
    { name: "Big order ping", trigger: "order_placed", conditions: { min_total: 2999 }, action: { kind: "notify_merchant", text: "A big order just landed — check fulfilment stock." }, cap_per_day: 25 },
    { enabled: true }
  );
  await M.upsertAutomation(
    { name: "Thank-you note", trigger: "order_placed", conditions: {}, action: { kind: "email_customer", subject: "Thank you!", text: "Thanks for your order — reply any time." }, cap_per_day: 10, quiet_start: "22:00", quiet_end: "08:00" },
    { enabled: false }
  );
  for (const [key, status, reason] of [
    ["order_placed:DD-SYNC1", "done", "notify_merchant → support@design.test (queued)"],
    ["order_placed:DD-SYNC2", "skipped", "condition: total 3497 under min 5000"],
    ["order_placed:DD-PAID1", "failed", "action error: mail provider 503"],
    ["dry:seed", "dry_run", "WOULD send notify_merchant to support@design.test"],
  ]) {
    await libsql.execute({
      sql: "INSERT OR IGNORE INTO automation_runs (id, automation_id, event_key, status, reason, created_at) VALUES (?,?,?,?,?,?)",
      args: [`run-${key.replaceAll(":", "-")}`, rule.id, key, status, reason, iso(1)],
    });
  }

  // ---- events for analytics (consented) --------------------------------------
  for (let i = 0; i < 60; i++) {
    await libsql.execute({
      sql: "INSERT INTO events (id, name, payload, consent, created_at, status) VALUES (?,?,?,?,?, 'forwarded')",
      args: [
        `ev_${i}`,
        i % 10 === 0 ? "search" : i % 3 === 0 ? "view_item" : "page_view",
        JSON.stringify({ params: i % 10 === 0 ? { search_term: i % 20 === 0 ? "retinol" : "serum", results: i % 20 === 0 ? 0 : 4 } : { device: i % 4 === 0 ? "mobile" : "desktop" } }),
        JSON.stringify({ v: 2, a: 1, m: 0 }),
        iso(i % 28),
      ],
    }).catch(() => {});
  }
});

// ---- platform-side: incident, agency + grant + approval ------------------------
await C.platformDb().execute({
  sql: "INSERT INTO incidents (id, tenant_id, title, internal_note, public_message, status, created_at) VALUES ('inc_design', NULL, 'Payments provider latency', 'Razorpay status page shows elevated latency', 'Card payments may take a little longer than usual today.', 'open', ?)",
  args: [new Date().toISOString()],
});
const A = await import("../lib/platform/agency.js");
const { createUser } = await import("../lib/platform/identity.js");
const agency = await A.createAgency({ name: "Northwind Studio" });
await A.setAgencyStatus(agency.id, { status: "verified", referral_eligible: true });
const partner = await createUser({ email: "partner@design.test", name: "Design Partner", password: ADMIN_PW });
await A.addAgencyMember(agency.id, partner.id, "owner");
const inv = await A.createGrantInvite({ agencyId: agency.id, clientEmail: "owner@design.test", role: "staff" });
await A.acceptGrant(inv.token, { tenantId: "design", actorEmail: "owner@design.test" });
await A.createClientApproval({ agencyId: agency.id, tenantId: "design", note: "Homepage refresh for the winter drop" });

console.log("✓ design-preview seeded: tenant 'design' on file DBs (.design-*.db)");
console.log("  merchant: http://localhost:3017/admin/login — empty email + the setup password from .design-env");
console.log("  operator: http://localhost:3017/platform   — the platform password from .design-env");
process.exit(0);
