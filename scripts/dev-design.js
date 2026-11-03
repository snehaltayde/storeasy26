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
//
// PERF-04: `node scripts/dev-design.js seed --fixture perf` seeds a store sized
// like a mid-size D2C brand on top of the demo data (scripts/perf-fixture.js).
import { HarnessError, runHarness } from "./design-harness.js";

const USAGE = "Use: node scripts/dev-design.js [seed] [--fixture perf]";
const args = process.argv.slice(2);
let mode = "dev";
let fixture = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "seed" && i === 0) mode = "seed";
  else if (a === "--fixture" && args[i + 1] && !args[i + 1].startsWith("--")) fixture = args[++i];
  else if (a.startsWith("--fixture=")) fixture = a.slice("--fixture=".length);
  else {
    console.error(`✗ Unknown option "${a}". ${USAGE}`);
    process.exit(2);
  }
}

try {
  process.exit(await runHarness({ mode, fixture }));
} catch (e) {
  if (e instanceof HarnessError) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  throw e;
}
