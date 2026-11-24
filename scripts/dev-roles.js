// The roles store (Phase 0 line 5): one local store with every role, on its
// own harness profile so the design harness's .design-data/ is never touched.
//   pnpm seed:roles            fresh store; refuses if .design-data-roles/ holds data
//   pnpm seed:roles --reset    deletes .design-data-roles/ (only it) and seeds again
//   pnpm dev:roles             runs it on http://roles.localhost:3018 (seeds first if no data; deletes nothing)
//   pnpm roles:code            prints the shopper's latest sign-in code (read only; harness running)
// Logins: .design-data-roles/roles-seed.json (0600). Ports: ROLES_PORT (web,
// 3018) and ROLES_SQLD_PORT (first of three, 18027). See scripts/seed-roles-store.js.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, dbUrl, harnessPorts, readPidfile, runHarness, runningHarness } from "./design-harness.js";
import { ROLES_PROFILE, assertFreshDataDir, assertNoHarnessRunning, assertSafeEnv, latestShopperCode } from "./seed-roles-store.js";

const USAGE = "Use: node scripts/dev-roles.js [seed [--reset] | code]";
const args = process.argv.slice(2);
const mode = args[0] === "seed" ? "seed" : args[0] === "code" ? "code" : args.length ? null : "dev";
const reset = mode === "seed" && args.includes("--reset");
const extra = args.slice(1).filter((a) => !(mode === "seed" && a === "--reset"));
if (!mode || extra.length) {
  console.error(`✗ Unknown option "${mode ? extra[0] : args[0]}". ${USAGE}`);
  process.exit(2);
}
// The root is the folder it is run from (pnpm runs it from the repo root);
// the data folder, the harness and the seed child all use it.
const root = process.cwd();
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(root, ROLES_PROFILE.dataDirName);

try {
  if (mode === "code") {
    // the running roles harness's own store server, from its pid file
    const info = runningHarness(dataDir) ? readPidfile(dataDir) : null;
    const port = info?.ports?.sqld?.tenant;
    if (!port) throw new HarnessError("The roles harness isn't running. Start it with pnpm dev:roles, sign in as the shopper, then run pnpm roles:code.");
    const r = await latestShopperCode({ tenantUrl: dbUrl(port) });
    console.log(r ? `${r.code}  (requested ${r.at})` : "No sign-in code yet. Ask for one on the store's account page first.");
    process.exit(0);
  }
  assertSafeEnv();
  assertNoHarnessRunning(root);
  if (mode === "seed") assertFreshDataDir(dataDir, { reset });
  process.exit(await runHarness({ mode, root, profile: ROLES_PROFILE, reset, seedCmd: [process.execPath, [join(here, "seed-roles.js")]], nextCmd: [process.execPath, [join(here, "../node_modules/next/dist/bin/next"), "dev", join(here, ".."), "-p", String(harnessPorts(process.env, ROLES_PROFILE).next)]] }));
} catch (e) {
  if (e instanceof HarnessError) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  throw e;
}
