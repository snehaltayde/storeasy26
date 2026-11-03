// GEN-03 drill 7 needs a render error on the edge runtime: a temporary throw in
// the storefront search page, taken out again with git checkout.
//   node scripts/drills/p1/gen03-temp.mjs throw|revert
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FILE = "app/(storefront)/search/page.js";
const mode = process.argv[2];
if (mode === "throw") {
  const p = join(ROOT, FILE);
  const s = readFileSync(p, "utf8");
  const start = "export default async function SearchPage({ searchParams }) {";
  if (!s.includes(start)) throw new Error("search page signature changed");
  writeFileSync(p, s.replace(start, `${start}\n  throw new Error("P1-DRILLS GEN-03 drill 7: temporary throw, reverted after the drill");`));
} else if (mode === "revert") {
  spawnSync("git", ["checkout", "--", FILE], { cwd: ROOT, stdio: "inherit" });
} else {
  console.error("Usage: node scripts/drills/p1/gen03-temp.mjs throw|revert");
  process.exit(2);
}
const diff = spawnSync("git", ["diff", "--stat", "--", "app"], { cwd: ROOT, encoding: "utf8" });
console.log(`git diff --stat -- app: ${diff.stdout.trim() || "(clean)"}`);
