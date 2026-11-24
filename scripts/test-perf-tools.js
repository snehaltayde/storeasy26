// PERF-04 tools: the budget check, the numbers behind the report, the
// database-read counter and the perf fixture. No sqld, no Next, no network:
// the counter runs the real @libsql/client against a stand-in Hrana server on
// 127.0.0.1.
//   pnpm test:perf-tools
// (The measurement itself, scripts/perf-report.js, is not a test and stays
// out of `pnpm test`.)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const B = await import("./perf-budget.js");
const DB = await import("./perf-dbcount.js");
const F = await import("./perf-fixture.js");
const H = await import("./perf-http.js");

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 4).join("\n      ")}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg || "assertion failed");
};
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
const throwsWith = (fn, text) => {
  try {
    fn();
  } catch (e) {
    if (!String(e.message).includes(text)) throw new Error(`threw "${e.message}", expected it to mention "${text}"`);
    return e;
  }
  throw new Error(`did not throw (expected "${text}")`);
};

// A run as perf-report writes it, with only what the checker reads.
const sampleRun = (over = {}) => ({
  kind: "storeasy-perf-baseline",
  environment: { kind: "local" },
  routes: [
    { key: "home", ttfb: { p50: 50, p95: 70 }, total: { p50: 60, p95: 80 }, cold: { ttfb: 400, total: 420 }, bytes: { wire: 200_000, decoded: 200_000 }, db: { warm: { reads: 24, statements: 24, roundTrips: 24, rowsRead: 5000, bytesDown: 60_000 }, first: { reads: 26 } } },
    { key: "product", ttfb: { p50: 30, p95: 35 }, total: { p50: 36, p95: 40 }, cold: { ttfb: 380, total: 400 }, bytes: { wire: 80_000, decoded: 80_000 }, db: { warm: { reads: 10, statements: 10, roundTrips: 10, rowsRead: 1400, bytesDown: 60_000 }, first: { reads: 12 } } },
  ],
  ...over,
});
const budgetFile = (budgets, extra = {}) => B.readBudgetFile(JSON.stringify({ basis: "test", runKind: "local", budgets, ...extra }));

console.log("— numbers");

await t("p95 is the nearest rank: of 50 runs, the 48th fastest; p50 the 25th", () => {
  const v = Array.from({ length: 50 }, (_, i) => 50 - i); // unsorted on purpose
  eq(B.percentile(v, 95), 48, "p95");
  eq(B.percentile(v, 50), 25, "p50");
  eq(B.percentile([7], 95), 7, "one run");
  eq(B.percentile([], 95), null, "no runs");
  eq(B.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10, "p95 of 10 is the 10th");
  eq(B.summarize([3, 1, 2]), { runs: 3, p50: 2, p95: 3, min: 1, max: 3 }, "summary");
});

console.log("— budgets");

await t("a run within every budget passes", () => {
  const r = B.compareToBudget(sampleRun(), budgetFile([{ route: "home", metric: "ttfb.p95", max: 70 }, { route: "product", metric: "db.reads", max: 10 }]));
  eq(r.status, "pass", r.lines.join(" | "));
  ok(r.lines.some((l) => l.includes("TEST BUDGET")), "a test budget says it is not a real budget");
});

await t("NEGATIVE: one number over its budget fails the check, and names it", () => {
  const r = B.compareToBudget(sampleRun(), budgetFile([{ route: "home", metric: "ttfb.p95", max: 69.9 }, { route: "product", metric: "db.reads", max: 10 }]));
  eq(r.status, "fail", "status");
  eq(r.over.map((o) => [o.route, o.metric, o.value]), [["home", "ttfb.p95", 70]], "what was over");
  ok(r.lines.some((l) => l.startsWith("OVER") && l.includes("home ttfb.p95: 70 > 69.9")), r.lines.join(" | "));
});

await t("NEGATIVE: every metric a budget can name is checked (each one, pushed one over, fails)", () => {
  for (const metric of Object.keys(B.METRICS)) {
    const value = B.METRICS[metric](sampleRun().routes[0]);
    ok(Number.isFinite(value), `sample run lacks ${metric}`);
    eq(B.compareToBudget(sampleRun(), budgetFile([{ route: "home", metric, max: value }])).status, "pass", `${metric} at its budget`);
    eq(B.compareToBudget(sampleRun(), budgetFile([{ route: "home", metric, max: value - 0.1 }])).status, "fail", `${metric} over its budget`);
  }
});

await t("NEGATIVE: a budgeted number the run doesn't have fails, never passes", () => {
  const r = B.compareToBudget(sampleRun(), budgetFile([{ route: "search", metric: "ttfb.p95", max: 1e9 }]));
  eq(r.status, "fail", "missing route");
  eq(r.missing.length, 1, "named as missing");
  const noDb = sampleRun();
  delete noDb.routes[0].db.warm.reads;
  eq(B.compareToBudget(noDb, budgetFile([{ route: "home", metric: "db.reads", max: 1e9 }])).status, "fail", "missing metric");
});

await t("NEGATIVE: a budget file that says its numbers came from a local run is refused", () => {
  throwsWith(() => B.readBudgetFile(JSON.stringify({ basis: "local", runKind: "local", budgets: [{ route: "home", metric: "ttfb.p95", max: 100 }] })), "only from hosted numbers");
  throwsWith(() => B.readBudgetFile(JSON.stringify({ runKind: "local", budgets: [{ route: "home", metric: "ttfb.p95", max: 100 }] })), "must say where its budgets come from");
});

await t("NEGATIVE: hosted budgets are not checked against a local run (like with like)", () => {
  const hosted = B.readBudgetFile(JSON.stringify({ basis: "hosted", runKind: "hosted", budgets: [{ route: "home", metric: "ttfb.p95", max: 100 }] }));
  throwsWith(() => B.compareToBudget(sampleRun(), hosted), "for hosted runs, and this run is local");
});

await t("NEGATIVE: malformed budget files are refused with a plain message", () => {
  throwsWith(() => B.readBudgetFile("{not json"), "isn't valid JSON");
  throwsWith(() => B.readBudgetFile(JSON.stringify({ basis: "test", runKind: "local" })), 'needs a "budgets" list');
  throwsWith(() => budgetFile([{ route: "home", metric: "speed", max: 1 }]), 'unknown metric "speed"');
  throwsWith(() => budgetFile([{ route: "home", metric: "ttfb.p95", max: "fast" }]), '"max" must be a number');
  throwsWith(() => budgetFile([{ metric: "ttfb.p95", max: 1 }]), '"route" is missing');
});

await t("an empty budget list is a placeholder: nothing is checked, and it says so", () => {
  const r = B.compareToBudget(sampleRun(), B.readBudgetFile(JSON.stringify({ budgets: [], note: "waiting" })));
  eq(r.status, "not-checked", "status");
  ok(r.lines[0].includes("Nothing was checked"), r.lines[0]);
});

await t("NEGATIVE: the shipped budget file holds no budget; budgets wait for hosted numbers", () => {
  const text = readFileSync(join(ROOT, "docs/perf/budgets.json"), "utf8");
  const b = JSON.parse(text);
  eq(b.budgets, [], "no budgets");
  ok(/hosted/i.test(b.note) && /OQ-19/.test(b.note), "says why");
  eq(B.compareToBudget(sampleRun(), B.readBudgetFile(text)).status, "not-checked", "nothing checked");
});

await t("NEGATIVE: no file in docs/perf claims a budget from local numbers", () => {
  for (const f of readdirSync(join(ROOT, "docs/perf")).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(readFileSync(join(ROOT, "docs/perf", f), "utf8"));
    if (Array.isArray(j.budgets) && j.budgets.length) {
      ok(j.basis === "test" ? /^test-/.test(f) : j.basis === "hosted", `${f} holds budgets with basis ${j.basis}`);
    }
    if (j.kind === "storeasy-perf-baseline") {
      eq(j.environment.kind, "local", `${f} is a local run`);
      ok(/^None\./.test(j.budgets) && /hosted/.test(j.budgets), `${f} must say it sets no budget`);
    }
  }
});

await t("the check command: the test budget fails the committed baseline (exit 1); the placeholder checks nothing (exit 0)", () => {
  const runs = readdirSync(join(ROOT, "docs/perf")).filter((f) => /-local-baseline\.json$/.test(f));
  ok(runs.length, "a committed baseline in docs/perf");
  const run = `docs/perf/${runs.sort().at(-1)}`;
  const check = (budget) => spawnSync(process.execPath, [join(ROOT, "scripts/perf-report.js"), "check", run, "--budget", budget], { cwd: ROOT, encoding: "utf8" });
  const over = check("docs/perf/test-budget.json");
  eq(over.status, 1, `test budget exit code (${over.stdout}${over.stderr})`);
  ok(over.stdout.includes("TEST BUDGET") && /OVER\s+home ttfb\.p95/.test(over.stdout), over.stdout);
  const none = check("docs/perf/budgets.json");
  eq(none.status, 0, `placeholder exit code (${none.stderr})`);
  ok(none.stdout.includes("not checked") && !/within budget/.test(none.stdout), none.stdout);
});

await t("NEGATIVE: library mode's thresholds are printed as local guards, never as budgets", () => {
  const src = readFileSync(join(ROOT, "scripts/perf-report.js"), "utf8");
  ok(!/\(budget /.test(src) && !/budgetMs/.test(src), "perf-report.js still prints a budget");
  ok(/local guard/.test(src), "says local guard");
});

console.log("— counting database reads");

// A stand-in sqld: answers Hrana v2 JSON the way sqld 0.24 does, with the
// rows_read figures sqld adds to each result. gzip when the client asks.
function fakeSqld() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ url: req.url, body });
      if (req.url !== "/v2/pipeline") {
        res.writeHead(404);
        return res.end();
      }
      const reqJson = JSON.parse(body);
      const stmtResult = (sql) => {
        const isRead = /^\s*select/i.test(sql || "");
        return { cols: isRead ? [{ name: "a", decltype: null }] : [], rows: isRead ? [[{ type: "integer", value: "1" }], [{ type: "integer", value: "2" }]] : [], affected_row_count: isRead ? 0 : 1, last_insert_rowid: null, replication_index: "1", rows_read: isRead ? 7 : 0, rows_written: isRead ? 0 : 1, query_duration_ms: 0.5 };
      };
      const stored = new Map();
      const results = reqJson.requests.map((r) => {
        if (r.type === "store_sql") {
          stored.set(r.sql_id, r.sql);
          return { type: "ok", response: { type: "store_sql" } };
        }
        if (r.type === "execute") return { type: "ok", response: { type: "execute", result: stmtResult(r.stmt.sql ?? stored.get(r.stmt.sql_id)) } };
        // Like sqld: a step whose condition is "the earlier step failed" (the
        // client's ROLLBACK after COMMIT) doesn't run, so it has no result.
        if (r.type === "batch") return { type: "ok", response: { type: "batch", result: { step_results: r.batch.steps.map((s) => (s.condition?.type === "not" ? null : stmtResult(s.stmt.sql ?? stored.get(s.stmt.sql_id)))), step_errors: r.batch.steps.map(() => null) } } };
        if (r.type === "get_autocommit") return { type: "ok", response: { type: "get_autocommit", is_autocommit: true } };
        return { type: "ok", response: { type: r.type } };
      });
      const out = Buffer.from(JSON.stringify({ baton: null, base_url: null, results }));
      if (/gzip/.test(req.headers["accept-encoding"] || "")) {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        return res.end(zlib.gzipSync(out));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(out);
    });
  });
  return { server, seen, listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))) };
}
const freePort = () => new Promise((r) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => r(p));
  });
});

await t("statement kinds come from the first keyword, past comments", () => {
  eq(DB.classify("  /* hi */ -- x\n select 1"), "read");
  eq(DB.classify("WITH x AS (SELECT 1) SELECT * FROM x"), "read");
  eq(DB.classify("PRAGMA table_info(products)"), "read");
  eq(DB.classify("insert into t values (1)"), "write");
  eq(DB.classify("UPDATE t SET a = 1"), "write");
  eq(DB.classify("DELETE FROM t"), "write");
  eq(DB.classify("CREATE TABLE t (a)"), "schema");
  eq(DB.classify("BEGIN TRANSACTION READONLY"), "tx");
  eq(DB.classify("COMMIT"), "tx");
  eq(DB.classify(""), "other");
});

await t("the real libSQL client through the proxy: every statement, round trip, row and repeat is counted", async () => {
  const up = fakeSqld();
  const upPort = await up.listen();
  const proxyPort = await freePort();
  const proxy = DB.startCountingProxy({ listenPort: proxyPort, upstreamPort: upPort });
  await proxy.ready;
  const { createClient } = await import("@libsql/client/web");
  const c = createClient({ url: proxy.url });
  try {
    const a = await c.execute({ sql: "SELECT * FROM products WHERE handle = ?", args: ["glow"] });
    eq(a.rows.length, 2, "the client still gets its rows through the proxy");
    await c.execute({ sql: "SELECT * FROM products WHERE handle = ?", args: ["glow"] }); // a true repeat
    await c.execute({ sql: "SELECT * FROM products WHERE handle = ?", args: ["mist"] }); // same shape, other args
    await c.execute({ sql: "INSERT INTO carts (id) VALUES (?)", args: ["c1"] });
    await c.batch(["SELECT 1", "SELECT count(*) FROM variants"], "read");
    await proxy.settle();
    const n = proxy.take();
    eq(n.statements.read, 5, "reads: 3 executes + 2 in the batch");
    eq(n.statements.write, 1, "writes");
    eq(n.statements.tx, 2, "the batch's BEGIN and COMMIT, counted apart; the skipped ROLLBACK isn't counted");
    ok(up.seen.some((s) => /ROLLBACK/.test(s.body)), "the client did send a conditional ROLLBACK");
    eq(n.roundTrips, 5, "one HTTP request per execute, one for the batch");
    eq(n.rowsRead, 5 * 7, "rows_read summed from sqld's answers");
    eq(n.rowsReturned, 5 * 2, "rows sent back");
    eq(n.unparsed, 0, "everything read");
    const dup = DB.repeatedReads(n);
    eq(dup.map((d) => d.times), [2], "one statement ran twice with the same arguments");
    eq(dup[0].shape, "SELECT * FROM products WHERE handle = ?", "named by its shape");
    // P2-PERF fix round 2: each shape's own result bytes, so a route's parsed
    // bytes can be split by statement; the split never exceeds what was parsed
    const per = Object.values(n.shapeBytes);
    eq(Object.keys(n.shapeBytes).length, Object.keys(n.shapes).length, "a byte count for every shape");
    ok(per.every((b) => b > 0), "every shape returned some bytes");
    ok(per.reduce((a, b) => a + b, 0) <= n.bytesDownDecoded, "the split adds up to no more than the bytes parsed");
    ok(n.shapeBytes["READ SELECT * FROM products WHERE handle = ?"] > n.shapeBytes["READ SELECT ?"], "two runs of a two-row read weigh more than one SELECT 1");
    eq(proxy.take().roundTrips, 0, "take() starts again from zero");
    ok(up.seen.some((s) => s.body.includes("store_sql")), "the batch used stored SQL, resolved by id");
  } finally {
    c.close();
    await proxy.close();
    up.server.close();
  }
});

await t("NEGATIVE: a request the proxy can't read is still forwarded and counted, and marked unparsed", async () => {
  const up = fakeSqld();
  const upPort = await up.listen();
  const proxyPort = await freePort();
  const proxy = DB.startCountingProxy({ listenPort: proxyPort, upstreamPort: upPort });
  await proxy.ready;
  try {
    const r = await fetch(`${proxy.url}/v3-protobuf/pipeline`, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: new Uint8Array([0x12, 0x02, 0x10, 0x01]) });
    eq(r.status, 404, "the upstream's answer passes through unchanged");
    await proxy.settle();
    const n = proxy.take();
    eq(n.roundTrips, 1, "counted as a round trip");
    eq(n.unparsed, 1, "and flagged, so a count can't silently come out low");
  } finally {
    await proxy.close();
    up.server.close();
  }
});

await t("NEGATIVE: the proxy changes nothing the app receives (status, headers that matter, body)", async () => {
  const up = fakeSqld();
  const upPort = await up.listen();
  const proxyPort = await freePort();
  const proxy = DB.startCountingProxy({ listenPort: proxyPort, upstreamPort: upPort });
  await proxy.ready;
  try {
    const body = JSON.stringify({ baton: null, requests: [{ type: "execute", stmt: { sql: "SELECT 1", args: [], named_args: [], want_rows: true } }, { type: "close" }] });
    const direct = await fetch(`http://127.0.0.1:${upPort}/v2/pipeline`, { method: "POST", body, headers: { "accept-encoding": "identity" } });
    const viaProxy = await fetch(`${proxy.url}/v2/pipeline`, { method: "POST", body, headers: { "accept-encoding": "identity" } });
    eq(viaProxy.status, direct.status, "status");
    eq(viaProxy.headers.get("content-type"), direct.headers.get("content-type"), "content type");
    eq(await viaProxy.text(), await direct.text(), "body, byte for byte");
  } finally {
    await proxy.close();
    up.server.close();
  }
});

console.log("— the perf fixture");

const fx = F.buildPerfFixture();

await t("the fixture is the same store every time (deterministic, no clock, no randomness)", () => {
  eq(JSON.stringify(F.buildPerfFixture()), JSON.stringify(fx), "two builds differ");
  ok(!/Date\.now\(\)|Math\.random\(\)|new Date\(\)/.test(readFileSync(join(here, "perf-fixture.js"), "utf8")), "perf-fixture.js reads the clock or Math.random");
});

await t("the fixture has the agreed sizes", () => {
  const s = F.fixtureSummary(fx);
  eq(s.products, F.PERF_FIXTURE.products, "products");
  eq(s.collections, 30, "collections");
  eq(s.contentPages, 20, "pages");
  eq(s.journalPosts, 60, "posts");
  eq(s.homeSections, 12, "home sections");
  eq(s.media, 32, "media");
  ok(s.variants >= 1100 && s.variants <= 1200, `variants ${s.variants}`);
  const sizes = fx.collections.map((c) => c.productIds.length);
  eq(sizes[0], 400, "shop-all holds every product");
  ok(Math.min(...sizes) === 8 && sizes.filter((n) => n >= 30 && n <= 80).length >= 10, `collection sizes ${sizes}`);
  for (const p of fx.pages) ok(p.sections.length >= 3 && p.sections.length <= 8, `${p.slug}: ${p.sections.length} sections`);
  for (const p of fx.posts) ok(p.sections.length >= 4 && p.sections.length <= 8, `${p.slug}: ${p.sections.length} sections`);
});

await t("the fixture is internally whole: unique ids and handles, every link and member exists", () => {
  const handles = new Set(fx.products.map((p) => p.handle));
  eq(handles.size, fx.products.length, "product handles unique");
  const variantIds = fx.products.flatMap((p) => p.variants.map((v) => v.id));
  eq(new Set(variantIds).size, variantIds.length, "variant ids unique");
  for (const p of fx.products) {
    const combos = p.variants.map((v) => JSON.stringify(v.selected_options));
    eq(new Set(combos).size, combos.length, `${p.handle}: two variants with the same options`);
    for (const o of p.options) ok(o.values.length >= 1, `${p.handle}: option ${o.name} has no values`);
  }
  const productIds = new Set([...F.DEMO_PRODUCT_IDS, ...fx.products.map((p) => p.id)]);
  for (const c of fx.collections) {
    for (const id of c.productIds) ok(productIds.has(id), `${c.handle} holds an unknown product`);
    eq(new Set(c.productIds).size, c.productIds.length, `${c.handle} lists a product twice`);
  }
  const colHandles = new Set(fx.collections.map((c) => c.handle));
  const pageSlugs = new Set(fx.pages.map((p) => p.slug));
  const linkOk = (href) => (href.startsWith("/collections/") ? colHandles.has(href.split("/")[2]) : href.startsWith("/policies/") ? pageSlugs.has(href.split("/")[2]) : ["/journal", "/collections"].includes(href));
  for (const s of fx.homeSections) {
    if (s.collection) ok(colHandles.has(s.collection), `rail ${s.id} → ${s.collection}`);
    if (s.href) ok(linkOk(s.href), `section ${s.id} → ${s.href}`);
  }
  for (const item of [...fx.navHeader, ...fx.navHeader.flatMap((i) => i.children || []), ...fx.navFooter]) ok(linkOk(item.href), `menu → ${item.href}`);
  const mediaIds = new Set(fx.media.map((m) => `/api/media/${m.id}`));
  for (const p of fx.products) for (const im of p.images) ok(mediaIds.has(im.url), `${p.handle} photo ${im.url}`);
  for (const m of fx.media) ok(/^med_[0-9a-f]{18}$/.test(m.id), `media id ${m.id} must match the media route`);
});

await t("the fixture passes the same validators a founder's saves pass", async () => {
  const { validateOffer } = await import("../lib/offers/validate.js");
  for (const o of fx.offers) eq(validateOffer(o.offer), [], o.offer.id);
  const { validateQuiz } = await import("../lib/quiz.js");
  for (const q of fx.quizzes) ok(validateQuiz(q).ok, q.slug);
});

await t("the measured product has 6 variants and 6 photos, and the cart three lines", () => {
  const p = fx.products.find((x) => x.handle === fx.measured.productHandle);
  eq([p.variants.length, p.images.length], [6, 6], "variants and photos");
  eq(fx.measured.cart.lines.length, 3, "a three-line cart");
});

await t("NEGATIVE: the fixture never talks to Shopify or the network", () => {
  const src = readFileSync(join(here, "perf-fixture.js"), "utf8");
  const imports = [...src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
  eq(imports.filter((m) => /shopify|sync|platform\/|https?|node:net|node:http/i.test(m)), [], "imports Shopify, sync, platform or network code");
  ok(!/\bfetch\(|SHOPIFY_|myshopify\.com|process\.env/.test(src), "makes a network call or reads Shopify settings");
});

await t("NEGATIVE: an unknown fixture is refused with a plain message before any database opens", () => {
  throwsWith(() => F.buildPerfFixture({ name: "huge" }), 'Unknown fixture "huge"');
  const seed = spawnSync(process.execPath, [join(ROOT, "scripts/seed-design-preview.js")], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, DESIGN_FIXTURE: "huge", DESIGN_ADMIN_PASSWORD: "x" } });
  eq(seed.status, 1, `seed exit code (${seed.stderr})`);
  ok(seed.stderr.includes('There is no "huge" fixture'), seed.stderr);
  const cli = spawnSync(process.execPath, [join(ROOT, "scripts/dev-design.js"), "seed", "--fixture", "huge"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, DESIGN_PORT: "3999", DESIGN_SQLD_PORT: "1" } });
  eq(cli.status, 1, `dev-design exit code (${cli.stderr})`);
  ok(cli.stderr.includes('There is no "huge" fixture'), cli.stderr);
  const bad = spawnSync(process.execPath, [join(ROOT, "scripts/dev-design.js"), "seed", "--fixture"], { cwd: ROOT, encoding: "utf8" });
  eq(bad.status, 2, "a --fixture with no name is a usage error");
});

console.log("— the report's own checks");

await t("each measured route is the real page, or the run stops (NEGATIVE: an error page or a wrong page is refused)", () => {
  const routes = H.routesFor(fx.measured);
  eq(routes.map((r) => r.key), ["home", "product", "collection", "collection-all", "collections", "search", "cms-page", "journal", "cart-get", "cart-update", "checkout"], "routes");
  const product = routes.find((r) => r.key === "product");
  eq(H.checkResponse(product, { status: 200, text: `<h1>${fx.measured.productTitle}</h1> Pairs well with` }), null, "the real page passes");
  ok(H.checkResponse(product, { status: 500, text: "" })?.includes("answered 500"), "a 500");
  ok(H.checkResponse(product, { status: 200, text: `<h1>Something went wrong</h1> ${fx.measured.productTitle} Pairs well with` })?.includes("error page"), "a 200 error page");
  ok(H.checkResponse(product, { status: 200, text: "<h1>Another product</h1> Pairs well with" })?.includes("doesn't show"), "the wrong product");
  const cart = routes.find((r) => r.key === "cart-get");
  eq(H.checkResponse(cart, { status: 200, text: JSON.stringify({ items: [1, 2, 3] }) }), null, "a three-line cart");
  ok(H.checkResponse(cart, { status: 200, text: JSON.stringify({ items: [] }) })?.includes("isn't the expected cart"), "an empty cart");
  const checkout = routes.find((r) => r.key === "checkout");
  eq(H.checkResponse(checkout, { status: 200, text: "Contact &amp; shipping address" }), null, "HTML-escaped text matches");
});

await t("the markdown says plainly that these are local numbers, not budgets", () => {
  const runs = readdirSync(join(ROOT, "docs/perf")).filter((f) => /-local-baseline\.json$/.test(f));
  ok(runs.length, "a committed baseline");
  const run = JSON.parse(readFileSync(join(ROOT, "docs/perf", runs.sort().at(-1)), "utf8"));
  const md = H.markdown(run);
  ok(md.includes("Local numbers, not budgets") && md.includes("Edge memory is not measurable locally"), "the warning");
  ok(existsSync(join(ROOT, "docs/perf", runs.sort().at(-1).replace(/\.json$/, ".md"))), "the committed markdown sits next to the JSON");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
