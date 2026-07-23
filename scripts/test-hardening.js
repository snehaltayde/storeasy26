// Session 17 — hardening tests: rate limiter math + error-tracking sink.
//   node scripts/test-hardening.js          (pnpm test:hardening)
// Isolated: throwaway libSQL file + local alert catcher; no network.
import { rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-hardening.db";

const here = dirname(fileURLToPath(import.meta.url));
await rm(join(here, "../.test-hardening.db"), { force: true });

const alerts = [];
const catcher = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    alerts.push(JSON.parse(body));
    res.writeHead(200).end("{}");
  });
});
await new Promise((r) => catcher.listen(0, "127.0.0.1", r));
process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${catcher.address().port}/alert`;

const { libsql } = await import("../lib/db.js");
await libsql.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
const { rateLimit } = await import("../lib/rate-limit.js");
const { captureError, errorFingerprint, errorStats } = await import("../lib/errors.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label || "expected truthy");
};

const req = (ip) => new Request("http://x/api/test", { headers: { "x-forwarded-for": ip } });

// --- rate limiter -----------------------------------------------------------
await t("limiter: allows up to the budget, then 429 with Retry-After", async () => {
  for (let i = 0; i < 5; i++) eq(rateLimit(req("1.1.1.1"), { name: "t1", limit: 5 }), null, `req ${i + 1}`);
  const r = rateLimit(req("1.1.1.1"), { name: "t1", limit: 5 });
  ok(r instanceof Response, "429 response");
  eq(r.status, 429, "status");
  ok(Number(r.headers.get("Retry-After")) >= 1, "Retry-After");
  eq(r.headers.get("X-RateLimit-Limit"), "5", "limit header");
});

await t("limiter: keys are per-ip + per-route", async () => {
  eq(rateLimit(req("2.2.2.2"), { name: "t1", limit: 5 }), null, "other ip unaffected");
  eq(rateLimit(req("1.1.1.1"), { name: "t2", limit: 5 }), null, "other route unaffected");
});

await t("limiter: window resets", async () => {
  for (let i = 0; i < 3; i++) rateLimit(req("3.3.3.3"), { name: "t3", limit: 3, windowMs: 120 });
  ok(rateLimit(req("3.3.3.3"), { name: "t3", limit: 3, windowMs: 120 }) instanceof Response, "over budget");
  await new Promise((r) => setTimeout(r, 150));
  eq(rateLimit(req("3.3.3.3"), { name: "t3", limit: 3, windowMs: 120 }), null, "fresh window");
});

await t("limiter: env override + kill switch", async () => {
  process.env.RATE_LIMIT_T4 = "1";
  eq(rateLimit(req("4.4.4.4"), { name: "t4", limit: 100 }), null, "first ok");
  ok(rateLimit(req("4.4.4.4"), { name: "t4", limit: 100 }) instanceof Response, "env tightened to 1");
  delete process.env.RATE_LIMIT_T4;
  process.env.RATE_LIMIT_DISABLED = "1";
  for (let i = 0; i < 20; i++) eq(rateLimit(req("4.4.4.4"), { name: "t4", limit: 1 }), null, "disabled");
  delete process.env.RATE_LIMIT_DISABLED;
});

// --- error tracking ---------------------------------------------------------
const { db } = await import("../lib/db.js");
const rowByFp = (fp) => db.selectFrom("app_errors").selectAll().where("fingerprint", "=", fp).executeTakeFirst();

// One error instance reused = one code location throwing repeatedly (the
// real-world shape; the fingerprint includes the top stack frame by design).
const boom = new Error("boom in checkout");

await t("capture: new error → row + ONE alert", async () => {
  const before = alerts.length;
  const r = await captureError({ source: "server", error: boom, url: "/api/checkout" });
  const row = await rowByFp(r.fingerprint);
  eq(row.count, 1, "count");
  eq(row.source, "server", "source");
  await new Promise((res) => setTimeout(res, 50));
  eq(alerts.length - before, 1, "one alert");
  ok(alerts[alerts.length - 1].subject.includes("boom in checkout"), "alert subject");
});

await t("capture: repeat within the throttle window → count++ but NO new alert", async () => {
  const before = alerts.length;
  const r = await captureError({ source: "server", error: boom, url: "/api/checkout" });
  eq((await rowByFp(r.fingerprint)).count, 2, "count bumped");
  await new Promise((res) => setTimeout(res, 50));
  eq(alerts.length - before, 0, "no alert flood");
});

await t("capture: alert again once the throttle window elapses", async () => {
  process.env.ERRORS_ALERT_EVERY_MS = "1";
  const before = alerts.length;
  await captureError({ source: "server", error: boom });
  await new Promise((res) => setTimeout(res, 50));
  ok(alerts.length - before >= 1, "re-alerted after window");
  process.env.ERRORS_ALERT_EVERY_MS = String(60 * 60_000);
});

await t("fingerprint: order ids + numbers normalized (one bug ≠ many rows)", async () => {
  const a = errorFingerprint({ source: "server", name: "Error", message: "push failed for BL-12345678 after 3 tries" });
  const b = errorFingerprint({ source: "server", name: "Error", message: "push failed for BL-ABCDEF01 after 250 tries" });
  eq(a, b, "same fingerprint");
  const c = errorFingerprint({ source: "client", name: "Error", message: "push failed for BL-12345678 after 3 tries" });
  ok(a !== c, "source distinguishes");
});

await t("capture: different error → separate fingerprint + its own alert", async () => {
  const before = alerts.length;
  const r = await captureError({ source: "client", error: { name: "TypeError", message: "x is not a function", stack: "at foo (app.js:1:1)" } });
  eq((await rowByFp(r.fingerprint)).count, 1, "own row");
  await new Promise((res) => setTimeout(res, 50));
  eq(alerts.length - before, 1, "own alert");
});

await t("capture never throws (garbage input, tracker self-protection)", async () => {
  const r1 = await captureError({ source: "server", error: null });
  ok(r1.fingerprint || r1.failed, "null error handled");
  const circular = {};
  circular.self = circular;
  const r2 = await captureError({ source: "server", error: { message: "weird", extra: circular } });
  ok(r2.fingerprint || r2.failed, "circular-adjacent input handled");
});

await t("errorStats: recent view for health", async () => {
  const s = await errorStats({ sinceHours: 1 });
  ok(s.distinct >= 2, "captures visible");
  ok(s.recent[0].message, "rows have messages");
});

console.log(`\n${pass} passed, ${fail} failed`);
catcher.close();
await rm(join(here, "../.test-hardening.db"), { force: true });
process.exit(fail ? 1 : 0);
