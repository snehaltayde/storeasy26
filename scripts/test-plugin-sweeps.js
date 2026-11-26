// Phase 9 step 0 suite: the shared plumbing the five plugin lines build on.
//   registerSweep / sweepFor / sweepPluginIds (lib/plugins/sweeps.js)
//   the sweep walk: active stores only, enabled + un-killed installs only,
//     each call inside that store's own withTenant; a throw is counted, the
//     walk carries on; a passed deadline stops it
//   queuePluginSweep: one job per 10-minute window, none while no sweep exists
//   the worker's plugin_sweep handler (a long, budgeted-only job)
//   the internal order.delivery_updated topic (not subscribable)
//   estimateFor (lib/delivery/estimate-source.js): the store's own estimate
//   pnpm test:plugin-sweeps
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.PLATFORM_SECRET = "test-plsweep-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.NODE_ENV = "test";
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

const FX = await import("./support/tenant-fixture.js");
const platform = await FX.makePlatform({ name: "plsweep" });
const a = await FX.makeTenant({ name: "plsweep-a", id: "swa" });
const b = await FX.makeTenant({ name: "plsweep-b", id: "swb" });
const c = await FX.makeTenant({ name: "plsweep-c", id: "swc" });

const SW = await import("../lib/plugins/sweeps.js");
const CAT = await import("../lib/plugins/catalog.js");
const TOP = await import("../lib/plugins/topics.js");
const M = await import("../lib/plugins/manifest.js");
const W = await import("../lib/platform/worker.js");
const FLAGS = await import("../lib/platform/flags.js");
const C = await import("../lib/platform/control.js");
const { platformDb } = C;
const { db } = await import("../lib/db.js");
const { tenantId } = await import("../lib/tenant-context.js");
const { encryptJson } = await import("../lib/platform/crypto.js");
const { estimateFor } = await import("../lib/delivery/estimate-source.js");
const { computeShipping } = await import("../lib/shipping.js");

const manifest = (id) => ({ id, name: `Fixture ${id}`, version: "1.0.0", summary: "s", description: "d", icon: "Truck", author: { name: "Tests" }, scopes: [], settings: [{ key: "greeting", kind: "text", label: "G", max: 20, default: "hi" }], events: [], egress: [] });
const NOW_ISO = "2026-11-26T00:00:00.000Z";
let n = 0;
const BUILT_IN_SWEEPS = SW.sweepPluginIds();
const install = (pluginId, status, extra = {}) =>
  db.insertInto("plugin_installs").values({ id: `pin_sweep${++n}`, plugin_id: pluginId, kind: "first_party", version: "1.0.0", status, granted_scopes: "[]", settings: JSON.stringify({ greeting: `hi ${pluginId}`, __secret_keys: ["token"] }), installed_by: "member:test", installed_at: NOW_ISO, updated_at: NOW_ISO, ...extra }).returning("id").executeTakeFirstOrThrow();

await t("registerSweep: adds a sweep, undo removes it; a second register replaces it and the first undo leaves the second alone; a non-function is refused", () => {
  // Phase 9 lines add built-in sweeps (line 3: whatsapp, line 4: shiprocket); each is a catalog plugin's
  ok(BUILT_IN_SWEEPS.every((id) => CAT.pluginById(id)), "every built-in sweep is a catalog plugin's:");
  ok(BUILT_IN_SWEEPS.every((id) => typeof SW.sweepFor(id) === "function"), "every built-in id has its sweep");
  eq(SW.sweepFor("fx-reg"), null, "none yet:");
  const f1 = async () => {};
  const f2 = async () => {};
  const undo1 = SW.registerSweep("fx-reg", f1);
  eq(SW.sweepFor("fx-reg"), f1, "registered:");
  eq(JSON.stringify(SW.sweepPluginIds()), JSON.stringify([...BUILT_IN_SWEEPS, "fx-reg"]), "listed:");
  const undo2 = SW.registerSweep("fx-reg", f2);
  eq(SW.sweepFor("fx-reg"), f2, "replaced:");
  undo1();
  eq(SW.sweepFor("fx-reg"), f2, "the stale undo leaves the newer sweep:");
  undo2();
  eq(SW.sweepFor("fx-reg"), null, "undone:");
  eq(SW.sweepPluginIds().length, BUILT_IN_SWEEPS.length, "nothing left:");
  let threw = false;
  try {
    SW.registerSweep("fx-reg", "not a function");
  } catch {
    threw = true;
  }
  ok(threw, "a non-function throws");
  eq(SW.sweepFor("__proto__"), null, "no prototype lookups:");
});

await t("queuePluginSweep: a job per window for the built-in sweep; then one job per 10-minute window (the key dedupes)", async () => {
  const base = 1_800_000_000_000 - (1_800_000_000_000 % SW.PLUGIN_SWEEP_WINDOW_MS);
  if (!BUILT_IN_SWEEPS.length) eq(await SW.queuePluginSweep(base + 1000), null, "no sweep, no job:");
  const undo = SW.registerSweep("fx-q", async () => {});
  try {
    const x = await SW.queuePluginSweep(base + 1000);
    const y = await SW.queuePluginSweep(base + 9 * 60_000);
    const z = await SW.queuePluginSweep(base + 11 * 60_000);
    ok(x?.id && x.existed === false, "a first job");
    eq(y.id, x.id, "same window, same job:");
    eq(y.existed, true, "deduped:");
    ok(z.id && z.id !== x.id, "the next window gets its own job");
    const rows = (await platformDb().execute({ sql: "SELECT type, idempotency_key, max_attempts FROM jobs WHERE id IN (?, ?)", args: [x.id, z.id] })).rows;
    ok(rows.every((r) => r.type === "plugin_sweep" && Number(r.max_attempts) === 1), "plugin_sweep jobs, one attempt");
    ok(rows.some((r) => r.idempotency_key === `plugin_sweep:${Math.floor((base + 1000) / SW.PLUGIN_SWEEP_WINDOW_MS)}`), "a windowed key");
  } finally {
    undo();
  }
});

await t("the worker: plugin_sweep is a handler and a long job (budgeted callers only)", () => {
  eq(typeof W.HANDLERS.plugin_sweep, "function", "handler:");
  ok(W.LONG_JOB_TYPES.includes("plugin_sweep"), "long");
  ok(W.BUDGETED_ONLY_TYPES.includes("plugin_sweep"), "budgeted only");
});

// --- the walk -------------------------------------------------------------------------
const undos = ["fx-on", "fx-none", "fx-kill", "fx-throw"].map((id) => CAT.registerPlugin(manifest(id)));
await a.run(async () => {
  await install("fx-on", "enabled", { secrets_enc: await encryptJson({ token: "tok-a" }) });
  await install("fx-on", "uninstalled", { uninstalled_at: NOW_ISO });
  await install("fx-none", "enabled");
  await install("fx-kill", "enabled");
  await install("fx-throw", "enabled");
});
await b.run(async () => {
  await install("fx-on", "disabled", { disabled_at: NOW_ISO });
  await install("fx-throw", "enabled");
});
await c.run(() => install("fx-on", "enabled"));
await C.patchTenant("swc", { status: "suspended" });

await t("sweepPlugins: active stores only, enabled and un-killed installs only, each call inside its own store; a throw is counted and the walk carries on", async () => {
  const calls = [];
  const killKey = CAT.killFlag("fx-kill");
  await FLAGS.setFlag({ key: killKey, description: "kill", default_on: false, create: true, actor: { kind: "operator", id: "opr_sweeptest" } });
  FLAGS.__resetFlagCache();
  const offs = [
    SW.registerSweep("fx-on", async (ctx) => {
      calls.push({ plugin: "fx-on", tenant: tenantId(), store: await db.selectFrom("plugin_installs").select("id").where("id", "=", ctx.install.id).executeTakeFirst(), ctx, secrets: await ctx.secrets() });
    }),
    SW.registerSweep("fx-kill", async () => calls.push({ plugin: "fx-kill", tenant: tenantId() })),
    SW.registerSweep("fx-throw", async () => {
      calls.push({ plugin: "fx-throw", tenant: tenantId() });
      throw new Error("carrier down");
    }),
    SW.registerSweep("fx-unlisted", async () => calls.push({ plugin: "fx-unlisted", tenant: tenantId() })),
  ];
  try {
    const out = await SW.sweepPlugins({ now: () => 1_800_000_000_000 });
    const seen = calls.map((x) => `${x.tenant}:${x.plugin}`).sort();
    eq(JSON.stringify(seen), JSON.stringify(["swa:fx-on", "swa:fx-throw", "swb:fx-throw"]), "who was swept:");
    eq(out.stores, 2, "two active stores:");
    eq(out.ran, 3, "three sweeps ran:");
    eq(out.failed, 2, "the two throws are counted:");
    const on = calls.find((x) => x.plugin === "fx-on");
    ok(on.store, "the call's database is the store's own (its install row is there)");
    eq(on.ctx.install.pluginId, "fx-on", "pluginId:");
    eq(JSON.stringify(on.ctx.install.settings), '{"greeting":"hi fx-on"}', "settings without the secret-key list:");
    eq(on.ctx.now, 1_800_000_000_000, "now is the job's clock:");
    eq(on.secrets.token, "tok-a", "secrets() decrypts this install's secrets:");
    eq(typeof on.ctx.fetch, "function", "fetch:");
    eq(typeof on.ctx.log, "function", "log:");
    const refused = await on.ctx.fetch("https://not-allowed.example.com/x");
    ok(refused.ok === false && refused.refused === true, "fetch is bound to the manifest's egress list (an unlisted host is refused)");
    eq(network.length, 0, "nothing reached the network:");
  } finally {
    offs.forEach((f) => f());
    await FLAGS.deleteFlag(killKey, { kind: "operator", id: "opr_sweeptest" });
    FLAGS.__resetFlagCache();
  }
});

await t("sweepPlugins: with no install of a sweep's plugin nothing runs; a passed deadline stops before the first store; the worker handler runs the walk", async () => {
  const none = await SW.sweepPlugins({ now: () => 1 });
  // with no fx install, only the built-in sweeps could run, and these stores install none
  eq(JSON.stringify(none), BUILT_IN_SWEEPS.length ? '{"stores":2,"ran":0,"failed":0}' : '{"stores":0,"ran":0,"failed":0}', "no sweep:");
  const calls = [];
  const off = SW.registerSweep("fx-on", async () => calls.push(tenantId()));
  try {
    const late = await SW.sweepPlugins({ deadline: 100, now: () => 200 });
    eq(late.stores, 0, "no store after the deadline:");
    eq(calls.length, 0, "no call:");
    const res = await W.HANDLERS.plugin_sweep({}, { deadline: null, now: () => 300 });
    eq(res.stores, 2, "the handler walks the active stores:");
    eq(JSON.stringify(calls), '["swa"]', "the one enabled fx-on install:");
  } finally {
    off();
  }
});

await t("topic order.delivery_updated: internal (orders.read), not subscribable, refused in a manifest", () => {
  ok(Object.hasOwn(TOP.TOPICS, "order.delivery_updated"), "a topic");
  eq(TOP.requiredScope("order.delivery_updated"), "orders.read", "scope:");
  eq(TOP.SUBSCRIBABLE.includes("order.delivery_updated"), false, "not subscribable:");
  const problems = M.checkManifests([{ ...manifest("fx-topic"), scopes: ["orders.read"], events: ["order.delivery_updated"] }]);
  ok(problems.some((p) => p.includes('unknown event "order.delivery_updated"')), "a manifest can't name it");
});

await t("estimateFor: the store's own estimate, unchanged (same object; null and absent stay null)", async () => {
  const config = { dispatch_days: 1, delivery_days: { min: 2, max: 4 } };
  const ship = computeShipping({ subtotal: 0, pincode: "411001", config });
  const store = ship.estimate ?? { minDays: 3, maxDays: 5 };
  eq(await estimateFor({ pin: "411001", storeEstimate: store }), store, "same object:");
  eq(JSON.stringify(await estimateFor({ pin: "411001", storeEstimate: store })), JSON.stringify(store), "same bytes:");
  eq(await estimateFor({ pin: "411001", storeEstimate: null }), null, "null:");
  eq(await estimateFor({ pin: null }), null, "absent:");
  eq(await estimateFor(), null, "no argument:");
});

undos.forEach((f) => f());
for (const x of [a, b, c]) await x.cleanup();
await platform.cleanup?.();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
