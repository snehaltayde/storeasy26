// The roles store (Phase 0 line 5): one local store with every role, on its
// own harness profile so the design harness's .design-data/ is never touched.
//   pnpm seed:roles            fresh store; refuses if .design-data-roles/ holds data
//   pnpm seed:roles --reset    deletes .design-data-roles/ (only it) and seeds again
//   pnpm dev:roles             runs it on http://roles.localhost:3018 (seeds first if no data; deletes nothing)
//   pnpm roles:code            prints the shopper's latest sign-in code (read only; harness running)
//   node scripts/dev-roles.js annex  adds the "Roles Annex" store (annex.localhost) with the
//                              owner as admin and support as support (harness running; line 8)
// Logins: .design-data-roles/roles-seed.json (0600). Ports: ROLES_PORT (web,
// 3018) and ROLES_SQLD_PORT (first of three, 18027). See scripts/seed-roles-store.js.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, dbUrl, harnessEnv, harnessPorts, readPidfile, runHarness, runningHarness } from "./design-harness.js";
import { ROLES_PROFILE, addRolesAnnex, assertFreshDataDir, assertNoHarnessRunning, assertSafeEnv, latestShopperCode } from "./seed-roles-store.js";

const USAGE = "Use: node scripts/dev-roles.js [seed [--reset] | code | annex]";
const args = process.argv.slice(2);
const mode = ["seed", "code", "annex"].includes(args[0]) ? args[0] : args.length ? null : "dev";
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
  if (mode === "annex") {
    // the running roles harness's own servers, from its pid file
    const info = runningHarness(dataDir) ? readPidfile(dataDir) : null;
    const sqld = info?.ports?.sqld;
    if (!sqld?.platform || !sqld?.default) throw new HarnessError("The roles harness isn't running. Start it with pnpm dev:roles, then run node scripts/dev-roles.js annex.");
    // the same environment the running harness gave its servers (PLATFORM_SECRET encrypts the annex's secrets)
    Object.assign(process.env, harnessEnv(process.env, {}, info.ports, { siteHost: ROLES_PROFILE.siteHost }));
    const r = await addRolesAnnex({ platformUrl: dbUrl(sqld.platform), annexUrl: dbUrl(sqld.default), port: info.ports.next });
    console.log(`✓ ${r.store.name} on ${r.store.url}: ${r.members.map((m) => `${m.email} as ${m.role}`).join(", ")}`);
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
