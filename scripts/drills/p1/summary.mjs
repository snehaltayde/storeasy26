// Every results-<part>.json the P1 drills wrote: counts, failures and known failures.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const base = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "cms-reviews", "drills");
for (const dir of ["DOC-04", "MIG-OVL", "GEN-02", "COM-03", "harness", "ED-01", "AU-05", "SHOP", "GEN-03", "MED-01"]) {
  const d = join(base, dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((x) => /^results-.*\.json$/.test(x)).sort()) {
    const r = JSON.parse(readFileSync(join(d, f), "utf8"));
    console.log(`${dir}/${f}: ${r.passed} passed, ${r.failed} failed, ${r.knownFailures} known${r.aborted ? " ABORTED" : ""}`);
    for (const c of r.checks.filter((c) => !c.ok)) console.log(`   ${c.known ? "KNOWN" : "FAIL"} ${c.label}`);
  }
}
