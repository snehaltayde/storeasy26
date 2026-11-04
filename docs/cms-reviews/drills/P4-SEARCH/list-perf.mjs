// P4-SEARCH drill (scratch): listProductContent on the perf seed (the harness's
// p3 store, seeded from the PERF-04 fixture), through the real console API in
// desktop Chrome, timed per call.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const WT = process.argv[2];
const L = await import(pathToFileURL(join(WT, "scripts/drills/p3/lib.mjs")).href);
const code = await L.runDrill({ id: "P4-SEARCH", part: "list-perf", title: "P4-SEARCH — the editor's product list on the perf seed" }, async (drill) => {
  await L.reseed(drill);
  const [n] = await L.storeSql("live", ["SELECT count(*) AS n FROM products"]);
  const products = Number(n.rows[0].n);
  const page = await drill.login("owner");
  const time = (body) =>
    page.evaluate(async (b) => {
      const ms = [];
      let last = null;
      for (let i = 0; i < 25; i++) {
        const t0 = performance.now();
        const r = await fetch("/api/admin/documents", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
        last = { status: r.status, body: await r.json() };
        ms.push(performance.now() - t0);
      }
      ms.sort((x, y) => x - y);
      return { p50: ms[12], p95: ms[23], status: last.status, items: last.body?.items?.length ?? null, counts: last.body?.counts ?? null, next: !!last.body?.nextCursor };
    }, body);
  const first = await time({ listProductContent: { limit: 30 } });
  const q = await time({ listProductContent: { q: "serum", limit: 30 } });
  const changed = await time({ listProductContent: { filter: "changed_in_shopify" } });
  drill.note(`products in the seed: ${products}`);
  drill.note(`first page: ${JSON.stringify(first)}`);
  drill.note(`q=serum: ${JSON.stringify(q)}`);
  drill.note(`changed_in_shopify: ${JSON.stringify(changed)}`);
  drill.check(first.status === 200 && first.items === 30 && first.next && first.counts?.all === products, `the first page answers 30 of ${products} with a cursor and the counts`, first);
  drill.check(first.p95 < 1000 && changed.p95 < 1000, `under a second (first page p50 ${first.p50.toFixed(1)} ms, p95 ${first.p95.toFixed(1)} ms; changed p95 ${changed.p95.toFixed(1)} ms)`, { first, changed });
});
process.exit(code);
