// P1-DRILLS-C: one line per results-c-*.json (passed, failed, known, aborted).
//   node scripts/drills/p1c/summary.mjs [item ...]
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "cms-reviews", "drills");
const items = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(root);
for (const item of items) {
  const dir = join(root, item);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => /^results-c-.*\.json$/.test(x)).sort()) {
    const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const fails = r.checks.filter((c) => !c.ok && !c.known).map((c) => c.label);
    console.log(`${item}/${f}: ${r.passed} passed, ${r.failed} failed${r.knownFailures ? `, ${r.knownFailures} known` : ""}${r.aborted ? " (ABORTED)" : ""} [${r.ranAt}]`);
    for (const l of fails) console.log(`    FAIL ${l}`);
    if (r.aborted) console.log(`    ${r.aborted.split("\n")[0]}`);
  }
}
