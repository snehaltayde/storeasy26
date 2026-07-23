// Apply the catalog schema to the configured database.
//   pnpm migrate            # create tables if missing
//   pnpm db:reset           # drop + recreate (alias: migrate --reset)
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { libsql } from "../lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const reset = process.argv.includes("--reset");

// Session 10: bring a pre-existing orders table up to the v2 shape (idempotency
// key, snapshot, sync refs, timestamps) BEFORE applying schema.sql — its new
// indexes reference these columns. Fresh DBs skip this; schema.sql creates the
// full shape. Also maps legacy Phase-0 statuses onto the state machine.
async function ensureOrderColumns() {
  const t = await libsql.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='orders'",
  );
  if (!t.rows.length) return;

  const info = await libsql.execute("SELECT name FROM pragma_table_info('orders')");
  const have = new Set(info.rows.map((r) => r.name));
  const wanted = [
    ["idempotency_key", "TEXT"],
    ["cart_id", "TEXT"],
    ["shipping_total", "REAL NOT NULL DEFAULT 0"],
    ["snapshot", "TEXT"],
    ["shopify_order_id", "TEXT"],
    ["sync_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["sync_error", "TEXT"],
    ["updated_at", "TEXT"],
    ["paid_at", "TEXT"],
    ["synced_at", "TEXT"],
  ];
  const missing = wanted.filter(([col]) => !have.has(col));
  for (const [col, type] of missing) {
    await libsql.execute(`ALTER TABLE orders ADD COLUMN ${col} ${type}`);
  }
  if (missing.length) console.log(`• orders: added ${missing.map(([c]) => c).join(", ")}`);

  const rz = await libsql.execute(
    "UPDATE orders SET status='paid' WHERE status='confirmed' AND payment_method='razorpay'",
  );
  const cod = await libsql.execute(
    "UPDATE orders SET status='cod_pending' WHERE status='confirmed' AND payment_method='cod'",
  );
  const mapped = (rz.rowsAffected || 0) + (cod.rowsAffected || 0);
  if (mapped) console.log(`• orders: mapped ${mapped} legacy 'confirmed' row(s) onto the state machine`);
}

try {
  if (reset) {
    await libsql.executeMultiple(
      [
        "DROP TABLE IF EXISTS collection_products;",
        "DROP TABLE IF EXISTS variants;",
        "DROP TABLE IF EXISTS product_images;",
        "DROP TABLE IF EXISTS collections;",
        "DROP TABLE IF EXISTS products;",
      ].join("\n"),
    );
    console.log("• dropped existing tables");
  }

  await ensureOrderColumns();
  const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
  await libsql.executeMultiple(schema);
  console.log(
    `✓ schema applied → ${process.env.TURSO_DB_URL || process.env.DATABASE_URL || "file:local.db"}`,
  );
  process.exit(0);
} catch (err) {
  console.error("✗ migrate failed:", err.message);
  process.exit(1);
}
