// Plugin webhooks (Phase 4 line 3, docs/plans/phase-4.md "Line 3").
//   pnpm test:plugin-webhooks
// Signing (the Standard Webhooks reference vector, two signatures during a
// rotation), the egress guard (every blocked range, a DNS answer mixing public
// and private addresses, IPv4-mapped IPv6, a redirect, port 8443, IP-literal,
// Shopify and off-allowlist hosts, the local flag refused in production),
// custom apps through the routes as every caller, the outbox end to end
// (order.created from runOrderEffects to a local receiver that checks the
// signature), no duplicate on a replayed emit or a re-run job, the retry
// schedule, the 410 pause and the 72 h auto-pause, Skipped for an app that is
// off, Resend, the fixture first-party handler, no customer details in any
// payload, pruning, the export, and that egress.js and deliveries.js are
// unreachable from the storefront and components/. Every database is a
// throwaway file: database; the only network is a receiver on 127.0.0.1.
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import http from "node:http";
import { createHmac } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-plwh-default.db";
process.env.PLATFORM_SECRET = "test-plwh-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.STOREASY_PLUGIN_EGRESS_LOCAL = "1";
process.env.NODE_ENV = "test"; // the local flag works only under test or development
const network = H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack && !e.message ? e.stack : e.message).split("\n").join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

const SIGN = await import("../lib/plugins/sign.js");
const EG = await import("../lib/plugins/egress.js");
const HOSTS = await import("../lib/plugins/hosts.js");
const TOP = await import("../lib/plugins/topics.js");
const M = await import("../lib/plugins/manifest.js");
const CAT = await import("../lib/plugins/catalog.js");
const HANDLERS = await import("../lib/plugins/handlers.js");
const { listAudit } = await import("../lib/platform/audit.js");

// --- a receiver on 127.0.0.1 --------------------------------------------------------
const got = [];
let answer = { status: 200 };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    got.push({ url: req.url, headers: req.headers, body });
    const h = answer.location ? { location: answer.location } : {};
    res.writeHead(answer.status, h);
    res.end("x".repeat(answer.bytes ?? 2));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const HOOK = `http://127.0.0.1:${PORT}/hooks`;
const sigOf = (secret, id, ts, body) => `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;

// --- signing -------------------------------------------------------------------------
await t("signing: the Standard Webhooks reference vector; whsec_ + 32 bytes; two secrets give two signatures", async () => {
  eq(await SIGN.signPayload("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}'), "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=", "known answer:");
  const s1 = SIGN.newSigningSecret();
  const s2 = SIGN.newSigningSecret();
  ok(SIGN.SECRET_RE.test(s1) && Buffer.from(s1.slice(6), "base64").length === 32 && s1 !== s2, "secret format");
  const h = await SIGN.webhookHeaders({ id: "dlv_1", timestamp: 100, body: "{}", secrets: [s1, s2] });
  eq(h["webhook-signature"], `${sigOf(s1, "dlv_1", 100, "{}")} ${sigOf(s2, "dlv_1", 100, "{}")}`, "two signatures:");
  eq(h["webhook-id"], "dlv_1", "id:");
  eq(h["webhook-timestamp"], "100", "timestamp:");
});

// --- the egress guard ----------------------------------------------------------------
const PROD = { NODE_ENV: "production", STOREASY_PLUGIN_EGRESS_LOCAL: "1" };
const NOFLAG = { NODE_ENV: "test" };
await t("egress URL rules: https and port 443 only, no user:pass, no IP literal or private name, no Shopify, allowlist only", () => {
  const allow = ["hooks.example.com"];
  ok(EG.checkUrl("https://hooks.example.com/x?y=1", { allowHosts: allow, env: NOFLAG }).ok, "a good address");
  ok(EG.checkUrl("https://HOOKS.example.com./x", { allowHosts: allow, env: NOFLAG }).ok, "case and trailing dot");
  const refused = [
    "http://hooks.example.com/x",
    "https://hooks.example.com:8443/x",
    "https://hooks.example.com:80/x",
    "https://u:p@hooks.example.com/x",
    "https://1.2.3.4/x",
    "https://[::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://0x7f.1/x",
    "https://2130706433/x",
    "https://localhost/x",
    "https://a.localhost/x",
    "https://printer.local/x",
    "https://db.internal/x",
    "https://nas.home.arpa/x",
    "https://intranet/x",
    "https://shop.myshopify.com/x",
    "https://shopify.com/x",
    "https://admin.shopify.com/x",
    "ftp://hooks.example.com/x",
    "not a url",
  ];
  for (const u of refused) {
    const host = (() => {
      try {
        return new URL(u).hostname;
      } catch {
        return "x";
      }
    })();
    const r = EG.checkUrl(u, { allowHosts: [...allow, host], env: NOFLAG });
    ok(!r.ok && r.reason, `refused even when allowlisted: ${u}`);
  }
  ok(!EG.checkUrl("https://other.example.com/x", { allowHosts: allow, env: NOFLAG }).ok, "off the allowlist");
  // octal, hex and dotless forms become an IPv4 literal; full-width and IDN names are normalised first
  for (const u of ["https://0177.0.0.1/x", "https://0177.1/x", "https://0x7f000001/x", "https://017700000001/x", "https://ｌｏｃａｌｈｏｓｔ/x", "https://１２７．０．０．１/x", "https://shop．myshopify．com/x"]) ok(!EG.checkUrl(u, { allowHosts: [new URL(u).hostname], env: NOFLAG }).ok, `refused: ${u}`);
  const idn = EG.checkUrl("https://bücher.example/x", { allowHosts: ["xn--bcher-kva.example"], env: NOFLAG });
  ok(idn.ok && idn.host === "xn--bcher-kva.example", "an IDN host is checked (and allowlisted) as its punycode");
  ok(!EG.checkUrl("https://bücher.example/x", { allowHosts: ["bücher.example"], env: NOFLAG }).ok, "the Unicode spelling is not what is approved");
  ok(HOSTS.isShopifyHost("x.MyShopify.com"), "shopify host");
});

await t("egress local flag: 127.0.0.1 only, only with STOREASY_PLUGIN_EGRESS_LOCAL=1 under NODE_ENV test or development, never on Vercel", () => {
  const allow = ["127.0.0.1"];
  const LOCAL = (extra) => ({ STOREASY_PLUGIN_EGRESS_LOCAL: "1", ...extra });
  ok(EG.checkUrl(HOOK, { allowHosts: allow, env: LOCAL({ NODE_ENV: "test" }) }).ok, "test");
  ok(EG.checkUrl(HOOK, { allowHosts: allow, env: LOCAL({ NODE_ENV: "development" }) }).ok, "development");
  ok(!EG.checkUrl(HOOK, { allowHosts: allow, env: LOCAL({}) }).ok, "NODE_ENV unset: refused");
  ok(!EG.checkUrl(HOOK, { allowHosts: allow, env: LOCAL({ NODE_ENV: "staging" }) }).ok, "any other NODE_ENV: refused");
  ok(!EG.checkUrl(HOOK, { allowHosts: allow, env: NOFLAG }).ok, "flag off");
  ok(!EG.checkUrl(HOOK, { allowHosts: allow, env: PROD }).ok, "production ignores the flag");
  ok(!EG.checkUrl(HOOK, { allowHosts: allow, env: LOCAL({ NODE_ENV: "development", VERCEL_ENV: "preview" }) }).ok, "a Vercel preview ignores the flag");
  ok(!EG.checkUrl(HOOK, { allowHosts: allow, env: LOCAL({ NODE_ENV: "test", VERCEL: "1" }) }).ok, "VERCEL set ignores the flag");
  ok(!EG.localEgressAllowed(PROD) && !EG.localEgressAllowed(LOCAL({})) && EG.localEgressAllowed(LOCAL({ NODE_ENV: "test" })), "localEgressAllowed");
  ok(!EG.checkUrl(`http://127.0.0.2:${PORT}/x`, { allowHosts: ["127.0.0.2"], env: LOCAL({ NODE_ENV: "test" }) }).ok, "only 127.0.0.1");
});

await t("blocked addresses: every listed range (v4 and v6), IPv4-mapped and -compatible forms; public addresses pass", () => {
  const inside = (a) => a.replace(/\.0$/, ".1");
  for (const [a] of EG.BLOCKED_V4) ok(EG.isBlockedAddress(a) && EG.isBlockedAddress(inside(a)), `v4 ${a}`);
  for (const [a] of EG.BLOCKED_V6) ok(EG.isBlockedAddress(a), `v6 ${a}`);
  for (const a of ["10.255.255.255", "100.127.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "198.19.0.1", "255.255.255.255", "fd12::1", "fe80::1%en0", "ff02::1", "2001:db8::9", "64:ff9b::a00:1"]) ok(EG.isBlockedAddress(a), `blocked ${a}`);
  for (const a of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:c0a8:0101", "::127.0.0.1"]) ok(EG.isBlockedAddress(a), `mapped ${a}`);
  // review additions: NAT64 local-use, 6to4 carrying a private IPv4, Teredo, SIIT, discard-only, site-local, IPv4-compatible small values
  for (const a of ["64:ff9b:1::a00:1", "64:ff9b:1:ffff::1", "2002:7f00:1::1", "2002:0a00:0001::1", "2002:c0a8:0101::", "2001:0:4136:e378::1", "2001::1", "::ffff:0:127.0.0.1", "::ffff:0:a00:1", "100::1", "100::ffff:ffff:ffff:ffff", "fec0::1", "feff::1", "::2", "::ff", "::0.0.0.2", "::8.8.8.8"]) ok(EG.isBlockedAddress(a), `blocked ${a}`);
  for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "::ffff:0:8.8.8.8", "2002:0808:0808::1", "2001:4860:4860::8888", "100:0:0:1::1"]) ok(!EG.isBlockedAddress(a), `public ${a}`);
  ok(EG.isBlockedAddress("not-an-ip") && EG.isBlockedAddress(""), "fail closed");
});

const realLookup = EG.egressDns.lookup;
const fakeDns = (answers) => {
  EG.egressDns.lookup = (host, opts, cb) => (opts.all ? cb(null, answers) : cb(null, answers[0].address, answers[0].family));
};
const lookup = (opts) => new Promise((res) => EG.guardedLookup("hooks.example.com", opts, (err, a, f) => res({ err, a, f })));

await t("guarded lookup: any private address in the answer fails the connection, for all: true, all: false and a family number", async () => {
  try {
    fakeDns([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    for (const opts of [{ all: true }, {}, 4]) eq((await lookup(opts)).err?.code, "EGRESS_BLOCKED", `mixed ${JSON.stringify(opts)}:`);
    fakeDns([{ address: "2606:4700::1", family: 6 }, { address: "::ffff:192.168.0.1", family: 6 }]);
    eq((await lookup({ all: true })).err?.code, "EGRESS_BLOCKED", "mapped in the answer:");
    fakeDns([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1", family: 6 }]);
    const all = await lookup({ all: true });
    ok(!all.err && Array.isArray(all.a) && all.a.length === 2, "all: true gets the list");
    const one = await lookup({});
    ok(!one.err && one.a === "93.184.216.34" && one.f === 4, "all: false gets one address");
  } finally {
    EG.egressDns.lookup = realLookup;
  }
});

await t("safeFetch: a name resolving to 127.0.0.1 never connects; a redirect is not followed; the response read stops at 4 KB", async () => {
  try {
    fakeDns([{ address: "127.0.0.1", family: 4 }]);
    const before = got.length;
    const r = await EG.safeFetch("https://rebind.example.com/hooks", { allowHosts: ["rebind.example.com"], body: "{}" });
    ok(!r.ok && r.refused && /private/.test(r.error), `refused: ${JSON.stringify(r)}`);
    eq(got.length, before, "no request reached the receiver:");
  } finally {
    EG.egressDns.lookup = realLookup;
  }
  answer = { status: 302, location: `http://127.0.0.1:${PORT}/elsewhere` };
  const n = got.length;
  const r = await EG.safeFetch(HOOK, { allowHosts: ["127.0.0.1"], body: "{}" });
  eq(r.status, 302, "status:");
  ok(!r.ok && /Redirect/.test(r.error), "a redirect is a failure");
  eq(got.length, n + 1, "one request only:");
  ok(!got.some((g) => g.url === "/elsewhere"), "never followed");
  answer = { status: 200, bytes: 100_000 };
  const big = await EG.safeFetch(HOOK, { allowHosts: ["127.0.0.1"], body: "{}" });
  ok(big.ok && big.status === 200, "a big answer still counts");
  answer = { status: 200 };
  const off = await EG.safeFetch("https://hooks.example.com:8443/x", { allowHosts: ["hooks.example.com"] });
  ok(off.refused && /443/.test(off.error), "port 8443 refused before connecting");
});

await t("safeFetch timeouts: 5 s to connect and 10 s in all by default; a trickled answer is cut at the total", async () => {
  eq(EG.CONNECT_TIMEOUT_MS, 5000, "connect:");
  eq(EG.TIMEOUT_MS, 10000, "total:");
  const trickle = http.createServer((req, res) => {
    res.writeHead(200);
    const iv = setInterval(() => res.write("."), 100);
    res.on("close", () => clearInterval(iv));
  });
  await new Promise((r) => trickle.listen(0, "127.0.0.1", r));
  try {
    const t0 = Date.now();
    const r = await EG.safeFetch(`http://127.0.0.1:${trickle.address().port}/slow`, { allowHosts: ["127.0.0.1"], body: "{}", timeoutMs: 600 });
    ok(!r.ok && /in time/.test(r.error || ""), `timed out: ${JSON.stringify(r)}`);
    ok(Date.now() - t0 < 3000, "stopped at the total, not when the body ended");
  } finally {
    trickle.close();
    trickle.closeAllConnections?.();
  }
});

await t("safeFetch reads at most 4 KB: an answer that never ends still settles at once", async () => {
  let wrote = 0;
  const endless = http.createServer((req, res) => {
    res.writeHead(200);
    const chunk = "y".repeat(1024);
    const iv = setInterval(() => {
      if (!res.write(chunk)) return;
      wrote += chunk.length;
    }, 5);
    res.on("close", () => clearInterval(iv));
  });
  await new Promise((r) => endless.listen(0, "127.0.0.1", r));
  try {
    const t0 = Date.now();
    const r = await EG.safeFetch(`http://127.0.0.1:${endless.address().port}/big`, { allowHosts: ["127.0.0.1"], body: "{}", timeoutMs: 8000 });
    ok(r.ok && r.status === 200, `ok: ${JSON.stringify(r)}`);
    ok(Date.now() - t0 < 2000, `settled after the cap (${Date.now() - t0} ms), not at the timeout`);
    await new Promise((res) => setTimeout(res, 300));
    const after = wrote;
    await new Promise((res) => setTimeout(res, 300));
    ok(wrote === after, "the connection was dropped: nothing more was written");
  } finally {
    endless.close();
    endless.closeAllConnections?.();
  }
});

await t("manifest events and egress: unknown events, a missing scope, IP / Shopify / private egress hosts are refused", () => {
  const base = { id: "x-ev", name: "X", version: "1.0.0", summary: "s", description: "d", icon: "Puzzle", author: { name: "a" }, scopes: ["orders.read"], settings: [] };
  eq(M.checkManifest({ ...base, events: ["order.created", "order.fulfilled"], egress: ["api.example.com"] }).join(","), "", "good:");
  const bad = (patch, word) => ok(M.checkManifest({ ...base, ...patch }).some((p) => p.includes(word)), `${JSON.stringify(patch)} → ${word}`);
  bad({ events: ["order.deleted"] }, "unknown event");
  bad({ events: ["ping"] }, "unknown event");
  bad({ scopes: [], events: ["order.created"] }, "needs the orders.read");
  for (const h of ["10.0.0.1", "api.shopify.com", "x.myshopify.com", "localhost", "x.internal", "API.example.com"]) bad({ egress: [h] }, "egress host");
});

// --- the stores ----------------------------------------------------------------------
const store = await H.makeRoleStore({ name: "plwh" });
const { a, b, call, users } = store;
const hostB = b.tenant.domains[0];
const MERCHANT = ["owner", "admin", "staff", "support"];
const OPS = ["operator-support", "operator-support-entry"];
const { db } = await import("../lib/db.js");
const inA = (fn) => a.run(fn);
const E = await import("../lib/plugins/events.js");
const D = await import("../lib/plugins/deliveries.js");
const { getJobByKey, makeJobDue } = await import("../lib/platform/jobs.js");
const { runJobById } = await import("../lib/platform/worker.js");
const auditRows = async () => listAudit({ tenantId: a.id, limit: 200 });
const custom = (over = {}) => ({ create_custom: { name: "Order hooks", url: HOOK, topics: ["order.created", "order.fulfilled"], scopes: ["orders.read"], ...over } });

// an order with customer details that must never leave
const PII = { email: "plwhbuyer@example.test", phone: "9876512345", name: "Plwhname Buyer", address_line1: "12 Plwhaddr Road", city: "Plwhcity", pincode: "560999" };
let orderN = 0;
async function makeOrder({ status = "cod_pending", items = 2 } = {}) {
  const id = `BL-PLWH${String(++orderN).padStart(4, "0")}`;
  const now = new Date().toISOString();
  await inA(async () => {
    await db.insertInto("orders").values({ id, ...PII, state: "KA", country: "IN", subtotal: 500, discount_total: 0, shipping_total: 0, total: 500, currency: "INR", payment_method: "cod", payment_status: "cod", status, snapshot: JSON.stringify({ contact: { email: PII.email } }), created_at: now, updated_at: now }).execute();
    for (let i = 0; i < items; i++) await db.insertInto("order_items").values({ order_id: id, variant_id: `v${i}`, product_id: `p${i}`, title: `Item ${i}`, variant_title: "M", unit_price: 250, quantity: 1, line_total: 250, line_discount: 0, position: i }).execute();
  });
  return id;
}
const runJob = async (key) => {
  const job = await getJobByKey(key);
  ok(job, `a job ${key}`);
  return runJobById(job.id);
};
const deliveriesOf = (installId) => inA(() => db.selectFrom("plugin_deliveries").selectAll().where("install_id", "=", installId).orderBy("created_at", "asc").execute());
const noPii = (text, label) => {
  for (const v of Object.values(PII)) ok(!String(text).toLowerCase().includes(String(v).toLowerCase()), `${label}: no ${v}`);
};

await t("signed out and another store's owner: 401 on the webhooks routes and create_custom", async () => {
  for (const caller of ["signed-out", "owner-b"]) {
    eq((await call(caller, "apps", "POST", { body: custom() })).status, 401, `${caller} create:`);
    eq((await call(caller, "apps/[id]/webhooks", "GET", { params: { id: "pin_0000000000000000" } })).status, 401, `${caller} GET:`);
    eq((await call(caller, "apps/[id]/webhooks", "POST", { params: { id: "pin_0000000000000000" }, body: { pause: true } })).status, 401, `${caller} POST:`);
  }
});

await t("create_custom: staff, support and operator support get 403 and nothing is made", async () => {
  for (const caller of ["staff", "support", ...OPS]) eq((await call(caller, "apps", "POST", { body: custom() })).status, 403, `${caller}:`);
  eq((await call("owner", "apps", "GET")).body.installs.length, 0, "none:");
});

await t("create_custom refusals (422): no name, no topics, an unknown topic, customers.read (not offered), missing orders.read, http / IP / Shopify / private address", async () => {
  const refuse = async (over, field) => {
    const r = await call("owner", "apps", "POST", { body: custom(over) });
    eq(r.status, 422, `${JSON.stringify(over)}:`);
    ok(r.body.errors?.[field], `${JSON.stringify(over)} → errors.${field}`);
  };
  await refuse({ name: " " }, "name");
  await refuse({ topics: [] }, "topics");
  await refuse({ topics: ["order.deleted"] }, "topics");
  await refuse({ topics: ["ping"] }, "topics");
  await refuse({ scopes: ["orders.read", "customers.read"] }, "scopes");
  await refuse({ scopes: [] }, "scopes");
  for (const url of ["http://hooks.example.com/x", "https://10.0.0.1/x", "https://shop.myshopify.com/x", "https://x.internal/x", "https://hooks.example.com:8443/x"]) await refuse({ url }, "url");
  eq((await call("owner", "apps", "GET")).body.installs.length, 0, "none:");
});

let appId;
let secret;
await t("create_custom: a custom install and endpoint; the whsec_ secret is answered once; audit without it; GET never shows it", async () => {
  const r = await call("owner", "apps", "POST", { body: custom() });
  eq(r.status, 200, `create: ${r.text.slice(0, 200)}`);
  ok(SIGN.SECRET_RE.test(r.body.secret), "secret");
  ({ secret } = r.body);
  appId = r.body.install.id;
  eq(r.body.install.kind, "custom", "kind:");
  ok(/^custom:[0-9a-f]{16}$/.test(r.body.install.pluginId), "plugin id");
  eq(r.body.install.available, true, "available:");
  const ep = await inA(() => db.selectFrom("plugin_endpoints").selectAll().where("install_id", "=", appId).executeTakeFirst());
  eq(ep.host, "127.0.0.1", "approved host:");
  ok(ep.secret_enc && !ep.secret_enc.includes(secret), "stored encrypted");
  const row = (await auditRows()).find((x) => x.action === "apps.create_custom");
  ok(row && row.resource === `app:${appId}` && !String(row.diff).includes(secret.slice(6)), "audit row without the secret");
  for (const caller of [...MERCHANT, ...OPS]) {
    const g = await call(caller, "apps/[id]/webhooks", "GET", { params: { id: appId } });
    eq(g.status, 200, `${caller} GET:`);
    ok(!g.text.includes(secret.slice(6)) && !g.text.includes("secret_enc") && !g.text.includes(ep.secret_enc.slice(-20)), `${caller}: no secret`);
    eq(g.body.endpoint.url, caller === "support" || OPS.includes(caller) ? `http://127.0.0.1:${PORT}/…` : HOOK, `${caller} url:`);
    eq(g.body.endpoint.status, "active", `${caller} status:`);
    const d = await call(caller, "apps/[id]", "GET", { params: { id: appId } });
    eq(d.status, 200, `${caller} detail:`);
    eq(d.body.plugin.scopes[0].scope, "orders.read", `${caller} detail scopes:`);
  }
});

await t("webhooks POST: staff, support and operator support get 403 on every variant; nothing changes", async () => {
  const variants = [{ endpoint: { url: HOOK } }, { rotate_secret: true }, { test: true }, { pause: true }, { resume: true }, { resend: "dlv_0000000000000000" }];
  for (const caller of ["staff", "support", ...OPS]) for (const body of variants) eq((await call(caller, "apps/[id]/webhooks", "POST", { params: { id: appId }, body })).status, 403, `${caller} ${Object.keys(body)[0]}:`);
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { pause: true, resume: true } })).status, 400, "two at once:");
});

let firstOrder;
let firstDlv;
await t("order.created: runOrderEffects emits, the fan-out job writes one delivery, the delivery job sends it signed to the receiver", async () => {
  firstOrder = await makeOrder();
  const { runOrderEffects } = await import("../lib/payment-settle.js");
  await inA(() => runOrderEffects(firstOrder));
  const ev = await inA(() => db.selectFrom("plugin_events").selectAll().where("idempotency_key", "=", `order.created:${firstOrder}`).executeTakeFirst());
  ok(ev, "an event");
  noPii(ev.payload, "the stored payload");
  await runJob(`plugin_fanout:${a.id}:${ev.id}`);
  const [d] = await deliveriesOf(appId);
  ok(d && d.status === "pending" && d.target === "http", "a pending delivery");
  firstDlv = d.id;
  const n = got.length;
  const res = await runJob(`plugin_delivery:${a.id}:${d.id}`);
  ok(res?.ok, `job ok: ${JSON.stringify(res)}`);
  eq(got.length, n + 1, "one request:");
  const req = got[got.length - 1];
  eq(req.headers["webhook-id"], d.id, "webhook-id:");
  eq(req.headers["webhook-signature"], sigOf(secret, d.id, req.headers["webhook-timestamp"], req.body), "signature:");
  ok(Math.abs(Number(req.headers["webhook-timestamp"]) - Date.now() / 1000) < 60, "timestamp now");
  const body = JSON.parse(req.body);
  eq(body.type, "order.created", "type:");
  eq(body.id, ev.id, "event id:");
  eq(body.store, a.tenant.domains[0], "store:");
  eq(body.data.order.id, firstOrder, "order:");
  eq(body.data.order.line_items.length, 2, "items:");
  ok(!("customer" in body.data.order) && !("email" in body.data.order), "no customer block");
  noPii(req.body, "the sent body");
  eq((await deliveriesOf(appId))[0].status, "delivered", "delivered:");
});

await t("idempotency: a replayed emit, a re-run fan-out and a re-run delivery send nothing more", async () => {
  const n = got.length;
  const again = await inA(() => E.emitOrderEvent("order.created", firstOrder));
  eq(again.existed, true, "replayed emit:");
  await inA(() => E.fanOut(again.id));
  eq((await deliveriesOf(appId)).length, 1, "one delivery:");
  const r = await inA(() => D.deliver(firstDlv));
  eq(r.already, "delivered", "a delivered row completes:");
  eq(got.length, n, "no request:");
});

await t("claim: two runs of one due delivery at once send exactly once", async () => {
  const ev = await inA(() => E.emitPluginEvent("order.created", { key: "claim-test", data: { order: { id: "c" } } }));
  await inA(() => E.fanOut(ev.id));
  const d = (await deliveriesOf(appId)).find((x) => x.event_id === ev.id);
  const n = got.length;
  const rs = await Promise.all([inA(() => D.deliver(d.id)), inA(() => D.deliver(d.id))]);
  eq(got.length, n + 1, "one request:");
  eq(rs.filter((r) => r.status === "delivered").length, 1, "one delivered:");
  const loser = rs.find((r) => r.status !== "delivered");
  ok((loser.requeue && loser.runAfter) || loser.already, `the other stood down and keeps its job (requeue): ${JSON.stringify(rs)}`);
});

await t("the job runner: plugin_delivery never runs without a budget (shopper after() runs); at most 2 sends per app per tick", async () => {
  const W = await import("../lib/platform/worker.js");
  ok(W.BUDGETED_ONLY_TYPES.includes("plugin_delivery"), "budgeted only");
  for (const f of ["app/api/quiz/[slug]/route.js", "app/api/account/route.js", "app/api/jobs/forward-events/route.js", "app/api/jobs/sync-shopify/route.js"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    ok(/runDueJobs\(\{ limit: \d+ \}\)/.test(src) && !/budgetMs/.test(src), `${f} runs without a budget`);
  }
  // first, the earlier tests' queued deliveries go out
  for (let i = 0; i < 20; i++) if (!(await W.runDueJobs({ limit: 25, budgetMs: 30_000 })).some((r) => r.type === "plugin_delivery")) break;
  const evs = [];
  for (let i = 0; i < 4; i++) evs.push(await inA(() => E.emitPluginEvent("order.created", { key: `cap-${i}`, data: { order: { id: `cap${i}` } } })));
  for (const ev of evs) await inA(() => E.fanOut(ev.id));
  const ids = (await deliveriesOf(appId)).filter((x) => evs.some((e) => e.id === x.event_id)).map((x) => x.id);
  eq(ids.length, 4, "four deliveries:");
  const jobs = await Promise.all(ids.map((id) => getJobByKey(`plugin_delivery:${a.id}:${id}`)));
  ok(jobs.every((j) => j?.payload?.installId === appId), "the job payload carries the install id (ids only)");
  const n = got.length;
  const noBudget = await W.runDueJobs({ limit: 25 });
  ok(!noBudget.some((r) => r.type === "plugin_delivery"), "an unbudgeted run leaves deliveries alone");
  eq(got.length, n, "nothing sent:");
  const tick = await W.runDueJobs({ limit: 25, budgetMs: 30_000 });
  const mine = tick.filter((r) => r.type === "plugin_delivery" && ids.includes(r.result?.deliveryId ?? "") );
  eq(mine.length, 2, "two sent this tick:");
  eq(tick.filter((r) => r.deferred === "per_app_cap").length, 2, "two handed back:");
  eq(got.length, n + 2, "two requests:");
  const held = await Promise.all(ids.map((id) => getJobByKey(`plugin_delivery:${a.id}:${id}`)));
  const back = held.filter((j) => j.status === "pending" && j.run_after);
  eq(back.length, 2, "the two held back wait:");
  ok(back.every((j) => Date.parse(j.run_after) - Date.now() > 50_000), "about a minute");
  for (const j of back) await makeJobDue(j.id);
  await W.runDueJobs({ limit: 25, budgetMs: 30_000 });
  eq(got.length, n + 4, "the rest go on a later tick:");
});

await t("a lost claim keeps its job: a runner that claimed and died leaves the delivery to the job, which sends it once the claim runs out", async () => {
  const W = await import("../lib/platform/worker.js");
  const ev = await inA(() => E.emitPluginEvent("order.created", { key: "claim-gap", data: { order: { id: "cg" } } }));
  await inA(() => E.fanOut(ev.id));
  const d = (await deliveriesOf(appId)).find((x) => x.event_id === ev.id);
  // another runner's claim, then it dies before sending
  const claimUntil = new Date(Date.now() + D.CLAIM_MS).toISOString();
  await inA(() => db.updateTable("plugin_deliveries").set({ next_attempt_at: claimUntil }).where("id", "=", d.id).execute());
  const key = `plugin_delivery:${a.id}:${d.id}`;
  const n = got.length;
  const r = await runJobById((await getJobByKey(key)).id);
  ok(r?.requeued, `requeued, not completed: ${JSON.stringify(r)}`);
  const job = await getJobByKey(key);
  eq(job.status, "pending", "the job is kept:");
  eq(job.run_after, claimUntil, "due when the claim runs out:");
  eq(got.length, n, "nothing sent while claimed:");
  await makeJobDue(job.id);
  const later = await W.runJobById(job.id, { now: () => Date.now() + D.CLAIM_MS + 1000 });
  ok(later?.ok, `ran: ${JSON.stringify(later)}`);
  eq(got.length, n + 1, "sent once the claim ran out:");
  eq((await deliveriesOf(appId)).find((x) => x.id === d.id).status, "delivered", "delivered:");
});

await t("starvation: 30 queued deliveries of one store don't hold back another store's shopify_push and send_notification; 4 sends per store per tick", async () => {
  const W = await import("../lib/platform/worker.js");
  const { enqueueJob } = await import("../lib/platform/jobs.js");
  for (let i = 0; i < 20; i++) if (!(await W.runDueJobs({ limit: 25, budgetMs: 30_000 })).length) break;
  const sent = [];
  const handlers = { ...W.HANDLERS, plugin_delivery: async (p) => (sent.push(p.installId), { ok: true }), shopify_push: async () => ({ ran: "push" }), send_notification: async () => ({ ran: "mail" }) };
  for (let i = 0; i < 32; i++) await enqueueJob({ type: "plugin_delivery", tenantId: a.id, payload: { deliveryId: `dlv_backlog${String(i).padStart(5, "0")}`, installId: `pin_backlog${i % 8}` }, idempotencyKey: `backlog-${i}` });
  await new Promise((res) => setTimeout(res, 5));
  await enqueueJob({ type: "shopify_push", tenantId: b.id, payload: { orderId: "BL-B1" }, idempotencyKey: "b-push" });
  await enqueueJob({ type: "send_notification", tenantId: b.id, payload: { notificationId: "ntf_b1" }, idempotencyKey: "b-mail" });
  const tick = await W.runDueJobs({ limit: 25, budgetMs: 30_000, handlers });
  ok(tick.some((r) => r.type === "shopify_push" && r.ok) && tick.some((r) => r.type === "send_notification" && r.ok), `store B's push and email ran in the same tick: ${tick.map((r) => r.type).join(",")}`);
  eq(sent.length, W.PLUGIN_SENDS_PER_STORE, "four sends for store A:");
  ok(tick.filter((r) => r.deferred === "per_store_cap").length > 0, "the rest held by the per-store cap");
  ok(tick.filter((r) => r.type === "plugin_delivery").length <= W.PLUGIN_LEASE_LIMIT, "deliveries leased apart, a few at a time");
  const jobs = await Promise.all(Array.from({ length: 32 }, (_, i) => getJobByKey(`backlog-${i}`)));
  const pushedBack = jobs.filter((j) => j.status === "pending" && j.run_after);
  const bPush = await getJobByKey("b-push");
  ok(pushedBack.length >= 1 && pushedBack.every((j) => Date.parse(j.run_after) - Date.now() > 50_000), "held back about a minute");
  ok(pushedBack.every((j) => j.created_at > bPush.created_at), "and to the back of the line (created_at reset past store B's jobs)");
  ok(W.PLUGIN_TICK_MS === 30_000 && W.PLUGIN_HOLD_MS === 60_000, "a 30 s delivery bound per tick; held back a minute");
});

await t("order.fulfilled: emitted once when the projection moves to fulfilled, never again", async () => {
  const { reconcileOrderProjection } = await import("../lib/order-projection.js");
  const id = await makeOrder({ status: "synced" });
  await inA(() => db.updateTable("orders").set({ shopify_order_id: "gid://shopify/Order/77" }).where("id", "=", id).execute());
  let n = 0;
  const gql = async () => ({ node: { id: "gid://shopify/Order/77", updatedAt: new Date(Date.now() + n++ * 1000).toISOString(), displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", refunds: [], fulfillments: [] } });
  await inA(() => reconcileOrderProjection(id, { gql }));
  await inA(() => reconcileOrderProjection(id, { gql }));
  const evs = await inA(() => db.selectFrom("plugin_events").select(["id", "topic"]).where("resource", "=", `order:${id}`).execute());
  eq(evs.map((e) => e.topic).join(","), "order.fulfilled", "one event:");
});

const wait = (k) => D.RETRY_WAITS_MS[k];
await t("retries: 1 m, 5 m, 30 m, 2 h, 6 h, 12 h, 24 h (±20%), 8 attempts, then Failed; not due → no send; 3xx/5xx alike", async () => {
  ok(D.retryWait(1, () => 0) === Math.round(wait(0) * 0.8) && D.retryWait(1, () => 1) === Math.round(wait(0) * 1.2), "jitter bounds");
  const ev = await inA(() => E.emitPluginEvent("order.created", { key: "retry-test", data: { order: { id: "x" } } }));
  await inA(() => E.fanOut(ev.id));
  const d = (await deliveriesOf(appId)).find((x) => x.event_id === ev.id);
  answer = { status: 500 };
  let now = Date.now();
  for (let i = 1; i <= D.MAX_ATTEMPTS; i++) {
    if (i === 4) answer = { status: 302, location: "/x" };
    const before = got.length;
    const r = await inA(() => D.deliver(d.id, { now, random: () => 0.5 }));
    eq(got.length, before + 1, `attempt ${i} sent:`);
    if (i < D.MAX_ATTEMPTS) {
      ok(r.requeue, `attempt ${i} requeues`);
      eq(Date.parse(r.runAfter) - now, wait(i - 1), `wait after ${i}:`);
      const early = await inA(() => D.deliver(d.id, { now: now + 1000 }));
      ok(early.requeue && got.length === before + 1, "not due: nothing sent");
      now = Date.parse(r.runAfter);
    } else eq(r.status, "failed", "after 8:");
  }
  const row = (await deliveriesOf(appId)).find((x) => x.id === d.id);
  eq(row.attempts, 8, "attempts:");
  eq(row.status, "failed", "status:");
  answer = { status: 200 };
  const g = await call("owner", "apps/[id]/webhooks", "GET", { params: { id: appId }, query: "status=failed" });
  eq(g.body.deliveries.map((x) => x.id).join(","), d.id, "the failed filter:");
});

await t("resend: owner sends a Failed delivery again with the same webhook-id; a delivered one can't be resent", async () => {
  const d = (await deliveriesOf(appId)).find((x) => x.status === "failed");
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { resend: firstDlv } })).status, 409, "delivered:");
  const r = await call("admin", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { resend: d.id } });
  eq(r.status, 200, `resend: ${r.text.slice(0, 200)}`);
  await runJob(`plugin_delivery:${a.id}:${d.id}`);
  eq(got[got.length - 1].headers["webhook-id"], d.id, "same id:");
  eq((await deliveriesOf(appId)).find((x) => x.id === d.id).status, "delivered", "delivered:");
  ok((await auditRows()).some((x) => x.action === "apps.delivery_resent"), "audited");
});

await t("410 Gone pauses the endpoint at once (system audit row); new events are Skipped; resend refused until Resume; the dashboard says so", async () => {
  const ev = await inA(() => E.emitPluginEvent("order.created", { key: "gone-test", data: { order: { id: "y" } } }));
  await inA(() => E.fanOut(ev.id));
  const d = (await deliveriesOf(appId)).find((x) => x.event_id === ev.id);
  answer = { status: 410 };
  const r = await inA(() => D.deliver(d.id));
  answer = { status: 200 };
  eq(r.status, "failed", "failed:");
  eq(r.paused, "gone", "paused:");
  const g = await call("support", "apps/[id]/webhooks", "GET", { params: { id: appId } });
  eq(g.body.endpoint.status, "paused", "paused:");
  ok(/410/.test(g.body.endpoint.pausedReason), "reason");
  const row = (await auditRows()).find((x) => x.action === "apps.endpoint_auto_paused");
  ok(row && row.actor_kind === "system", "system audit row");
  const { actionQueue } = await import("../lib/admin/dashboard.js");
  const q = await inA(() => actionQueue({ role: "owner" }));
  ok(q.some((x) => x.id === "app_webhook_paused" && /isn't answering/.test(x.words)), "dashboard row");
  const ev2 = await inA(() => E.emitPluginEvent("order.created", { key: "gone-test-2", data: { order: { id: "z" } } }));
  await inA(() => E.fanOut(ev2.id));
  const skipped = (await deliveriesOf(appId)).find((x) => x.event_id === ev2.id);
  eq(skipped.status, "skipped", "while paused:");
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { resend: skipped.id } })).status, 409, "resend while paused:");
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { test: true } })).status, 409, "test while paused:");
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { resume: true } })).status, 200, "resume:");
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { resend: skipped.id } })).status, 200, "resend after resume:");
  await runJob(`plugin_delivery:${a.id}:${skipped.id}`);
  eq((await deliveriesOf(appId)).find((x) => x.id === skipped.id).status, "delivered", "delivered:");
  ok(!(await inA(() => actionQueue({ role: "owner" }))).some((x) => x.id === "app_webhook_paused"), "dashboard row gone");
});

await t("72 h failing: auto-paused, owners and admins emailed (not staff or support); a pending delivery is Skipped on its next attempt", async () => {
  const ev = await inA(() => E.emitPluginEvent("order.created", { key: "fail72", data: { order: { id: "f" } } }));
  const ev2 = await inA(() => E.emitPluginEvent("order.created", { key: "fail72b", data: { order: { id: "g" } } }));
  await inA(() => E.fanOut(ev.id));
  await inA(() => E.fanOut(ev2.id));
  const all = await deliveriesOf(appId);
  const d = all.find((x) => x.event_id === ev.id);
  const d2 = all.find((x) => x.event_id === ev2.id);
  await inA(() => db.updateTable("plugin_endpoints").set({ failing_since: new Date(Date.now() - 73 * 3600_000).toISOString() }).where("install_id", "=", appId).execute());
  answer = { status: 503 };
  const r = await inA(() => D.deliver(d.id));
  answer = { status: 200 };
  eq(r.paused, "failing", "paused:");
  const n = got.length;
  eq((await inA(() => D.deliver(d2.id))).status, "skipped", "next attempt:");
  eq(got.length, n, "nothing sent:");
  const mails = await inA(() => db.selectFrom("notifications").select(["recipient", "type"]).where("type", "=", "app_webhook_paused").execute());
  const to = mails.map((m) => m.recipient).sort().join(",");
  ok(to.includes(`owner@${a.id}.test`) && to.includes(`admin@${a.id}.test`), `owner and admin: ${to}`);
  ok(!to.includes("staff@") && !to.includes("support@"), "not staff or support");
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { resume: true } })).status, 200, "resume:");
});

await t("rotate secret: answered once; the old one keeps signing alongside for 24 h, then only the new one", async () => {
  const r = await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { rotate_secret: true } });
  eq(r.status, 200, "rotate:");
  const fresh = r.body.secret;
  ok(SIGN.SECRET_RE.test(fresh) && fresh !== secret, "a new secret");
  const g = await call("owner", "apps/[id]/webhooks", "GET", { params: { id: appId } });
  ok(g.body.endpoint.oldSecretSignsUntil && !g.text.includes(fresh.slice(6)), "overlap shown, secret not");
  const t1 = await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { test: true } });
  eq(t1.status, 200, "test:");
  await runJob(`plugin_delivery:${a.id}:${t1.body.deliveryId}`);
  const req = got[got.length - 1];
  const ts = req.headers["webhook-timestamp"];
  eq(req.headers["webhook-signature"], `${sigOf(fresh, req.headers["webhook-id"], ts, req.body)} ${sigOf(secret, req.headers["webhook-id"], ts, req.body)}`, "two signatures:");
  eq(JSON.parse(req.body).type, "ping", "a ping:");
  await inA(() => db.updateTable("plugin_endpoints").set({ prev_secret_until: new Date(Date.now() - 1000).toISOString() }).where("install_id", "=", appId).execute());
  const t2 = await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { test: true } });
  await runJob(`plugin_delivery:${a.id}:${t2.body.deliveryId}`);
  const req2 = got[got.length - 1];
  eq(req2.headers["webhook-signature"], sigOf(fresh, req2.headers["webhook-id"], req2.headers["webhook-timestamp"], req2.body), "one signature:");
  secret = fresh;
  ok((await auditRows()).some((x) => x.action === "apps.secret_rotated" && !String(x.diff).includes(fresh.slice(6))), "audited without it");
});

await t("edit endpoint: re-validated (422); same host audited as saved, a new host as an allowlist change", async () => {
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { endpoint: { url: "https://192.168.1.1/x" } } })).status, 422, "private:");
  const same = await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { endpoint: { url: `${HOOK}?v=2`, topics: ["order.created"] } } });
  eq(same.status, 200, "same host:");
  eq(same.body.endpoint.topics.join(","), "order.created", "topics:");
  ok((await auditRows()).some((x) => x.action === "apps.endpoint_saved"), "saved");
  const realL = EG.egressDns.lookup;
  try {
    fakeDns([{ address: "93.184.216.34", family: 4 }]);
    const moved = await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { endpoint: { url: "https://hooks.example.com/in" } } });
    eq(moved.status, 200, `new host: ${moved.text.slice(0, 200)}`);
    fakeDns([{ address: "10.1.1.1", family: 4 }]);
    eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { endpoint: { url: "https://rebind.example.com/in" } } })).status, 422, "resolves private:");
  } finally {
    EG.egressDns.lookup = realL;
  }
  const row = (await auditRows()).find((x) => x.action === "apps.endpoint_allowlist_changed");
  ok(row && String(row.diff).includes("hooks.example.com"), "allowlist change");
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { endpoint: { url: HOOK, topics: ["order.created", "order.fulfilled"] } } })).status, 200, "back:");
});

await t("payloads: owner, admin and staff see them; support and operator support see status only; no customer details anywhere", async () => {
  for (const caller of [...MERCHANT, ...OPS]) {
    const g = await call(caller, "apps/[id]/webhooks", "GET", { params: { id: appId } });
    const redacted = caller === "support" || OPS.includes(caller);
    eq(g.body.canSeePayloads, !redacted, `${caller} canSeePayloads:`);
    ok(g.body.deliveries.length > 0, `${caller} rows`);
    ok(g.body.deliveries.every((d) => ("payload" in d) === !redacted), `${caller} payload presence`);
    noPii(g.text, caller);
    if (redacted) {
      eq(g.body.endpoint.url, "http://127.0.0.1:" + PORT + "/…", `${caller}: host only:`);
      ok(!g.text.includes("/hooks"), `${caller}: no path`);
    } else eq(g.body.endpoint.url, HOOK, `${caller}: the full address:`);
  }
});

await t("an app that is off: its pending deliveries turn Skipped on the next attempt; fan-out skips it; nothing is backfilled", async () => {
  const ev = await inA(() => E.emitPluginEvent("order.created", { key: "off-test", data: { order: { id: "o" } } }));
  await inA(() => E.fanOut(ev.id));
  const d = (await deliveriesOf(appId)).find((x) => x.event_id === ev.id);
  eq((await call("owner", "apps/[id]", "POST", { params: { id: appId }, body: { disable: true } })).status, 200, "turn off:");
  eq((await inA(() => D.deliver(d.id))).status, "skipped", "skipped:");
  const ev2 = await inA(() => E.emitPluginEvent("order.created", { key: "off-test-2", data: { order: { id: "p" } } }));
  await inA(() => E.fanOut(ev2.id));
  ok(!(await deliveriesOf(appId)).some((x) => x.event_id === ev2.id), "no delivery while off");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: appId }, body: { enable: true } })).status, 200, "turn on:");
  ok(!(await deliveriesOf(appId)).some((x) => x.event_id === ev2.id), "turning on backfills nothing");
});

await t("first-party fixture: its handler runs with a narrow context; its fetch is bound to the manifest's egress", async () => {
  const undo = CAT.registerPlugin({ id: "fixture-hooks", name: "Fixture hooks", version: "1.0.0", summary: "s", description: "d", icon: "Truck", author: { name: "Tests" }, scopes: ["orders.read"], settings: [{ key: "greeting", kind: "text", label: "G", max: 20, default: "hi" }], events: ["order.created"], egress: ["api.fixture.example"] });
  const seen = [];
  const undoH = HANDLERS.registerPluginHandler("fixture-hooks", "order.created", async (ctx) => {
    seen.push({ keys: Object.keys(ctx).sort().join(","), event: ctx.event, install: ctx.install });
    seen.push({ off: await ctx.fetch("https://other.example.com/x", { body: "{}" }) });
    seen.push({ override: await ctx.fetch("https://other.example.com/x", { body: "{}", allowHosts: ["other.example.com"], env: { STOREASY_PLUGIN_EGRESS_LOCAL: "1", NODE_ENV: "test" }, headers: { Host: "evil.example" } }) });
    fakeDns([{ address: "169.254.169.254", family: 4 }]);
    try {
      seen.push({ meta: await ctx.fetch("https://api.fixture.example/x", { body: "{}" }) });
    } finally {
      EG.egressDns.lookup = realLookup;
    }
  });
  try {
    const ins = await call("owner", "apps", "POST", { body: { install: { pluginId: "fixture-hooks", scopes: ["orders.read"] } } });
    eq(ins.status, 200, "install:");
    const id = await makeOrder();
    const ev = await inA(() => E.emitOrderEvent("order.created", id));
    await inA(() => E.fanOut(ev.id));
    const [d] = await deliveriesOf(ins.body.install.id);
    eq(d.target, "internal", "internal:");
    eq((await inA(() => D.deliver(d.id))).status, "delivered", "delivered:");
    eq(seen[0].keys, "event,fetch,install,log,secrets", "context:");
    eq(seen[0].event.data.order.id, id, "event:");
    eq(seen[0].install.settings.greeting, "hi", "settings:");
    ok(seen[1].off.refused, "off-egress fetch refused");
    ok(seen[2].override.refused, "the handler can't widen its own allowlist");
    ok(seen[3].meta.refused, "metadata address refused");
    const o = D.handlerFetchOptions({ body: "b", headers: { Host: "evil", HOST: "x", "x-a": "1" }, allowHosts: ["x"], method: "DELETE", timeoutMs: 1, connectTimeoutMs: 1, env: {} });
    eq(JSON.stringify(o), JSON.stringify({ body: "b", headers: { "x-a": "1" } }), "only body and headers, no host header:");
    noPii(JSON.stringify(seen[0].event), "handler event");
    eq((await call("owner", "apps/[id]", "POST", { params: { id: ins.body.install.id }, body: { uninstall: true } })).status, 200, "uninstall:");
  } finally {
    undoH();
    undo();
  }
});

await t("limits: up to 10 custom apps per store; line items capped at 100 with line_items_truncated", async () => {
  const live = (await call("owner", "apps", "GET")).body.installs.filter((i) => i.kind === "custom").length;
  for (let i = live; i < 9; i++) eq((await call("owner", "apps", "POST", { body: custom({ name: `App ${i}` }) })).status, 200, `app ${i}:`);
  // two creates at once with 9 live: exactly one is made (the count is inside the insert)
  const both = await Promise.all([call("owner", "apps", "POST", { body: custom({ name: "Racer one" }) }), call("admin", "apps", "POST", { body: custom({ name: "Racer two" }) })]);
  eq(both.map((r) => r.status).sort().join(","), "200,409", "racing at 9:");
  ok(/Racer (one|two) wasn't created/.test(both.find((r) => r.status === 409).body.error), "the refusal names the app");
  const count = await inA(() => db.selectFrom("plugin_installs").select(({ fn }) => fn.countAll().as("n")).where("kind", "=", "custom").where("status", "<>", "uninstalled").executeTakeFirst());
  eq(Number(count.n), 10, "ten live:");
  const orphans = await inA(() => db.selectFrom("plugin_endpoints as e").leftJoin("plugin_installs as i", "i.id", "e.install_id").select("e.id").where("i.id", "is", null).execute());
  eq(orphans.length, 0, "no endpoint without its install:");
  eq((await call("owner", "apps", "POST", { body: custom({ name: "Eleventh" }) })).status, 409, "the 11th:");
  const snap = TOP.orderSnapshot({ id: "o" }, Array.from({ length: 120 }, (_, i) => ({ title: `t${i}`, position: i })));
  eq(snap.line_items.length, 100, "capped:");
  eq(snap.line_items_truncated, true, "flag:");
  const huge = TOP.webhookBody({ id: "evt_1", topic: "order.created", created_at: "x", payload: { order: { id: "o", line_items: Array.from({ length: 100 }, () => ({ title: "x".repeat(4000) })) } } }, "s");
  ok(new TextEncoder().encode(huge).length <= TOP.MAX_BODY_BYTES && JSON.parse(huge).data.order.line_items_truncated, "256 KB cap");
});

await t("dashboard keys on the pause reason: a pause by the team is no attention row", async () => {
  const { actionQueue } = await import("../lib/admin/dashboard.js");
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { pause: true } })).status, 200, "pause:");
  ok(!(await inA(() => actionQueue({ role: "owner" }))).some((x) => x.id === "app_webhook_paused"), "no row");
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { pause: true } })).body.error, "Order hooks's webhooks are already paused.", "named refusal:");
  eq((await call("owner", "apps/[id]/webhooks", "POST", { params: { id: appId }, body: { resume: true } })).status, 200, "resume:");
});

await t("uninstalling a custom app clears its signing secrets; a pending delivery is then skipped", async () => {
  const live = (await call("owner", "apps", "GET")).body.installs.filter((i) => i.kind === "custom" && i.id !== appId);
  const victim = live[0].id;
  const ev = await inA(() => E.emitPluginEvent("order.created", { key: "uninstall-test", data: { order: { id: "u" } } }));
  await inA(() => E.fanOut(ev.id));
  const d = (await deliveriesOf(victim)).find((x) => x.event_id === ev.id);
  await call("owner", "apps/[id]/webhooks", "POST", { params: { id: victim }, body: { rotate_secret: true } });
  eq((await call("owner", "apps/[id]", "POST", { params: { id: victim }, body: { uninstall: true } })).status, 200, "uninstall:");
  const ep = await inA(() => db.selectFrom("plugin_endpoints").selectAll().where("install_id", "=", victim).executeTakeFirst());
  ok(ep.secret_enc === null && ep.prev_secret_enc === null && ep.prev_secret_until === null, "secrets cleared");
  eq((await inA(() => D.deliver(d.id))).status, "skipped", "skipped:");
});

await t("store isolation: A's app is not found from B; B's owner can't touch it", async () => {
  eq((await call("owner-b", "apps/[id]/webhooks", "GET", { host: hostB, params: { id: appId } })).status, 404, "GET:");
  eq((await call("owner-b", "apps/[id]/webhooks", "POST", { host: hostB, params: { id: appId }, body: { pause: true } })).status, 404, "POST:");
});

await t("retention: events and deliveries older than 30 days are pruned during fan-out; newer ones stay", async () => {
  const old = new Date(Date.now() - 31 * 86400_000).toISOString();
  await inA(async () => {
    await db.insertInto("plugin_events").values({ id: "evt_old0000000000000", topic: "order.created", idempotency_key: "old-1", payload: "{}", created_at: old }).execute();
    await db.insertInto("plugin_deliveries").values({ id: "dlv_old0000000000000", event_id: "evt_old0000000000000", install_id: appId, target: "http", status: "delivered", created_at: old, updated_at: old }).execute();
  });
  const ev = await inA(() => E.emitPluginEvent("order.created", { key: "prune-trigger", data: {} }));
  const r = await inA(() => E.fanOut(ev.id));
  ok(r.pruned.events >= 1 && r.pruned.deliveries >= 1, `pruned: ${JSON.stringify(r.pruned)}`);
  ok(!(await inA(() => db.selectFrom("plugin_events").select("id").where("id", "=", "evt_old0000000000000").executeTakeFirst())), "old event gone");
  ok(await inA(() => db.selectFrom("plugin_events").select("id").where("id", "=", ev.id).executeTakeFirst()), "new event kept");
});

await t("export: plugin_events and plugin_deliveries are listed; plugin_endpoints without its secrets", async () => {
  const { buildTenantExport } = await import("../lib/platform/export.js");
  const x = await buildTenantExport(a.id);
  ok(x.manifest.tables.plugin_events > 0 && x.manifest.tables.plugin_deliveries > 0 && x.manifest.tables.plugin_endpoints > 0, "tables");
  const text = JSON.stringify(x.data.plugin_endpoints);
  ok(!text.includes("secret_enc") && !text.includes(secret.slice(6)), "no secrets");
});

// --- import graphs -------------------------------------------------------------------
const walk = (dir) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const code = (f) => /\.(m?js|jsx|ts|tsx)$/.test(f);
function reaches(entries, targets) {
  const seen = new Set();
  const bad = [];
  const resolveLocal = (from, id) => {
    const base = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(join(ROOT, from)), id);
    for (const c of [base, ...[".js", ".mjs", ".jsx", ".ts", ".tsx"].map((x) => `${base}${x}`), ...["index.js", "index.ts"].map((x) => join(base, x))]) if (existsSync(c) && statSync(c).isFile()) return relative(ROOT, c);
    return null;
  };
  const visit = (rel, chain) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    if (targets.includes(rel)) return bad.push([...chain, rel].join(" → "));
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])([^"'`$]+)\1/g)) {
      const id = m[2];
      if (!(id.startsWith("@/") || id.startsWith("."))) continue;
      const target = resolveLocal(rel, id);
      if (target && code(target)) visit(target, [...chain, rel]);
    }
  };
  for (const e of entries) visit(e, []);
  return { bad, seen: seen.size };
}

// Entries: every app/(storefront) file (Edge and Node alike) and every
// components/ file. A file that reaches egress, deliveries or custom apps is
// flagged unless REACH_OK names it with a reason.
const REACH_OK = {
  "app/(storefront)/pricing/page.js":
    "the platform's own pricing page (runtime nodejs, never a store's storefront): its signup flow reaches lib/platform/worker.js through signup-provision → onboarding → shopify-connect → sync-jobs, and the worker loads deliveries.js with a dynamic import only when a plugin_delivery job runs",
};
await t("egress.js, deliveries.js and custom-apps.js are unreachable from app/(storefront) and components/ (static and dynamic imports); the one known Node page is pinned", () => {
  const entries = [...walk("app/(storefront)"), ...walk("components")].filter(code);
  ok(entries.length > 50, `entries: ${entries.length}`);
  const bad = [];
  const seenOk = new Set();
  for (const e of entries) {
    const r = reaches([e], ["lib/plugins/egress.js", "lib/plugins/deliveries.js", "lib/plugins/custom-apps.js"]);
    if (!r.bad.length) continue;
    if (REACH_OK[e]) seenOk.add(e);
    else bad.push(...r.bad);
  }
  eq(bad.join("\n"), "", "reached:");
  eq([...seenOk].join(","), Object.keys(REACH_OK).join(","), "REACH_OK lists only files that really reach them:");
});

await t("edge safety: hosts, topics, sign, handlers and events import no node: module", () => {
  for (const f of ["hosts", "topics", "sign", "handlers", "events"]) ok(!/from\s+["']node:/.test(readFileSync(join(ROOT, `lib/plugins/${f}.js`), "utf8")), f);
});

await t("no network: nothing reached fetch()", () => eq(network.length, 0, network.join(", ")));

server.close();
await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
