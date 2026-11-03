// Design harness (S50, edge runtime since P1-HARNESS). A local store with
// realistic data for reviewing the storefront and the consoles: local sqld
// databases, test credentials generated once into .design-env (gitignored),
// and the known hosted service keys blanked (BLANKED_ENV in design-harness.js).
//   pnpm seed:design   fresh data (wipes .design-data/ and seeds it again)
//   pnpm dev:design    start it: http://localhost:3017 (seeds first if needed)
// Ctrl-C stops Next and the databases together. A second harness, or a seed,
// while one runs is refused.
//
// Ports: DESIGN_PORT (web, default 3017) and DESIGN_SQLD_PORT (first of three
// database ports, default 18017). sqld is found through SQLD_BIN, then PATH,
// then ~/.turso/sqld. See scripts/design-harness.js and docs/cms-reviews/P1-HARNESS.md.
import { HarnessError, runHarness } from "./design-harness.js";

const arg = process.argv[2];
if (arg && arg !== "seed") {
  console.error(`✗ Unknown option "${arg}". Use: node scripts/dev-design.js [seed]`);
  process.exit(2);
}

try {
  process.exit(await runHarness({ mode: arg === "seed" ? "seed" : "dev" }));
} catch (e) {
  if (e instanceof HarnessError) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  throw e;
}
