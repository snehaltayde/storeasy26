// Apps: installing first-party plugins (Phase 4 line 1, docs/plans/phase-4.md "Line 1").
//   pnpm test:apps
// The catalog's contract (manifests, defaults, kill-switch flag keys), the
// settings checks (unknown keys refused, secrets write-only, no refusal quotes
// a value), the routes as every caller (apps.read for every role, apps.manage
// for admin and owner only, 401 signed out and for another store's owner),
// install / turn off / turn on / uninstall / install again, two installs at
// once, the operator kill switch (ff_plugin-<id>), the audit rows (and no
// secret in any of them), Activity for audit.read holders only, and Edge
// safety of lib/plugins. Outside services are blanked and fetch() is blocked;
// every database is a throwaway file: database.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-apps-default.db";
process.env.PLATFORM_SECRET = "test-apps-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
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

const { APP_PERMISSIONS, scopeAllows, roleAllows } = await import("../lib/platform/authz.js");
const M = await import("../lib/plugins/manifest.js");
const CAT = await import("../lib/plugins/catalog.js");
const SET = await import("../lib/plugins/settings.js");
const FLAGS = await import("../lib/platform/flags.js");
const { listAudit } = await import("../lib/platform/audit.js");
const { NAV } = await import("../lib/admin/nav.js");

// a fixture plugin with a secret, a scope and every plain kind
const SECRET = "appsecretcanary0";
const SECRET2 = "appsecretcanary1";
const FIXTURE = {
  id: "fixture-secrets",
  name: "Fixture secrets",
  version: "0.1.0",
  summary: "A test plugin.",
  description: "A test plugin with a secret.",
  icon: "Puzzle",
  author: { name: "Tests" },
  scopes: ["orders.read"],
  settings: [
    { key: "api_key", kind: "secret", label: "API key" },
    { key: "greeting", kind: "text", label: "Greeting", max: 20, default: "Hi" },
    { key: "count", kind: "number", label: "Count", min: 1, max: 5 },
    { key: "show", kind: "boolean", label: "Show", default: true },
    { key: "tone", kind: "choice", label: "Tone", options: ["calm", "bold"] },
  ],
};
const undoFixture = CAT.registerPlugin(FIXTURE);

// --- the catalog and its checks ------------------------------------------------------
await t("APP_PERMISSIONS: exactly storefront.read, offers.read and orders.read (no customer details, owner decision); scopeAllows", () => {
  eq(Object.keys(APP_PERMISSIONS).join(","), "storefront.read,offers.read,orders.read", "scopes:");
  ok(!("customers.read" in APP_PERMISSIONS), "no customers.read");
  ok(Object.isFrozen(APP_PERMISSIONS), "frozen");
  // the plugin permission table is never a Shopify scope list (test:shopify-boundary keeps the only scope list in lib/platform/oauth.js)
  eq(Object.keys(APP_PERMISSIONS).filter((k) => !/^[a-z]+\.read$/.test(k) || /_/.test(k)).join(","), "", "keys that are not <area>.read names:");
  ok(scopeAllows(["orders.read"], "orders.read") && !scopeAllows(["orders.read"], "offers.read") && !scopeAllows(null, "orders.read"), "scopeAllows");
});

await t("roles: apps.read for every role, apps.manage for admin and owner only", () => {
  for (const r of ["owner", "admin", "staff", "support"]) ok(roleAllows(r, "apps.read"), `${r} apps.read`);
  eq(["owner", "admin", "staff", "support"].filter((r) => roleAllows(r, "apps.manage")).join(","), "owner,admin", "apps.manage:");
});

await t("catalog: checkCatalog() is [] with Trust badges (no scopes, up to 4 badges) and the fixture registered", () => {
  eq(CAT.checkCatalog().join("\n"), "", "problems:");
  const tb = CAT.pluginById("trust-badges");
  ok(tb && Object.isFrozen(tb) && Object.isFrozen(tb.settings[0].fields), "frozen manifest");
  eq(tb.scopes.length, 0, "trust badges asks for nothing:");
  eq(tb.settings[0].kind, "list", "badges kind:");
  eq(tb.settings[0].max, 4, "badges max:");
  {
    // Phase 9: first-party plugins sit between trust-badges and the fixture; membership, not position
    const ids = CAT.catalog().map((m) => m.id);
    eq(ids[0], "trust-badges", "catalog starts with trust-badges:");
    eq(ids.at(-1), "fixture-secrets", "catalog ends with the fixture:");
    for (const id of ["reviews", "subscriptions", "shiprocket", "whatsapp", "ai-copilot"]) ok(ids.includes(id), `catalog has ${id}`);
  }
});

await t("kill switch flag key: ff_plugin-<id> matches lib/platform/flags.js KEY_RE (the copy in catalog.js agrees)", () => {
  eq(String(CAT.KILL_FLAG_RE), String(FLAGS.FLAG_KEY_RE), "regexes:");
  ok(FLAGS.FLAG_KEY_RE.test(CAT.killFlag("trust-badges")), "ff_plugin-trust-badges");
});

await t("manifest checks: a bad id, version, icon, scope, setting kind, secret default and unknown field are each refused", () => {
  const good = { ...FIXTURE, id: "x-good" };
  eq(M.checkManifest(good).join(","), "", "good:");
  const bad = (patch, word) => ok(M.checkManifest({ ...good, ...patch }).some((p) => p.includes(word)), `${JSON.stringify(patch)} → ${word}`);
  bad({ id: "Bad_Id" }, "slug");
  bad({ version: "1.0" }, "semver");
  bad({ icon: "Rocket" }, "icon");
  bad({ scopes: ["customers.read"] }, "unknown scope");
  bad({ scopes: ["orders:read"] }, "unknown scope");
  bad({ settings: [{ key: "a", kind: "html" }] }, "unknown kind");
  bad({ settings: [{ key: "s", kind: "secret", default: "x" }] }, "default");
  bad({ settings: [{ key: "l", kind: "list", max: 3, fields: [{ key: "s", kind: "secret" }] }] }, "list field");
  bad({ settings: [{ key: "a", kind: "text" }, { key: "a", kind: "text" }] }, "twice");
  bad({ widgets: [] }, "unknown field");
  let threw = false;
  try {
    CAT.registerPlugin({ ...FIXTURE });
  } catch {
    threw = true;
  }
  ok(threw, "a duplicate id can't be registered");
});

await t("settings checks: list limits and fields, unknown keys refused, defaults; no message quotes a value", () => {
  const tb = CAT.pluginById("trust-badges");
  const defaults = SET.defaultSettings(tb);
  eq(defaults.badges.length, 3, "three default badges:");
  ok(SET.checkSettings(tb, defaults).ok, "defaults pass");
  const five = Array.from({ length: 5 }, () => ({ icon: "truck", label: "Free" }));
  ok(SET.checkSettings(tb, { badges: five }).errors.badges.includes("limit is 4"), "five badges refused");
  const r = SET.checkSettings(tb, { badges: [{ icon: SECRET, label: SECRET.repeat(5) }] });
  ok(!r.ok && r.errors["badges.0.icon"] && r.errors["badges.0.label"], `icon and label refused: ${JSON.stringify(r.errors)}`);
  ok(!JSON.stringify(r.errors).includes(SECRET), "no value quoted");
  ok(!SET.checkSettings(tb, { badges: [{ icon: "truck", label: "x", extra: 1 }] }).ok, "an unknown item key is refused");
  ok(SET.checkSettings(tb, { badges: defaults.badges, nope: 1 }).errors._?.includes('"nope"'), "an unknown setting is refused");
  ok(SET.checkSettings(tb, { badges: [{ icon: "truck", label: "" }] }).errors["badges.0.label"], "a required label");
  const f = CAT.pluginById("fixture-secrets");
  const bad = SET.checkSettings(f, { api_key: 12345, greeting: SECRET.repeat(3), count: 9 });
  ok(!bad.ok && bad.errors.api_key && bad.errors.greeting && bad.errors.count, JSON.stringify(bad.errors));
  ok(!JSON.stringify(bad.errors).includes(SECRET) && !JSON.stringify(bad.errors).includes("12345"), "no value quoted");
  const set = SET.checkSettings(f, { api_key: SECRET, greeting: "Hey" }, { settings: { greeting: "Hi", show: true } });
  ok(set.ok, JSON.stringify(set.errors));
  eq(set.secretUpdates.api_key, SECRET, "secret update:");
  ok(!("api_key" in set.settings), "the secret is not in the plain part");
  eq(set.changed.join(","), "greeting,show", "changed keys (show left out = removed):");
  eq(set.hiddenChanged, 1, "hidden count:");
  eq(SET.checkSettings(f, { api_key: null }).secretUpdates.api_key, null, "null clears");
  eq(Object.keys(SET.checkSettings(f, {}).secretUpdates).length, 0, "absent keeps");
});

// --- the stores ---------------------------------------------------------------------
const store = await H.makeRoleStore({ name: "apps" });
const { a, b, call } = store;
const hostB = b.tenant.domains[0];
const MERCHANT = ["owner", "admin", "staff", "support"];
const OPS = ["operator-support", "operator-support-entry"];
const auditRows = async (tenantId = a.id) => listAudit({ tenantId, limit: 200 });

await t("signed out: 401 on every apps route; another store's owner: 401 on store A", async () => {
  for (const caller of ["signed-out", "owner-b"]) {
    eq((await call(caller, "apps", "GET")).status, 401, `${caller} GET apps:`);
    eq((await call(caller, "apps", "POST", { body: { install: { pluginId: "trust-badges", scopes: [] } } })).status, 401, `${caller} POST apps:`);
    eq((await call(caller, "apps/[id]", "GET", { params: { id: "pin_0000000000000000" } })).status, 401, `${caller} GET apps/[id]:`);
    eq((await call(caller, "apps/[id]", "POST", { params: { id: "pin_0000000000000000" }, body: { disable: true } })).status, 401, `${caller} POST apps/[id]:`);
  }
});

await t("empty store: every role reads an empty Installed list and the catalog", async () => {
  for (const caller of [...MERCHANT, ...OPS]) {
    const r = await call(caller, "apps", "GET");
    eq(r.status, 200, `${caller}:`);
    eq(r.body.installs.length, 0, `${caller} installs:`);
    {
      const ids = r.body.catalog.map((c) => c.id);
      ok(ids[0] === "trust-badges" && ids.at(-1) === "fixture-secrets" && ["reviews", "subscriptions", "shiprocket", "whatsapp", "ai-copilot"].every((id) => ids.includes(id)), `${caller} catalog: ${ids.join(",")}`);
    }
    ok(r.body.catalog.every((c) => c.available && c.installId === null), `${caller} available`);
  }
  const fx = (await call("owner", "apps", "GET")).body.catalog.find((c) => c.id === "fixture-secrets");
  eq(fx.scopes[0].words, APP_PERMISSIONS["orders.read"], "scopes carry their words:");
});

await t("staff, support and operator support: 403 on install, and nothing is installed", async () => {
  for (const caller of ["staff", "support", ...OPS]) {
    const r = await call(caller, "apps", "POST", { body: { install: { pluginId: "trust-badges", scopes: [] } } });
    eq(r.status, 403, `${caller}:`);
  }
  eq((await call("owner", "apps", "GET")).body.installs.length, 0, "still none:");
});

await t("install refusals: an unknown plugin (404), approved scopes that differ (409), no body (400)", async () => {
  eq((await call("owner", "apps", "POST", { body: { install: { pluginId: "nope", scopes: [] } } })).status, 404, "unknown:");
  const r = await call("owner", "apps", "POST", { body: { install: { pluginId: "fixture-secrets", scopes: [] } } });
  eq(r.status, 409, "scopes:");
  eq(r.body.code, "SCOPES_CHANGED", "code:");
  eq((await call("owner", "apps", "POST", { body: {} })).status, 400, "no install:");
  eq((await call("owner", "apps", "GET")).body.installs.length, 0, "still none:");
});

let tbId;
await t("two admins install Trust badges at once: one install, the other hears \"Already installed\"", async () => {
  const body = { install: { pluginId: "trust-badges", scopes: [] } };
  const [x, y] = await Promise.all([call("owner", "apps", "POST", { body }), call("admin", "apps", "POST", { body })]);
  const statuses = [x.status, y.status].sort().join(",");
  eq(statuses, "200,409", `statuses (${x.text.slice(0, 120)} | ${y.text.slice(0, 120)}):`);
  const won = x.status === 200 ? x : y;
  const lost = x.status === 200 ? y : x;
  eq(lost.body.code, "ALREADY_INSTALLED", "loser code:");
  tbId = won.body.install.id;
  ok(/^pin_[0-9a-f]{16}$/.test(tbId), `id ${tbId}`);
  eq(won.body.install.status, "enabled", "on after install:");
  eq(won.body.install.settings.badges.length, 3, "default badges:");
  eq(won.body.install.grantedScopes.length, 0, "granted none:");
  const list = (await call("support", "apps", "GET")).body;
  eq(list.installs.length, 1, "one live install:");
  eq(list.catalog.find((c) => c.id === "trust-badges").installId, tbId, "catalog points at it:");
  ok(["Someone on your team"].includes(list.installs[0].installedByName) || typeof list.installs[0].installedByName === "string", "a plain name");
});

let fxId;
await t("install with scopes: the approved scopes are recorded; the audit row says apps.install", async () => {
  const r = await call("admin", "apps", "POST", { body: { install: { pluginId: "fixture-secrets", scopes: ["orders.read"] } } });
  eq(r.status, 200, r.text.slice(0, 200));
  fxId = r.body.install.id;
  eq(r.body.install.grantedScopes.join(","), "orders.read", "granted:");
  eq(r.body.install.secretsSet.api_key, false, "secret not set:");
  const rows = (await auditRows()).filter((x) => x.action === "apps.install");
  eq(rows.length, 2, "two install rows:");
  ok(rows.some((x) => x.resource === `app:${fxId}`), "resource app:<id>");
});

await t("staff, support and operator support: 403 on turn off, turn on, uninstall and settings; the install is unchanged", async () => {
  for (const caller of ["staff", "support", ...OPS]) {
    for (const body of [{ disable: true }, { enable: true }, { uninstall: true }, { settings: { badges: [] } }]) {
      eq((await call(caller, "apps/[id]", "POST", { params: { id: tbId }, body })).status, 403, `${caller} ${Object.keys(body)[0]}:`);
    }
    eq((await call(caller, "apps/[id]", "GET", { params: { id: tbId } })).status, 200, `${caller} reads it:`);
  }
  const d = (await call("owner", "apps/[id]", "GET", { params: { id: tbId } })).body.install;
  eq(d.status, "enabled", "still on:");
  eq(d.settings.badges.length, 3, "same settings:");
});

await t("settings: a secret is saved encrypted, shown only as set, and never reaches a response or an audit row", async () => {
  const bad = await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { settings: { api_key: SECRET, greeting: SECRET.repeat(3) } } });
  eq(bad.status, 422, "a refusal:");
  ok(bad.body.errors.greeting, "per field");
  ok(!bad.text.includes(SECRET), "the refusal holds no secret");
  const unknown = await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { settings: { api_key: SECRET, nope: true } } });
  eq(unknown.status, 422, "unknown key:");
  ok(!unknown.text.includes(SECRET), "no secret");
  const okr = await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { settings: { api_key: SECRET, greeting: "Hello", show: true, count: 3, tone: "calm" } } });
  eq(okr.status, 200, okr.text.slice(0, 200));
  eq(okr.body.install.secretsSet.api_key, true, "set:");
  eq(okr.body.install.settings.greeting, "Hello", "greeting:");
  ok(!okr.text.includes(SECRET) && !okr.text.includes("secrets_enc"), "no secret in the answer");
  const row = await a.run(async () => (await import("../lib/db.js")).db.selectFrom("plugin_installs").selectAll().where("id", "=", fxId).executeTakeFirst());
  ok(row.secrets_enc && !row.secrets_enc.includes(SECRET) && !row.settings.includes(SECRET), "stored encrypted only");
  // keep it: a later save without api_key leaves the secret set
  const keep = await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { settings: { greeting: "Hey", show: true, count: 3, tone: "calm" } } });
  eq(keep.body.install.secretsSet.api_key, true, "kept:");
  const replace = await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { settings: { api_key: SECRET2, greeting: "Hey", show: true, count: 3, tone: "calm" } } });
  eq(replace.status, 200, "replace:");
  const { decryptJson } = await import("../lib/platform/crypto.js");
  const after = await a.run(async () => (await import("../lib/db.js")).db.selectFrom("plugin_installs").select("secrets_enc").where("id", "=", fxId).executeTakeFirst());
  eq((await decryptJson(after.secrets_enc)).api_key, SECRET2, "replaced:");
  for (const caller of [...MERCHANT, ...OPS]) {
    for (const [path, opts] of [["apps", {}], ["apps/[id]", { params: { id: fxId } }]]) {
      const r = await call(caller, path, "GET", opts);
      ok(!r.text.includes(SECRET) && !r.text.includes(SECRET2) && !r.text.includes("secrets_enc") && !/"secrets"\s*:/.test(r.text), `${caller} GET ${path}`);
    }
  }
  const rows = (await auditRows()).filter((x) => x.action === "apps.settings");
  eq(rows.length, 3, "three settings rows:");
  ok(rows.every((x) => !String(x.diff).includes(SECRET) && !String(x.diff).includes(SECRET2)), "no secret in a diff");
  const first = JSON.parse(rows[rows.length - 1].diff);
  eq(first.hidden_fields_changed, 1, "hidden count:");
  ok(first.changed.includes("greeting") && !first.changed.includes("api_key"), `changed keys: ${rows[rows.length - 1].diff}`);
  const cleared = await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { settings: { api_key: null, greeting: "Hey" } } });
  eq(cleared.body.install.secretsSet.api_key, false, "cleared:");
});

await t("Trust badges settings: edited through the route; five badges refused with the limit in words", async () => {
  const r = await call("admin", "apps/[id]", "POST", { params: { id: tbId }, body: { settings: { badges: [{ icon: "leaf", label: "Plant based" }] } } });
  eq(r.status, 200, r.text.slice(0, 200));
  eq(r.body.install.settings.badges[0].label, "Plant based", "saved:");
  const five = Array.from({ length: 5 }, () => ({ icon: "truck", label: "Free" }));
  const no = await call("admin", "apps/[id]", "POST", { params: { id: tbId }, body: { settings: { badges: five } } });
  eq(no.status, 422, "five:");
  ok(no.body.errors.badges.includes("limit is 4"), no.text);
});

await t("turn off keeps settings, turn on again, a repeat is refused (409); each is audited", async () => {
  const off = await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { disable: true } });
  eq(off.status, 200, off.text.slice(0, 200));
  eq(off.body.install.status, "disabled", "off:");
  eq(off.body.install.settings.badges[0].label, "Plant based", "settings kept:");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { disable: true } })).status, 409, "off twice:");
  const on = await call("admin", "apps/[id]", "POST", { params: { id: tbId }, body: { enable: true } });
  eq(on.body.install.status, "enabled", "on:");
  eq((await call("admin", "apps/[id]", "POST", { params: { id: tbId }, body: { enable: true } })).status, 409, "on twice:");
  const rows = await auditRows();
  ok(rows.some((x) => x.action === "apps.disable" && x.resource === `app:${tbId}`), "apps.disable");
  ok(rows.some((x) => x.action === "apps.enable" && x.resource === `app:${tbId}`), "apps.enable");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { enable: true, disable: true } })).status, 400, "two at once:");
});

await t("Activity: owner and admin get this install's audit rows; staff and support get no activity key", async () => {
  for (const caller of ["owner", "admin"]) {
    const r = await call(caller, "apps/[id]", "GET", { params: { id: tbId } });
    ok(Array.isArray(r.body.activity) && r.body.activity.length >= 4, `${caller} activity`);
    ok(r.body.activity.every((x) => ["apps.install", "apps.enable", "apps.disable", "apps.settings"].includes(x.action)), "only this install's rows");
  }
  for (const caller of ["staff", "support", ...OPS]) {
    const r = await call(caller, "apps/[id]", "GET", { params: { id: tbId } });
    ok(!("activity" in r.body), `${caller} has no activity`);
    eq(Object.keys(r.body).sort().join(","), "install,ok,plugin", `${caller} keys:`);
  }
});

await t("kill switch: ff_plugin-trust-badges off for store A marks it turned off by Storeasy, hides Install and refuses turn on and install", async () => {
  await FLAGS.setFlag({ key: CAT.killFlag("trust-badges"), description: "Trust badges", default_on: true, create: true, actor: "operator" });
  await FLAGS.setFlagOverride({ key: CAT.killFlag("trust-badges"), tenant: a.id, on: false, actor: "operator" });
  FLAGS.__resetFlagCache();
  const list = (await call("support", "apps", "GET")).body;
  eq(list.installs.find((x) => x.id === tbId).killed, true, "install killed:");
  eq(list.catalog.find((c) => c.id === "trust-badges").available, false, "unavailable in Browse:");
  const inst = await call("owner", "apps", "POST", { body: { install: { pluginId: "trust-badges", scopes: [] } } });
  eq(inst.body?.code, "TURNED_OFF_BY_STOREASY", "install refused:");
  eq((await call("owner", "apps/[id]", "GET", { params: { id: tbId } })).body.install.killed, true, "its page says so:");
  await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { disable: true } });
  const on = await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { enable: true } });
  eq(on.status, 409, "turn on refused:");
  eq(on.body.code, "TURNED_OFF_BY_STOREASY", "code:");
  // store B is not affected
  eq((await call("owner-b", "apps", "GET", { host: hostB })).body.catalog.find((c) => c.id === "trust-badges").available, true, "store B still has it:");
  await FLAGS.setFlagOverride({ key: CAT.killFlag("trust-badges"), tenant: a.id, on: true, actor: "operator" });
  FLAGS.__resetFlagCache();
  eq((await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { enable: true } })).status, 200, "on again once Storeasy allows it:");
});

await t("uninstall archives the row (nothing deleted); it leaves Installed; installing again is a fresh install with fresh settings", async () => {
  const r = await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { uninstall: true } });
  eq(r.status, 200, r.text.slice(0, 200));
  eq(r.body.install.status, "uninstalled", "status:");
  eq((await call("owner", "apps/[id]", "GET", { params: { id: tbId } })).status, 404, "gone from its page:");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { enable: true } })).status, 404, "can't turn on:");
  ok(!(await call("owner", "apps", "GET")).body.installs.some((x) => x.id === tbId), "not listed");
  const kept = await a.run(async () => (await import("../lib/db.js")).db.selectFrom("plugin_installs").selectAll().where("id", "=", tbId).executeTakeFirst());
  ok(kept && kept.status === "uninstalled" && kept.uninstalled_at && kept.uninstalled_by, "the row is kept, archived");
  const again = await call("owner", "apps", "POST", { body: { install: { pluginId: "trust-badges", scopes: [] } } });
  eq(again.status, 200, again.text.slice(0, 200));
  ok(again.body.install.id !== tbId, "a new id");
  eq(again.body.install.settings.badges.length, 3, "fresh defaults:");
  ok((await auditRows()).some((x) => x.action === "apps.uninstall" && x.resource === `app:${tbId}`), "apps.uninstall audited");
});

await t("uninstall clears the secrets: secrets_enc is null and no secret key is listed in the row", async () => {
  const set = await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { settings: { api_key: `  ${SECRET}  `, greeting: "Hey" } } });
  eq(set.body?.install?.secretsSet?.api_key, true, "set:");
  const { decryptJson } = await import("../lib/platform/crypto.js");
  const before = await a.run(async () => (await import("../lib/db.js")).db.selectFrom("plugin_installs").select("secrets_enc").where("id", "=", fxId).executeTakeFirst());
  eq((await decryptJson(before.secrets_enc)).api_key, SECRET, "the secret is stored trimmed:");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { uninstall: true } })).status, 200, "uninstalled:");
  const row = await a.run(async () => (await import("../lib/db.js")).db.selectFrom("plugin_installs").selectAll().where("id", "=", fxId).executeTakeFirst());
  eq(row.status, "uninstalled", "status:");
  eq(row.secrets_enc, null, "secrets_enc:");
  ok(!row.settings.includes("__secret_keys") && !row.settings.includes(SECRET), `settings: ${row.settings}`);
  const again = await call("owner", "apps", "POST", { body: { install: { pluginId: "fixture-secrets", scopes: ["orders.read"] } } });
  eq(again.status, 200, "installed again:");
  fxId = again.body.install.id;
  eq(again.body.install.secretsSet.api_key, false, "fresh: no secret:");
});

await t("a cache that can't be told never turns a saved write into a refusal (install, turn off, on, uninstall)", async () => {
  const { __setCacheTestHooks } = await import("../lib/cache.js");
  __setCacheTestHooks({ onInvalidate: () => { throw new Error("cache down"); } });
  try {
    const off = await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { disable: true } });
    eq(off.status, 200, `off: ${off.text.slice(0, 160)}`);
    eq((await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { enable: true } })).status, 200, "on:");
    eq((await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { settings: { greeting: "Yo" } } })).status, 200, "settings:");
    eq((await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { uninstall: true } })).status, 200, "uninstall:");
    const again = await call("owner", "apps", "POST", { body: { install: { pluginId: "fixture-secrets", scopes: ["orders.read"] } } });
    eq(again.status, 200, "install:");
    fxId = again.body.install.id;
  } finally {
    __setCacheTestHooks({});
  }
});

await t("kill switch fails closed for install and turn on: unreadable flags refuse in plain words (503); turn off still works", async () => {
  const I = await import("../lib/plugins/installs.js");
  I.__setKillSwitchReader(async () => {
    throw new Error("control plane down");
  });
  try {
    const words = "Storeasy can't check this app right now. Try again in a minute.";
    const off = await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { disable: true } });
    eq(off.status, 200, "turn off is not a kill-switch question:");
    const on = await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { enable: true } });
    eq(on.status, 503, "turn on:");
    eq(on.body.error, words, "words:");
    eq((await call("owner", "apps/[id]", "GET", { params: { id: fxId } })).body.install.status, "disabled", "still off:");
    eq((await call("owner", "apps/[id]", "POST", { params: { id: fxId }, body: { uninstall: true } })).status, 200, "uninstall works:");
    const inst = await call("owner", "apps", "POST", { body: { install: { pluginId: "fixture-secrets", scopes: ["orders.read"] } } });
    eq(inst.status, 503, "install:");
    eq(inst.body.error, words, "install words:");
    eq((await call("owner", "apps", "GET")).body.installs.filter((x) => x.pluginId === "fixture-secrets").length, 0, "nothing installed:");
  } finally {
    I.__setKillSwitchReader(null);
  }
});

await t("another store: store B's owner sees none of store A's installs, and A's ids are not found on B", async () => {
  const r = await call("owner-b", "apps", "GET", { host: hostB });
  eq(r.status, 200, "B reads:");
  eq(r.body.installs.length, 0, "B has none:");
  eq((await call("owner-b", "apps/[id]", "GET", { host: hostB, params: { id: fxId } })).status, 404, "A's id on B:");
  eq((await call("owner-b", "apps/[id]", "POST", { host: hostB, params: { id: fxId }, body: { disable: true } })).status, 404, "A's id on B (write):");
});

await t("a malformed id is a not-found", async () => {
  eq((await call("owner", "apps/[id]", "GET", { params: { id: "../etc" } })).status, 404, "malformed:");
});

await t("nav: Apps is in the Store group, gated on apps.read, its page row exists", async () => {
  const store = NAV.find((g) => g.label === "Store");
  const item = store.items.find((i) => i.id === "apps");
  ok(item, "an Apps item");
  eq(item.href, "/admin/apps", "href:");
  eq(item.action, "apps.read", "action:");
  const { ADMIN_PAGES } = await import("./support/admin-pages.js");
  ok(ADMIN_PAGES.some((p) => p.page === "apps") && ADMIN_PAGES.some((p) => p.page === "apps/[id]"), "admin-pages rows");
});

await t("edge safety: lib/plugins (manifest, catalog, settings, trust badges) imports no node: module", async () => {
  for (const f of ["lib/plugins/manifest.js", "lib/plugins/catalog.js", "lib/plugins/settings.js", "lib/plugins/first-party/trust-badges/manifest.js"]) {
    ok(!/from\s+["']node:/.test(await readFile(join(ROOT, f), "utf8")), f);
  }
});

await t("no network: nothing reached fetch()", () => eq(network.length, 0, network.join(", ")));

undoFixture();
await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
