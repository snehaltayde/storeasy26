// The roles store seed (Phase 0 line 5), as the child process the roles
// harness runs (scripts/dev-roles.js → runHarness with ROLES_PROFILE). The
// harness starts its three local sqld servers and passes their URLs in the
// environment; this writes the store over http and prints one line.
// Never run directly against anything but those servers: every URL is checked.
import { join } from "node:path";
import { HarnessError } from "./design-harness.js";
import { ROLES_DATA_DIR_NAME, seedRolesStore, summaryLine } from "./seed-roles-store.js";

try {
  const summary = await seedRolesStore({
    platformUrl: process.env.PLATFORM_DB_URL,
    tenantUrl: process.env.DESIGN_TENANT_DB_URL,
    defaultUrl: process.env.DATABASE_URL,
    // the harness runs this with cwd = the repo root it was started for
    dataDir: join(process.cwd(), ROLES_DATA_DIR_NAME),
    port: Number(process.env.DESIGN_PORT) || undefined,
  });
  console.log(summaryLine(summary));
  process.exit(0);
} catch (e) {
  console.error(`✗ ${e instanceof HarnessError ? e.message : String(e?.stack || e)}`);
  process.exit(1);
}
