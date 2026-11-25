// Feature flags and incidents on the operator console (Phase 3 line 4,
// docs/plans/phase-3.md "Line 4").   pnpm test:flags-incidents
// Flags: state words, create and edit with the key rule, per-store overrides
// (the store must exist), emergency disable, delete with its fallback, history
// from audit_log, and the operator's name on the list. Incidents: open (a
// store must exist), post an update, edit the internal note, resolve with a
// closing message, the timeline from audit_log (incident.* and the old
// tenant.status rows), open-first ordering, the scope filter and 50-row pages.
// Least trusted: the internal-note canary is in no audit row, no merchant
// notice and no merchant Audit log read; a merchant token in _platform gets
// 401 on every write and changes nothing. Outside services are blanked and
// fetch() is blocked; every database is a throwaway file: database.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(ROOT, "app/api/platform");
const read = (rel) => readFile(join(ROOT, rel), "utf8");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-flaginc-default.db";
process.env.PLATFORM_SECRET = "test-flags-incidents-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.FLAG_CACHE_MS = "0";
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
    console.error(`✗ ${name}\n   ${String(e.stack || e.message).split("\n").slice(0, 4).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

const W = await import("../components/platform/flags/flagWords.js");
const IW = await import("../lib/platform/incident-words.js");

// --- pure words -------------------------------------------------------------------
await t("flag state in words: on for everyone, off, on for n stores, on except n, expired", () => {
  eq(W.flagState({ default_on: true, tenants: {} }).label, "On for everyone");
  eq(W.flagState({ default_on: false, tenants: {} }).label, "Off");
  eq(W.flagState({ default_on: false, tenants: { a: 1, b: 1, c: 1 } }).label, "On for 3 stores");
  eq(W.flagState({ default_on: false, tenants: { a: 1, b: 0 } }).label, "On for 1 store");
  eq(W.flagState({ default_on: true, tenants: { a: 0, b: 0 } }).label, "On except 2 stores");
  eq(W.flagState({ default_on: true, expired: true, tenants: { a: 1 } }).label, "Expired");
  ok(W.FLAG_KEY_PATTERN.test("ff_new-search") && !W.FLAG_KEY_PATTERN.test("pro_plan") && !W.FLAG_KEY_PATTERN.test("ff_Upper") && !W.FLAG_KEY_PATTERN.test("ff_"), "key rule");
  ok(/off/.test(W.fallbackWords(false)) && /on/.test(W.fallbackWords(true)), "fallback words");
  ok(/next request/.test(W.disableWords(true)), "a critical flag's disable says the next request");
});

await t("banner title: one function for the merchant banner and the operator's preview", async () => {
  eq(IW.incidentBannerTitle({ tenant_id: null, title: "Slow sync" }), "Platform notice: Slow sync");
  eq(IW.incidentBannerTitle({ tenant_id: "s1", title: "Payments" }), "Notice for your store: Payments");
  ok(/incidentBannerTitle\(i\)/.test(await read("components/admin/shell/ConsoleNotices.js")), "ConsoleNotices uses it");
  ok(/incidentBannerTitle\(incident\)/.test(await read("components/platform/incidents/IncidentsScreen.js")), "the preview uses it");
});

await t("static: the new screens use components/ui and components/kit, never components/console", async () => {
  for (const f of ["components/platform/flags/FlagsScreen.js", "components/platform/incidents/IncidentsScreen.js", "app/(console)/platform/flags/page.js", "app/(console)/platform/incidents/page.js"]) {
    ok(!/components\/console/.test(await read(f)), f);
  }
});

// --- the store, the operator and the callers -------------------------------------------
const store = await H.makeRoleStore({ name: "flaginc" });
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const F = await import("../lib/platform/flags.js");
const INC = await import("../lib/platform/incidents.js");
const { readNotices } = await import("../lib/admin/notices.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { NextRequest } = await import("./support/next-server-stub.js");
const db = () => C.platformDb();
const HOST = "localhost:3000";
const operatorId = store.users.operator.id;
await db().execute({ sql: "UPDATE users SET name = 'Flag Operator Ravi' WHERE id = ?", args: [operatorId] });
const JARS = {
  operator: { _platform: (await S.createSession({ userId: operatorId, kind: "operator", ttlMs: 10 * 60_000 })).token },
  "merchant-token-in-platform": { _platform: store.cookies.owner._admin },
  "merchant-support-token-in-platform": { _platform: store.cookies.support._admin },
};

async function call(caller, path, method, { body, query } = {}) {
  const route = await import(pathToFileURL(join(API, path, "route.js")).href);
  const headers = { host: HOST };
  if (method !== "GET") headers.origin = `http://${HOST}`;
  const jar = JARS[caller] || {};
  if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  let reqBody;
  if (body !== undefined && method !== "GET") {
    headers["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }
  const res = await route[method](new NextRequest(`http://${HOST}/api/platform/${path}${query ? `?${query}` : ""}`, { method, headers, body: reqBody }), { params: Promise.resolve({}) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: json, text };
}
const flags = (body) => call("operator", "flags", "POST", { body });
const incidents = (body) => call("operator", "incidents", "POST", { body });
const listFlags = async () => (await call("operator", "flags", "GET")).body;
const flagRow = async (key) => (await listFlags()).flags.find((f) => f.key === key);

// --- flags ----------------------------------------------------------------------------
await t("flags: the key rule is checked (400) and a new flag lists with its state, critical, expiry and the operator's name", async () => {
  eq((await flags({ flag: { key: "not-a-key" } })).status, 400, "a bad key");
  eq((await flags({ flag: { key: "ff_Upper" } })).status, 400, "upper case");
  eq((await flags({ flag: { key: "ff_x", expires_at: "not a date" } })).status, 400, "a bad expiry");
  const r = await flags({ flag: { key: "ff_new-search", description: "New search", default_on: false, critical: false, expires_at: "2099-01-01T00:00:00Z", create: true } });
  eq(r.status, 200, r.text);
  const again = await flags({ flag: { key: "ff_new-search", description: "Clobber", default_on: true, create: true } });
  eq(again.status, 409, "creating a key that exists");
  const list = await listFlags();
  ok(list.stores.some((s) => s.id === store.a.id) && list.stores.some((s) => s.id === store.b.id), "the store choices");
  const f = list.flags.find((x) => x.key === "ff_new-search");
  eq([f.description, f.default_on, f.critical, f.expires_at, f.updated_by, f.updated_by_name], ["New search", false, false, "2099-01-01T00:00:00.000Z", operatorId, "Flag Operator Ravi"]);
  eq(W.flagState(f).label, "Off");
  eq(f.fallback, true, "an unknown key falls back to on");
});

await t("flags: per-store overrides (the store and flag must exist), evaluated for that store only", async () => {
  eq((await flags({ override: { key: "ff_new-search", tenant: "missing-store", on: true } })).status, 404, "a missing store");
  eq((await flags({ override: { key: "ff_missing", tenant: store.a.id, on: true } })).status, 404, "a missing flag");
  eq((await flags({ override: { key: "ff_new-search", tenant: store.a.id, on: true } })).status, 200, "on for a");
  eq(W.flagState(await flagRow("ff_new-search")).label, "On for 1 store");
  eq(await F.flagEnabled("ff_new-search", store.a.id, { fallback: false }), true, "a on");
  eq(await F.flagEnabled("ff_new-search", store.b.id, { fallback: true }), false, "b follows the default");
  eq((await flags({ override: { key: "ff_new-search", tenant: store.b.id, on: false } })).status, 200, "off for b");
  eq((await flags({ override: { key: "ff_new-search", tenant: store.b.id, on: null } })).status, 200, "b removed");
  eq((await flagRow("ff_new-search")).tenants, { [store.a.id]: 1 }, "only a is left");
});

await t("flags: an edit keeps the overrides; emergency disable turns it off everywhere and clears them", async () => {
  const f = await flagRow("ff_new-search");
  eq((await flags({ flag: { key: f.key, description: "Edited", default_on: true, critical: true, tenants: f.tenants } })).status, 200);
  const edited = await flagRow("ff_new-search");
  eq([edited.description, edited.critical, edited.tenants, edited.expires_at], ["Edited", true, { [store.a.id]: 1 }, null], "edited, overrides kept, expiry cleared");
  eq(W.flagState(edited).label, "On for everyone");
  eq((await flags({ disable: { key: "ff_missing" } })).status, 404, "disable a missing flag");
  eq((await flags({ disable: { key: "ff_new-search" } })).status, 200);
  const off = await flagRow("ff_new-search");
  eq([off.default_on, off.tenants], [false, {}], "off and no overrides");
  eq(await F.flagEnabled("ff_new-search", store.a.id, { fallback: true }), false, "a critical flag is off on the next read");
});

await t("flags: an edit never writes overrides, and interleaved edits and overrides keep every change", async () => {
  eq((await flags({ flag: { key: "ff_race", description: "race", create: true } })).status, 200);
  const stale = await flagRow("ff_race"); // operator 1's form, loaded before any override
  const [o1, o2, edit] = await Promise.all([
    flags({ override: { key: "ff_race", tenant: store.a.id, on: true } }),
    flags({ override: { key: "ff_race", tenant: store.b.id, on: false } }),
    flags({ flag: { key: "ff_race", description: "edited", default_on: true, tenants: stale.tenants } }),
  ]);
  eq([o1.status, o2.status, edit.status], [200, 200, 200]);
  const after = await flagRow("ff_race");
  eq([after.description, after.default_on, after.tenants], ["edited", true, { [store.a.id]: 1, [store.b.id]: 0 }], "the edit and both overrides kept");
  eq((await flags({ flag: { key: "ff_race", description: "again", tenants: {} } })).status, 200, "an edit sending no overrides");
  eq((await flagRow("ff_race")).tenants, { [store.a.id]: 1, [store.b.id]: 0 }, "still kept");
  eq((await flags({ flag: { key: "ff_race", tenants: { [store.a.id]: 0 }, create: true } })).status, 409, "create can't reset them either");
  eq((await flags({ remove: { key: "ff_race" } })).status, 200);
});

await t("flags: a kill switch (a key in FLAG_FALLBACKS) refuses an expiry with plain words; ff_checkout stays on", async () => {
  for (const create of [true, false]) {
    const r = await flags({ flag: { key: "ff_checkout", default_on: true, critical: true, expires_at: "2020-01-01T00:00:00Z", create } });
    eq(r.status, 422, `${create ? "create" : "edit"}: ${r.text.slice(0, 120)}`);
    ok(/can't expire/.test(r.body?.error || ""), "plain words");
  }
  eq(await flagRow("ff_checkout"), undefined, "nothing written");
  eq(await F.flagEnabled("ff_checkout", store.a.id, { fallback: true }), true, "checkout stays on");
  eq((await flags({ flag: { key: "ff_self-signup", expires_at: "2099-01-01T00:00:00Z", create: true } })).status, 422, "the signup switch too");
});

await t("flags: history from audit_log, newest first, with the operator's name and no store on the rows", async () => {
  const h = (await call("operator", "flags", "GET", { query: "history=ff_new-search" })).body.history;
  eq(h.map((x) => x.action), ["flags.emergency_disable", "flags.set", "flags.override", "flags.override", "flags.override", "flags.set"]);
  ok(h.every((x) => x.by === "Flag Operator Ravi"), "by name");
  eq(h[2].changes, { store: store.b.id, on: "removed" }, "the removed override");
  const rows = (await db().execute({ sql: "SELECT tenant_id, actor, actor_kind FROM audit_log WHERE resource = 'flag:ff_new-search'" })).rows;
  ok(rows.length === 6 && rows.every((r) => r.tenant_id === null && r.actor === operatorId && r.actor_kind === "operator"), "operator rows with no store");
  eq((await call("operator", "flags", "GET", { query: "history=bad key" })).status, 400, "a bad key");
});

await t("flags: delete states the fallback, and the call sites match FLAG_FALLBACKS", async () => {
  await flags({ flag: { key: "ff_checkout", description: "kill switch", default_on: true, critical: true } });
  eq((await flagRow("ff_checkout")).fallback, true, "checkout falls back to on");
  eq((await flags({ remove: { key: "ff_new-search" } })).status, 200);
  eq((await flags({ remove: { key: "ff_new-search" } })).status, 404, "already gone");
  eq(await flagRow("ff_new-search"), undefined, "gone from the list");
  const checkout = await read("app/api/checkout/route.js");
  ok(/flagEnabled\("ff_checkout", [^\n]{0,80}?\{ fallback: true \}/.test(checkout), "checkout's call site falls back to on");
  const signup = await read("lib/platform/signup.js");
  ok(/SIGNUP_FLAG = "ff_self-signup"/.test(signup) && /flagEnabled\(SIGNUP_FLAG, null, \{ fallback: false \}\)/.test(signup), "signup's call site falls back to off");
  eq(F.FLAG_FALLBACKS, { ff_checkout: true, "ff_self-signup": false });
});

// --- incidents ----------------------------------------------------------------------------
const NOTE = "INTERNAL-NOTE-CANARY-7f3a";
const NOTE2 = "SECOND-NOTE-CANARY-91bc";
let storeInc;
let platformInc;

await t("incidents: open needs a title (400) and a real store (404); a platform-wide and a store incident open", async () => {
  eq((await incidents({ action: "open", title: "  " })).status, 400, "no title");
  eq((await incidents({ action: "open", title: "Ghost", tenant: "missing-store" })).status, 404, "a missing store");
  const p = await incidents({ action: "open", title: "Platform upgrade", publicMessage: "Brief maintenance tonight" });
  eq(p.status, 200, p.text);
  platformInc = p.body.incident;
  const s = await incidents({ action: "open", title: "Payments delayed", tenant: store.a.id, publicMessage: "Payouts are delayed", internalNote: NOTE });
  eq(s.status, 200, s.text);
  storeInc = s.body.incident;
  ok(/^inc_[0-9a-f]{16}$/.test(storeInc.id), "an inc_ id");
  eq([storeInc.tenant_id, storeInc.status, storeInc.internal_note], [store.a.id, "open", NOTE]);
});

await t("incidents: post an update, edit the note, resolve with a closing message; a resolved incident takes no update (409)", async () => {
  eq((await incidents({ action: "update", id: "inc_missing", publicMessage: "x" })).status, 404, "a missing incident");
  eq((await incidents({ action: "update", id: storeInc.id, publicMessage: " " })).status, 400, "an empty update");
  eq((await incidents({ action: "update", id: storeInc.id, publicMessage: "Payouts resume at 6pm" })).status, 200);
  eq((await incidents({ action: "note", id: storeInc.id, internalNote: NOTE2 })).status, 200);
  const row = (await db().execute({ sql: "SELECT public_message, internal_note FROM incidents WHERE id = ?", args: [storeInc.id] })).rows[0];
  eq([row.public_message, row.internal_note], ["Payouts resume at 6pm", NOTE2]);
  eq((await incidents({ action: "resolve", id: platformInc.id, closingMessage: "All done" })).status, 200);
  eq((await incidents({ action: "resolve", id: platformInc.id })).status, 409, "resolved twice");
  eq((await incidents({ action: "update", id: platformInc.id, publicMessage: "late" })).status, 409, "update after resolve");
});

await t("incidents: two concurrent resolves: one wins (one audit row, its closing message stays), the other gets 409", async () => {
  const inc = (await incidents({ action: "open", title: "Race", publicMessage: "racing" })).body.incident;
  const [a, b] = await Promise.all([incidents({ action: "resolve", id: inc.id, closingMessage: "first close" }), incidents({ action: "resolve", id: inc.id, closingMessage: "second close" })]);
  eq([a.status, b.status], [200, 409], "first wins");
  const rows = (await db().execute({ sql: "SELECT action, diff FROM audit_log WHERE resource = ? AND action = 'incident.resolve'", args: [`incident:${inc.id}`] })).rows;
  eq(rows.length, 1, "one resolve audit row");
  eq(JSON.parse(rows[0].diff), { closing_message: "first close" });
  eq((await db().execute({ sql: "SELECT public_message FROM incidents WHERE id = ?", args: [inc.id] })).rows[0].public_message, "first close", "the first closing message stays");
  const open2 = (await incidents({ action: "open", title: "Race 2" })).body.incident;
  const [u, res] = await Promise.all([incidents({ action: "update", id: open2.id, publicMessage: "late update" }), incidents({ action: "resolve", id: open2.id })]);
  ok(u.status === 200 || u.status === 409, `an update racing a resolve: ${u.status}`);
  eq(res.status, 200, "the resolve");
  await db().execute({ sql: "DELETE FROM incidents WHERE title IN ('Race', 'Race 2')" }); // keep the list counts below as they were
});

await t("incidents: audit rows are incident.*, carry the incident's store, name the operator, and never the note", async () => {
  const rows = (await db().execute({ sql: "SELECT action, tenant_id, actor, actor_kind, diff FROM audit_log WHERE resource IN (?, ?) ORDER BY at, id", args: [`incident:${storeInc.id}`, `incident:${platformInc.id}`] })).rows;
  eq(rows.map((r) => r.action), ["incident.open", "incident.open", "incident.update", "incident.update", "incident.resolve"]);
  for (const r of rows) {
    eq(`${r.actor}/${r.actor_kind}`, `${operatorId}/operator`, r.action);
    ok(!String(r.diff).includes("tenant.status"), "no tenant.status");
  }
  eq(rows.filter((r) => r.tenant_id === store.a.id).length, 3, "the store incident's rows carry its store");
  eq(rows.filter((r) => r.tenant_id === null).length, 2, "the platform incident's rows carry none");
  const all = (await db().execute("SELECT diff FROM audit_log")).rows.map((r) => String(r.diff)).join("\n");
  ok(!all.includes(NOTE) && !all.includes(NOTE2), "no audit row holds the internal note");
});

await t("incidents: the timeline, oldest first, with kinds, messages and the operator's name (old tenant.status rows too)", async () => {
  const tl = (await call("operator", "incidents", "GET", { query: `timeline=${storeInc.id}` })).body.timeline;
  eq(tl.map((x) => [x.kind, x.message]), [["open", "Payouts are delayed"], ["update", "Payouts resume at 6pm"], ["note", null]]);
  ok(tl.every((x) => x.by === "Flag Operator Ravi"), "by name");
  ok(!JSON.stringify(tl).includes(NOTE2), "no note text");
  const p = (await call("operator", "incidents", "GET", { query: `timeline=${platformInc.id}` })).body.timeline;
  eq(p.map((x) => [x.kind, x.message]), [["open", "Brief maintenance tonight"], ["resolve", "All done"]]);
  // an incident from before line 4: its rows say tenant.status and carry no store
  const old = "inc_0ld0ld0ld0ld0ld0";
  await db().execute({ sql: "INSERT INTO incidents (id, tenant_id, title, status, created_at) VALUES (?, ?, 'Old', 'resolved', '2026-01-01T00:00:00.000Z')", args: [old, store.b.id] });
  for (const [at, diff] of [["2026-01-01T00:00:00.000Z", { opened: "Old" }], ["2026-01-02T00:00:00.000Z", { resolved: true }]]) {
    await db().execute({ sql: "INSERT INTO audit_log (id, at, actor, actor_kind, tenant_id, action, resource, diff) VALUES (?, ?, 'bootstrap', 'bootstrap', NULL, 'tenant.status', ?, ?)", args: [S.newId("a"), at, `incident:${old}`, JSON.stringify(diff)] });
  }
  const legacy = (await call("operator", "incidents", "GET", { query: `timeline=${old}` })).body.timeline;
  eq(legacy.map((x) => [x.kind, x.by]), [["open", "Bootstrap operator"], ["resolve", "Bootstrap operator"]]);
  eq((await call("operator", "incidents", "GET", { query: "timeline=inc_missing" })).status, 404, "a missing incident");
});

await t("incidents: open first, then resolved; the scope filter; 50 a page with the total", async () => {
  const all = (await call("operator", "incidents", "GET")).body;
  eq(all.incidents.map((i) => i.status), ["open", "resolved", "resolved"], "open first");
  eq([all.total, all.openCount, all.pageSize], [3, 1, 50]);
  eq(all.incidents[0].store_name, store.a.tenant.name, "the store's name");
  eq((await call("operator", "incidents", "GET", { query: "scope=platform" })).body.incidents.map((i) => i.id), [platformInc.id], "platform-wide only");
  eq((await call("operator", "incidents", "GET", { query: `scope=${store.a.id}` })).body.incidents.map((i) => i.id), [storeInc.id], "one store");
  for (let i = 0; i < 52; i++) {
    await db().execute({ sql: "INSERT INTO incidents (id, tenant_id, title, status, created_at, resolved_at) VALUES (?, NULL, ?, 'resolved', ?, ?)", args: [`inc_page${String(i).padStart(12, "0")}`, `Paged ${i}`, `2025-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, "2025-02-01T00:00:00.000Z"] });
  }
  const p1 = (await call("operator", "incidents", "GET", { query: "page=1" })).body;
  const p2 = (await call("operator", "incidents", "GET", { query: "page=2" })).body;
  eq([p1.incidents.length, p2.incidents.length, p1.total], [50, 5, 55]);
  eq(p1.incidents[0].id, storeInc.id, "the open one leads page 1");
  ok(!p1.incidents.some((i) => p2.incidents.some((j) => j.id === i.id)), "no row on both pages");
});

// --- least trusted ----------------------------------------------------------------------
await t("least trusted: a merchant's notices hold the public message, never the internal note", async () => {
  for (const [tenant, want] of [[store.a.tenant, 1], [store.b.tenant, 0]]) {
    const n = await withTenant(tenant, () => readNotices({ member: { id: store.users.support.id } }));
    eq(n.incidents.length, want, `${tenant.id} sees its own open incidents`);
    ok(!JSON.stringify(n).includes(NOTE) && !JSON.stringify(n).includes(NOTE2), "no note");
  }
  const raw = await INC.openIncidentsFor(store.a.id);
  ok(!JSON.stringify(raw).includes(NOTE2) && raw.every((i) => !("internal_note" in i)), "the banner read has no note column");
});

await t("least trusted: the merchant Audit log read (support 403, owner allowed) never holds the internal note", async () => {
  const support = await store.call("support", "audit", "GET", { query: "limit=200" });
  eq(support.status, 403, "support may not read the audit log");
  ok(!support.text.includes(NOTE) && !support.text.includes(NOTE2), "support's answer");
  const owner = await store.call("owner", "audit", "GET", { query: "limit=200&facets=1" });
  eq(owner.status, 200, owner.text.slice(0, 160));
  ok(owner.body.entries.some((e) => e.action === "incident.open"), "the owner sees the incident rows");
  ok(!owner.text.includes(NOTE) && !owner.text.includes(NOTE2), "the owner's answer has no note");
});

await t("P3-D least trusted: a store incident with no public message keeps its title from the owner's Audit log until a public message is posted", async () => {
  const TITLE = "Title canary P3D 7c1e";
  const open = await call("operator", "incidents", "POST", { body: { action: "open", title: TITLE, tenant: store.a.id, internalNote: "note" } });
  eq(open.status, 200, open.text.slice(0, 160));
  const owner = await store.call("owner", "audit", "GET", { query: "limit=200&facets=1" });
  eq(owner.status, 200);
  ok(!owner.text.includes(TITLE), "the owner's answer holds the title before any public message");
  const timeline = (await call("operator", "incidents", "GET", { query: `timeline=${open.body.incident.id}` })).body.timeline;
  eq(timeline[0]?.kind, "open", "the operator's timeline still has the open");
  const raw = (await db().execute({ sql: "SELECT diff FROM audit_log WHERE action = 'incident.open' AND resource = ?", args: [`incident:${open.body.incident.id}`] })).rows[0];
  ok(String(raw?.diff).includes(TITLE), "operators keep the title (under operator_only)");
  eq((await call("operator", "incidents", "POST", { body: { action: "update", id: open.body.incident.id, publicMessage: "Checkout is slow" } })).status, 200, "update");
  const after = await store.call("owner", "audit", "GET", { query: "limit=200" });
  ok(after.text.includes(TITLE), "once public, a fresh row names the title");
  eq((await call("operator", "incidents", "POST", { body: { action: "resolve", id: open.body.incident.id } })).status, 200, "resolve");
});

await t("least trusted: a merchant token in _platform gets 401 on every flag and incident write, and nothing changes", async () => {
  await flags({ flag: { key: "ff_guarded", default_on: false } });
  const count = async () => {
    const q = async (sql) => JSON.stringify((await db().execute(sql)).rows);
    return [await q("SELECT * FROM feature_flags ORDER BY key"), await q("SELECT * FROM incidents ORDER BY id"), await q("SELECT COUNT(*) AS n FROM audit_log")].join("|");
  };
  const before = await count();
  const writes = [
    ["flags", { flag: { key: "ff_guarded", default_on: true } }],
    ["flags", { override: { key: "ff_guarded", tenant: store.a.id, on: true } }],
    ["flags", { disable: { key: "ff_checkout" } }],
    ["flags", { remove: { key: "ff_guarded" } }],
    ["incidents", { action: "open", title: "Forged" }],
    ["incidents", { action: "update", id: storeInc.id, publicMessage: "Forged" }],
    ["incidents", { action: "note", id: storeInc.id, internalNote: "Forged" }],
    ["incidents", { action: "resolve", id: storeInc.id }],
  ];
  for (const caller of ["merchant-token-in-platform", "merchant-support-token-in-platform"]) {
    for (const [path, body] of writes) {
      const r = await call(caller, path, "POST", { body });
      eq(r.status, 401, `${caller} ${path} ${JSON.stringify(body).slice(0, 40)}`);
      ok(!r.text.includes(NOTE) && !r.text.includes(NOTE2), "no note in the 401");
    }
    for (const [path, query] of [["flags", ""], ["flags", "history=ff_guarded"], ["incidents", ""], ["incidents", `timeline=${storeInc.id}`]]) {
      const r = await call(caller, path, "GET", { query });
      eq(r.status, 401, `${caller} GET ${path}?${query}`);
      ok(!r.text.includes(NOTE) && !r.text.includes(NOTE2) && !r.text.includes(store.a.tenant.name), "nothing in the 401");
    }
  }
  eq(await count(), before, "flags, incidents and the audit log are unchanged");
});

await t("no network: nothing reached fetch()", () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
