// Apply the CONTROL-PLANE schema (lib/platform/schema.sql) to the platform DB.
//   pnpm platform:migrate          (PLATFORM_DB_URL, local-file fallback)
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migratePlatform } from "../lib/platform/control.js";

const here = dirname(fileURLToPath(import.meta.url));
try {
  const schema = await readFile(join(here, "../lib/platform/schema.sql"), "utf8");
  await migratePlatform(schema);
  console.log(`✓ control-plane schema applied → ${process.env.PLATFORM_DB_URL || "file:platform.db"}`);
  process.exit(0);
} catch (err) {
  console.error("✗ platform migrate failed:", err.message);
  process.exit(1);
}
