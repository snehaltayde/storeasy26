// Apply the catalog schema to the configured database.
//   pnpm migrate            # create tables if missing
//   pnpm db:reset           # drop + recreate (alias: migrate --reset)
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { libsql } from "../lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const reset = process.argv.includes("--reset");

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
