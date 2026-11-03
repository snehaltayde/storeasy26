// ED-01 B7/B8 need a temporary edit in the designer pages (the packet's own
// method): a 4 s delay (B7) or a throw (B8). This puts one in, or takes every
// such edit out again with git checkout, and checks app/ is clean.
//   node scripts/drills/p1/ed01-temp.mjs delay|throw|revert
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOME = "app/(console)/admin/(authed)/storefront/designer/page.js";
const PRODUCT = "app/(console)/admin/(authed)/storefront/designer/product/page.js";
const mode = process.argv[2];

function insert(file, fnStart, line) {
  const p = join(ROOT, file);
  const s = readFileSync(p, "utf8");
  const i = s.indexOf(fnStart);
  if (i < 0) throw new Error(`no ${fnStart} in ${file}`);
  const j = s.indexOf("{", i) + 1;
  writeFileSync(p, `${s.slice(0, j)}\n  ${line}${s.slice(j)}`);
}

if (mode === "delay") {
  insert(HOME, "export default async function StorefrontDesignerPage()", "await new Promise((r) => setTimeout(r, 4000)); // P1-DRILLS ED-01 B7: temporary delay, reverted after the drill");
  insert(PRODUCT, "export default async function ProductDesignerPage()", "await new Promise((r) => setTimeout(r, 4000)); // P1-DRILLS ED-01 B7: temporary delay, reverted after the drill");
} else if (mode === "throw") {
  insert(HOME, "export default async function StorefrontDesignerPage()", 'throw new Error("P1-DRILLS ED-01 B8: temporary throw, reverted after the drill");');
} else if (mode === "revert") {
  spawnSync("git", ["checkout", "--", HOME, PRODUCT], { cwd: ROOT, stdio: "inherit" });
} else {
  console.error("Usage: node scripts/drills/p1/ed01-temp.mjs delay|throw|revert");
  process.exit(2);
}
const diff = spawnSync("git", ["diff", "--stat", "--", "app"], { cwd: ROOT, encoding: "utf8" });
console.log(`git diff --stat -- app: ${diff.stdout.trim() || "(clean)"}`);
