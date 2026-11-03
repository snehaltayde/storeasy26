// Summarise the drill:edge runs kept under docs/cms-reviews/drills/harness/.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "cms-reviews", "drills", "harness");
const pick = process.argv[2] || "edge-run-";
for (const f of readdirSync(dir).filter((x) => x.startsWith(pick) && x.endsWith(".json")).sort()) {
  const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const title = (r.notes.find((n) => n.startsWith("Designer preview hero title")) || "").replace(/ \(draft title.*$/, "");
  const exp = r.notes.find((n) => n.startsWith("Experiment exposures")) || "";
  const contrast = r.notes.find((n) => n.startsWith("maintenance: the founder")) || "";
  const known = r.checks.filter((c) => !c.ok && c.known).map((c) => `${c.known}: ${c.label.slice(0, 50)}`);
  const failed = r.checks.filter((c) => !c.ok && !c.known).map((c) => c.label);
  console.log(`${f} ranAt ${r.ranAt} passed ${r.passed} failed ${r.failed} known ${r.knownFailures}`);
  console.log(`  ${title}`);
  console.log(`  ${exp}`);
  console.log(`  ${contrast}`);
  if (failed.length) console.log(`  FAILED: ${failed.join(" | ")}`);
  console.log(`  known: ${known.length}`);
}
