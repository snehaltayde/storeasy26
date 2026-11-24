// An /api/* path with no route answers 404 JSON whatever the store's state
// (Phase 0 line 6: a closed store answered them with its "Opening soon" page).
//   pnpm test:api-unmatched
// No server, no database: the route is called directly. The running-server
// proof (a closed store: unknown /api paths 404 JSON, /api/account still its
// own JSON, pages still the closed page) is pnpm drill:agency-gone.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "app/api/[...unmatched]/route.js";
const R = await import(join(ROOT, FILE));

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.message || e).split("\n").join("\n    ")}`);
  }
}
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};

await t("GET, POST, PUT, PATCH, DELETE and OPTIONS on an unknown /api path answer 404 JSON, never cached", async () => {
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const res = await R[m](new Request(`http://closed.localhost/api/definitely-not-a-route`, { method: m, body: m === "GET" || m === "OPTIONS" ? undefined : "{}" }));
    eq(res.status, 404, `${m} status:`);
    ok(/application\/json/.test(res.headers.get("content-type") || ""), `${m} content-type:`);
    eq(JSON.stringify(await res.json()), '{"error":"not_found"}', `${m} body:`);
    eq(res.headers.get("cache-control"), "no-store", `${m} cache-control:`);
  }
  const head = await R.HEAD(new Request("http://closed.localhost/api/x", { method: "HEAD" }));
  eq(head.status, 404, "HEAD status:");
});

await t("the route reads nothing about the store (no imports): the same answer open or closed, and Edge-safe", async () => {
  const src = readFileSync(join(ROOT, FILE), "utf8");
  ok(!/^\s*import\b|require\(|node:/m.test(src), "no imports, no node:* modules:");
  eq(R.runtime, "edge", "runtime:");
});

await t("real API routes keep their own handlers (/api/account GET and POST); storefront pages keep the closed-store gate and their own catch-all", async () => {
  const account = readFileSync(join(ROOT, "app/api/account/route.js"), "utf8");
  ok(/export const GET = /.test(account) && /export const POST = /.test(account), "/api/account handlers:");
  ok(readFileSync(join(ROOT, "app/(storefront)/layout.js"), "utf8").includes("StoreClosed"), "storefront layout still renders StoreClosed:");
  ok(readFileSync(join(ROOT, "app/(storefront)/[...unmatched]/page.js"), "utf8").includes("notFound()"), "storefront catch-all unchanged:");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
