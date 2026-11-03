// P1-DRILLS harness item "Production build on the harness databases".
//   DESIGN_PORT=3081 DESIGN_SQLD_PORT=18130 node scripts/drills/p1/prod-harness.mjs build
//     next build, with the same env the harness hands Next (hosted keys blanked,
//     local http database URLs). Nothing runs against a database during it.
//   DESIGN_PORT=3081 DESIGN_SQLD_PORT=18130 node scripts/drills/p1/prod-harness.mjs start
//     the harness exactly as pnpm dev:design runs it (local sqld, pid file,
//     refusals), but with `next start` instead of `next dev`.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { HarnessError, ROOT, ensureCredentials, harnessEnv, harnessPorts, runHarness } from "../../design-harness.js";

const mode = process.argv[2];
const nextBin = join(ROOT, "node_modules/next/dist/bin/next");
try {
  if (mode === "build") {
    const ports = harnessPorts(process.env);
    const env = harnessEnv(process.env, ensureCredentials(ROOT), ports);
    const r = spawnSync(process.execPath, [nextBin, "build"], { cwd: ROOT, env, stdio: "inherit" });
    process.exit(r.status ?? 1);
  } else if (mode === "start") {
    const ports = harnessPorts(process.env);
    process.exit(await runHarness({ mode: "dev", nextCmd: [process.execPath, [nextBin, "start", "-p", String(ports.next)]] }));
  } else {
    console.error("Usage: node scripts/drills/p1/prod-harness.mjs build|start");
    process.exit(2);
  }
} catch (e) {
  if (e instanceof HarnessError) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  throw e;
}
