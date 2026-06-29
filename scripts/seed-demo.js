// Seed a tiny demo catalog so the storefront can be previewed WITHOUT a Shopify
// token. Images are intentionally null (placeholder UI). Replace with the real
// catalog any time via: pnpm db:reset && pnpm sync
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { libsql, db } from "../lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const now = new Date().toISOString();
const J = JSON.stringify;

async function main() {
  const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
  await libsql.executeMultiple(schema);

  for (const t of ["collection_products", "variants", "product_images", "collections", "products"]) {
    await db.deleteFrom(t).execute();
  }

  const products = [
    {
      id: "demo-1",
      handle: "beast-whey-protein",
      title: "Beast Whey Protein — 1kg",
      description: "24g of premium whey protein per scoop to fuel recovery and growth.",
      description_html:
        "<p>Premium whey protein blend for serious lifters.</p><ul><li>24g protein per serving</li><li>5.5g BCAAs</li><li>Low sugar, mixes instantly</li></ul>",
      product_type: "Protein",
      vendor: "BeastLife",
      tags: J(["protein", "whey", "muscle"]),
      price_min: 2999,
      price_max: 2999,
      compare_at_min: 3499,
      currency: "INR",
      available: 1,
      total_inventory: 120,
      featured_image: null,
      featured_image_alt: null,
      options: J([{ name: "Flavor", values: ["Chocolate", "Vanilla"] }]),
      created_at: now,
      updated_at: now,
      synced_at: now,
    },
    {
      id: "demo-2",
      handle: "beast-creatine-monohydrate",
      title: "Beast Creatine Monohydrate — 250g",
      description: "Micronised creatine monohydrate for strength and power.",
      description_html: "<p>Pure micronised creatine. 3g per serving, 83 servings.</p>",
      product_type: "Creatine",
      vendor: "BeastLife",
      tags: J(["creatine", "strength"]),
      price_min: 1299,
      price_max: 1299,
      compare_at_min: null,
      currency: "INR",
      available: 1,
      total_inventory: 60,
      featured_image: null,
      featured_image_alt: null,
      options: J([{ name: "Title", values: ["Default Title"] }]),
      created_at: now,
      updated_at: now,
      synced_at: now,
    },
    {
      id: "demo-3",
      handle: "beast-steel-shaker",
      title: "Beast Steel Shaker — 750ml",
      description: "Insulated stainless-steel shaker that keeps shakes cold.",
      description_html: "<p>Leak-proof, insulated, gym-ready.</p>",
      product_type: "Accessories",
      vendor: "BeastLife",
      tags: J(["shaker", "accessories"]),
      price_min: 499,
      price_max: 499,
      compare_at_min: null,
      currency: "INR",
      available: 0,
      total_inventory: 0,
      featured_image: null,
      featured_image_alt: null,
      options: J([{ name: "Title", values: ["Default Title"] }]),
      created_at: now,
      updated_at: now,
      synced_at: now,
    },
  ];

  const variants = [
    { id: "demo-1-v1", product_id: "demo-1", title: "Chocolate", sku: "WHEY-CHOC", price: 2999, compare_at_price: 3499, currency: "INR", available: 1, selected_options: J([{ name: "Flavor", value: "Chocolate" }]), image_url: null, position: 0 },
    { id: "demo-1-v2", product_id: "demo-1", title: "Vanilla", sku: "WHEY-VAN", price: 2999, compare_at_price: 3499, currency: "INR", available: 1, selected_options: J([{ name: "Flavor", value: "Vanilla" }]), image_url: null, position: 1 },
    { id: "demo-2-v1", product_id: "demo-2", title: "Default Title", sku: "CREA-250", price: 1299, compare_at_price: null, currency: "INR", available: 1, selected_options: J([{ name: "Title", value: "Default Title" }]), image_url: null, position: 0 },
    { id: "demo-3-v1", product_id: "demo-3", title: "Default Title", sku: "SHAKER-750", price: 499, compare_at_price: null, currency: "INR", available: 0, selected_options: J([{ name: "Title", value: "Default Title" }]), image_url: null, position: 0 },
  ];

  const collections = [
    { id: "col-1", handle: "bestsellers", title: "Bestsellers", description: "Our most-loved gear.", image: null, image_alt: null, updated_at: now, synced_at: now },
    { id: "col-2", handle: "protein", title: "Protein", description: "Whey, isolates and blends.", image: null, image_alt: null, updated_at: now, synced_at: now },
  ];

  const memberships = [
    { collection_id: "col-1", product_id: "demo-1", position: 0 },
    { collection_id: "col-1", product_id: "demo-2", position: 1 },
    { collection_id: "col-1", product_id: "demo-3", position: 2 },
    { collection_id: "col-2", product_id: "demo-1", position: 0 },
  ];

  await db.insertInto("products").values(products).execute();
  await db.insertInto("variants").values(variants).execute();
  await db.insertInto("collections").values(collections).execute();
  await db.insertInto("collection_products").values(memberships).execute();

  console.log(`✓ seeded ${products.length} demo products, ${collections.length} collections`);
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ seed failed:", err.message);
  process.exit(1);
});
