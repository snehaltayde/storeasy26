// Apply control-plane migrations (S28: versioned ledger — baseline =
// lib/platform/schema.sql, then migrations/platform/NNNN_*.sql).
//   pnpm platform:migrate          (PLATFORM_DB_URL, local-file fallback)
import { platformDb } from "../lib/platform/control.js";
import { loadMigrations, runMigrations } from "../lib/platform/migrate.js";

try {
  const migrations = await loadMigrations("platform");
  const r = await runMigrations(platformDb(), migrations, { log: console.log });
  console.log(
    `✓ control plane at ${process.env.PLATFORM_DB_URL || "file:platform.db"} — ` +
      `${r.applied.length} applied (${r.applied.join(", ") || "none"}), ${r.skipped} already recorded`,
  );
  process.exit(0);
} catch (err) {
  console.error("✗ platform migrate failed:", err.message);
  process.exit(1);
}
