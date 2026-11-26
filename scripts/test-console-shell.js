// The new console shell (Phase 0 line 8, docs/plans/phase-0.md "Line 8" §2-§3).
//   pnpm test:console-shell
// No browser, no network. This suite proves:
//   1. the nav model (lib/admin/nav.js): every action is a known read; every
//      href has a row in the page→data-action table; for each role every item
//      passes roleAllows on its nav action and its page's action; the exact
//      sets and order per role; activeItem by longest path prefix
//   2. the (authed) layout, compiled with Next's SWC and called with its data
//      stubbed, for owner, admin, staff, support, operator-support and
//      bootstrap: the shell's nav is navFor(role); its props carry no hidden
//      href, no password or hash, no other member's email; badges only for
//      visible items; getUser is not called for operator-support or bootstrap
//   3. listMyStores on a fresh control plane (file database in a temp folder):
//      only the caller's rows, active stores only, the URL from domains[0],
//      the current store marked; operator-support and bootstrap get []
//   4. support's shell rendered on the server: outside main the only
//      interactive elements are nav links and the allowlisted shell controls;
//      the read-only label is there; on every console page main holds the
//      page directly (no old region since Phase 2 line 11) and the
//      stray-control rule covers the whole of main
//   5. accountItems() and switcherItems() hold no write item
//   6. no merchant console frame keeps an old region (the operator console's
//      stay until Phase 3) and the editor clears the top bar (§3.6)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n    ")}`);
  }
}
const eq = (a, b, m = "") => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${m} expected ${y}, got ${x}`);
};
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};

// --- a fresh control plane, before any lib import ---------------------------
const tmp = mkdtempSync(join(tmpdir(), "console-shell-"));
process.env.TURSO_DB_URL = "";
process.env.DATABASE_URL = `file:${join(tmp, "default.db")}`;
process.env.PLATFORM_DB_URL = `file:${join(tmp, "platform.db")}`;
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-console-shell-secret";
process.env.PLATFORM_CACHE_MS = "0";

const Nav = await import("../lib/admin/nav.js");
const { ACTIONS, ROLES, isWriteAction, roleAllows } = await import("../lib/platform/authz.js");
const { ADMIN_PAGES } = await import("./support/admin-pages.js");

// Phase 1 line 3: Setup (admin-only) became Onboarding (every role) and
// "Logo and colours" moved into onboarding's Brand step. Phase 4 line 1: Apps
// (apps.read, so every role) opens the Store group.
const ALL_IDS = ["dashboard", "analytics", "onboarding", "orders", "reviews", "catalog", "quizzes", "editor", "media", "releases", "offers", "bundles", "experiments", "insights", "automations", "apps", "themes", "integrations", "billing", "settings"];
const READ_IDS = ALL_IDS.filter((id) => !["automations", "integrations", "billing", "settings"].includes(id));
const EXPECTED = { owner: ALL_IDS, admin: ALL_IDS, staff: READ_IDS, support: READ_IDS };
const ids = (groups) => Nav.navItems(groups).map((i) => i.id);

// ---------- 1. the nav model ----------
console.log("— the nav model");

await t("every nav action is a known action and a read; every href has a page row; hrefs are /admin/<page>", () => {
  const items = Nav.navItems(Nav.NAV);
  eq(items.map((i) => i.id), ALL_IDS, "all items in order:");
  for (const i of items) {
    ok(ACTIONS.includes(i.action), `${i.id}: ${i.action} is a known action:`);
    ok(!isWriteAction(i.action), `${i.id}: ${i.action} is a read:`);
    eq(i.href, `/admin/${i.page}`, `${i.id} href:`);
    ok(ADMIN_PAGES.some((p) => p.page === i.page), `${i.id}: page "${i.page}" has an ADMIN_PAGES row:`);
  }
  eq(Nav.NAV.map((g) => g.label), ["Overview", "Orders", "Catalog", "Storefront", "Growth", "Store"], "groups:");
});

await t("for each role, every visible item passes roleAllows on its nav and page action; exact sets and order (20 / 20 / 16 / 16; Phase 9 line 1 adds Reviews)", () => {
  for (const role of ROLES) {
    const groups = Nav.navFor(role);
    eq(ids(groups), EXPECTED[role], `${role}:`);
    for (const i of Nav.navItems(groups)) {
      ok(roleAllows(role, i.action), `${role} ${i.id} nav action:`);
      ok(roleAllows(role, ADMIN_PAGES.find((p) => p.page === i.page).action), `${role} ${i.id} page action:`);
    }
    ok(groups.every((g) => g.items.length), `${role}: no empty group:`);
  }
  eq(ROLES.slice().sort(), ["admin", "owner", "staff", "support"], "the roles:");
  eq(Nav.navFor("support").map((g) => g.label), ["Overview", "Orders", "Catalog", "Storefront", "Growth", "Store"], "support's groups (Store holds Apps and Themes):");
  eq(Nav.navFor("support").at(-1).items.map((i) => i.id), ["apps", "themes"], "support's Store group:");
  eq(ids(Nav.navFor("nobody")), [], "an unknown role sees nothing:");
  eq(Nav.NAV.flatMap((g) => g.items).find((i) => i.id === "onboarding").action, "storefront.read", "Onboarding's nav action is its page's (every role):");
  eq(ROLES.map((r) => Nav.navItems(Nav.navFor(r)).length), [20, 20, 16, 16], "the counts:");
});

await t("activeItem: longest path prefix at a '/', never a partial segment", () => {
  const items = Nav.navItems(Nav.NAV);
  const at = (p) => Nav.activeItem(p, items)?.id ?? null;
  eq(at("/admin/orders/ord_1"), "orders", "an order:");
  eq(at("/admin/studio"), "editor", "the studio (Phase 6: the editor item is Studio):");
  eq(at("/admin/editor/templates"), null, "the editor's own pages no longer light the Studio item:");
  eq(at("/admin/dashboard"), "dashboard", "exact:");
  eq(at("/admin/settingsx"), null, "a partial segment:");
  eq(at("/admin"), null, "the root:");
  eq(Nav.activeItem("/a/b/c", [{ id: "a", href: "/a" }, { id: "ab", href: "/a/b" }])?.id, "ab", "the longest wins:");
});

await t("accountItems() and switcherItems() hold no write item; the account's only action is Sign out", () => {
  const actors = [
    [{ kind: "merchant", role: "owner" }, { name: "Olivia Owner", email: "owner@x.test" }],
    [{ kind: "merchant", role: "support" }, { name: "Sam Support", email: "support@x.test" }],
    [{ kind: "operator-support", role: "support", id: "usr_op1" }, null],
    [{ kind: "bootstrap", role: "owner" }, null],
  ];
  for (const [actor, account] of actors) {
    const rows = Nav.accountItems(actor, account);
    eq(rows.filter((r) => !["text", "note"].includes(r.kind)).map((r) => r.kind), ["sign-out"], `${actor.kind}/${actor.role} actions:`);
  }
  const support = Nav.accountItems(actors[1][0], actors[1][1]).map((r) => r.text);
  eq(support.slice(0, 3), ["Sam Support", "support@x.test", "Support"], "support: name, email, role in plain words:");
  ok(Nav.accountItems(actors[1][0], actors[1][1]).some((r) => r.kind === "note"), "support gets the read-only note:");
  ok(!Nav.accountItems(actors[0][0], actors[0][1]).some((r) => r.kind === "note"), "an owner does not:");
  eq(Nav.accountItems(actors[2][0], null).filter((r) => r.kind === "text").map((r) => r.text), ["Operator usr_op1"], "an operator sees only their own id:");
  eq(Nav.accountItems(actors[3][0], null).filter((r) => r.kind === "text").map((r) => r.text), ["Store setup login"], "bootstrap:");
  eq(Nav.readOnlyLabel(actors[1][0]), "Read-only access", "support label:");
  eq(Nav.readOnlyLabel(actors[2][0]), "Platform support access · read-only", "operator label:");
  eq(Nav.readOnlyLabel(actors[0][0]), null, "owner: none:");
  const sw = Nav.switcherItems([{ id: "a", name: "A", role: "owner", url: "http://a.localhost/admin", current: true }, { id: "b", name: "B", role: "admin", url: "http://b.localhost/admin", current: false }], { id: "a", name: "A" });
  eq(sw.map((i) => i.kind), ["store", "store", "link"], "two stores and the storefront link:");
  eq(sw.map((i) => i.role ?? i.text), ["Owner", "Admin", "Open storefront"], "roles in plain words:");
  const one = Nav.switcherItems([], { id: "roles", name: "Roles Demo Co" });
  eq(one.map((i) => `${i.kind}:${i.name ?? i.text}:${i.current ?? ""}`), ["store:Roles Demo Co:true", "link:Open storefront:"], "no stores (bootstrap, operator): the current store only:");
  // stores listed but none marked current (the current store is not one of mine): the current store is added, ticked
  const none = Nav.switcherItems([{ id: "b", name: "B", role: "admin", url: "http://b.localhost/admin", current: false }], { id: "roles", name: "Roles Demo Co" });
  eq(none.filter((i) => i.kind === "store").map((i) => `${i.id}:${i.current}`), ["roles:true", "b:false"], "none current: the current store is added as the ticked row, not the first store:");
  const unmarked = Nav.switcherItems([{ id: "a", name: "A", role: "owner", url: "http://a.localhost/admin", current: false }, { id: "b", name: "B", role: "admin", url: "http://b.localhost/admin" }], { id: "b", name: "B" });
  eq(unmarked.filter((i) => i.kind === "store").map((i) => `${i.id}:${i.current}`), ["a:false", "b:true"], "the current store listed but unmarked is ticked, not duplicated:");
  eq(read("components/admin/shell/StoreSwitcher.js").includes("|| storeRows[0]"), false, "the switcher no longer falls back to the first store:");
  for (const i of [...sw, ...one, ...none]) ok(["store", "link"].includes(i.kind) && !/create|new|add|delete/i.test(`${i.text ?? ""} ${i.id}`), `${i.id} is not a write:`);
});

// ---------- SWC loader with stubs (the pattern of test-editor-routes.js) ----------
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
async function compile(file) {
  return (
    await swc.transform(readFileSync(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
}
function world(stubs) {
  const cache = new Map();
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    const mod = { exports: {} };
    cache.set(file, mod.exports);
    const code = await compile(file);
    const local = new Map();
    for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
      if (id in stubs || local.has(id)) continue;
      const target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : id.startsWith(".") ? resolve(dirname(file), id) : null;
      if (target) local.set(id, await load(target.endsWith(".js") ? target : `${target}.js`));
    }
    new Function("require", "module", "exports", code)((id) => (id in stubs ? stubs[id] : local.has(id) ? local.get(id) : require(id)), mod, mod.exports);
    cache.set(file, mod.exports);
    return mod.exports;
  }
  return load;
}

// ---------- 2. the (authed) layout ----------
console.log("— the (authed) layout");
const L = { actor: null, getUserCalls: 0, storesCalls: [], shellProps: null, notices: null };
// the real notices component (old Banner look) and its has-anything check
const RealNotices = await world({})(join(ROOT, "components/admin/shell/ConsoleNotices.js"));
const OTHER_EMAIL = "someone-else@x.test";
const layoutStubs = {
  "next/headers": { cookies: async () => ({ get: (n) => (n === "sidebar_state" ? { value: "false" } : { value: "cookie" }) }) },
  "next/navigation": {
    redirect: (to) => {
      throw new Error(`redirect ${to}`);
    },
  },
  "@/lib/admin-auth": { adminActor: async () => L.actor, ADMIN_COOKIE: "_admin", PLATFORM_COOKIE: "_platform" },
  "@/lib/console-request": { tfetch: (fn) => fn() },
  "@/lib/site": { siteName: () => "Roles Demo Co" },
  "@/lib/tenant-context": { currentTenant: () => ({ id: "roles", domains: ["roles.localhost"] }) },
  "@/lib/returns": { listReturns: async () => [{ id: "ret_1" }, { id: "ret_2" }] },
  // the layout reads the light onboardingProgress on every page, never the full model (which runs the opening report)
  "@/lib/onboarding/service": {
    onboardingProgress: async () => L.progress || { supported: true, open: false, openKnown: true, doneCount: 2, total: 4 },
    onboardingFor: async () => {
      L.fullModelCalls = (L.fullModelCalls || 0) + 1;
      throw new Error("the layout computed the full onboarding model");
    },
  },
  "@/lib/releases": { publishingBadge: async () => "1" },
  "@/lib/platform/identity": {
    getUser: async (id) => {
      L.getUserCalls++;
      return { id, name: "Olivia Owner", email: "owner@roles.test", password_hash: "scrypt$abc$def", totp_secret: "SECRET", is_operator: 0, status: "active" };
    },
  },
  "@/lib/admin/stores": {
    listMyStores: async (actor) => {
      L.storesCalls.push(actor.kind);
      return actor.kind === "merchant" ? [{ id: "roles", name: "Roles Demo Co", role: actor.role, url: "http://roles.localhost/admin", current: true }] : [];
    },
  },
  "@/lib/admin/notices": { consoleNotices: async () => L.notices ?? { grant: null, incidents: [{ id: "inc_1", tenant_id: null, title: "Slow sync", public_message: "Catching up", internal_notes: `ask ${OTHER_EMAIL}` }] } },
  "@/components/admin/shell/AdminShell": {
    AdminShell: (p) => {
      L.shellProps = p;
      return React.createElement("div", { "data-shell": "stub" }, p.children);
    },
  },
  "@/components/admin/shell/ConsoleNotices": { ConsoleNotices: (p) => React.createElement("div", { "data-notices": p.incidents?.length ?? 0 }), hasConsoleNotices: RealNotices.hasConsoleNotices },
};
const Layout = (await world(layoutStubs)(join(ROOT, "app/(console)/admin/(authed)/layout.js"))).default;
const CASES = [
  ["owner", { kind: "merchant", id: "usr_owner", role: "owner" }],
  ["admin", { kind: "merchant", id: "usr_admin", role: "admin" }],
  ["staff", { kind: "merchant", id: "usr_staff", role: "staff" }],
  ["support", { kind: "merchant", id: "usr_support", role: "support" }],
  ["operator-support", { kind: "operator-support", id: "usr_op1", role: "support", grantId: "grant_1" }],
  ["bootstrap", { kind: "bootstrap", id: "bootstrap", role: "owner" }],
];

await t("the layout hands the shell navFor(role), badges for visible items only, and no secret, for every caller", async () => {
  for (const [name, actor] of CASES) {
    Object.assign(L, { actor, getUserCalls: 0, storesCalls: [], shellProps: null });
    const html = renderToStaticMarkup(await Layout({ children: React.createElement("p", null, "page") }));
    const p = L.shellProps;
    ok(p && html.includes("<p>page</p>"), `${name}: the shell renders the page:`);
    eq(ids(p.nav), ids(Nav.navFor(actor.role)), `${name}: nav is navFor(${actor.role}):`);
    const { children, notices, ...rest } = p;
    const json = JSON.stringify(rest);
    const visible = new Set(Nav.navItems(p.nav).map((i) => i.href));
    for (const i of Nav.navItems(Nav.NAV)) if (!visible.has(i.href)) ok(!json.includes(`"${i.href}"`), `${name}: hidden ${i.href} is not in the props:`);
    ok(!/password|hash|totp|secret/i.test(json), `${name}: no password, hash or secret in the props: ${json.slice(0, 200)}`);
    ok(!json.includes(OTHER_EMAIL) && !json.includes("grant_1"), `${name}: no other member's email and no grant id:`);
    const wantBadges = Object.fromEntries(Object.entries({ returns: 2, onboarding: "2/4", publish: "1" }).filter(([k]) => Nav.navItems(p.nav).some((i) => i.badgeKey === k)));
    eq(Object.keys(p.badges).sort().map((k) => `${k}=${p.badges[k]}`), Object.keys(wantBadges).sort().map((k) => `${k}=${wantBadges[k]}`), `${name}: badges:`);
    eq(p.badges.onboarding, "2/4", `${name}: every role sees the onboarding badge while the store is closed:`);
    eq(p.defaultOpen, false, `${name}: the sidebar_state cookie sets defaultOpen:`);
    if (actor.kind === "merchant") {
      eq(L.getUserCalls, 1, `${name}: getUser called once:`);
      eq(p.account, { name: "Olivia Owner", email: "owner@roles.test" }, `${name}: account is name and email only:`);
    } else {
      eq(L.getUserCalls, 0, `${name}: getUser not called:`);
      eq(p.account, null, `${name}: no account:`);
      eq(p.stores, [], `${name}: no stores:`);
    }
    eq(p.actor, { kind: actor.kind, role: actor.role, ...(actor.kind === "operator-support" ? { id: actor.id } : {}) }, `${name}: the actor sent:`);
    ok(!("cmsMode" in p), `${name}: no cmsMode prop:`);
  }
});

await t("the onboarding badge: from onboardingProgress only (never the full model); none while the open state is unreadable, for an open store, or a store without steps", async () => {
  Object.assign(L, { actor: CASES[0][1], fullModelCalls: 0, progress: null });
  eq([(await Layout({ children: null })).props.badges.onboarding, L.fullModelCalls], ["2/4", 0], "closed: the badge, and onboardingFor never called:");
  for (const [label, progress] of [
    ["open state unreadable", { supported: true, open: false, openKnown: false, doneCount: 2, total: 4 }],
    ["open", { supported: true, open: true, openKnown: true, doneCount: 4, total: 4 }],
    ["no steps (_default or the old editor)", { supported: false, open: false, openKnown: true, doneCount: 0, total: 4 }],
  ]) {
    L.progress = progress;
    eq(["onboarding" in (await Layout({ children: null })).props.badges, L.fullModelCalls], [false, 0], `${label}:`);
  }
  delete L.fullModelCalls;
  delete L.progress;
});

await t("no caller: the layout redirects to the sign-in page", async () => {
  L.actor = null;
  let to = null;
  try {
    renderToStaticMarkup(await Layout({ children: null }));
  } catch (e) {
    to = e.message;
  }
  eq(to, "redirect /admin/login", "redirect:");
});

// ---------- 3. listMyStores on a fresh control plane ----------
console.log("— listMyStores");
const C = await import("../lib/platform/control.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { listMyStores } = await import("../lib/admin/stores.js");

await t("listMyStores: only the caller's own memberships, active stores only, URL from domains[0], current marked; operator and bootstrap get []", async () => {
  await C.migratePlatform(read("lib/platform/schema.sql"));
  const db = process.env.DATABASE_URL;
  await C.upsertTenant({ id: "roles", name: "Roles Demo Co", domains: ["roles.localhost", "alt.localhost"], dbUrl: db });
  await C.upsertTenant({ id: "annex", name: "Roles Annex", domains: ["annex.localhost"], dbUrl: db, config: { site_url: "http://annex.localhost:6101" } });
  await C.upsertTenant({ id: "gone", name: "Gone Store", status: "suspended", domains: ["gone.localhost"], dbUrl: db });
  await C.upsertTenant({ id: "other", name: "Other Store", domains: ["other.example.com"], dbUrl: db });
  await C.upsertTenant({ id: "nodomain", name: "No Domain", domains: [], dbUrl: db });
  const me = await I.createUser({ email: "me@x.test", name: "Me", password: "a-long-password-1" });
  const them = await I.createUser({ email: "them@x.test", name: "Them", password: "a-long-password-2" });
  await I.addMembership(me.id, "roles", "owner");
  await I.addMembership(me.id, "annex", "admin");
  await I.addMembership(me.id, "gone", "owner");
  await I.addMembership(me.id, "nodomain", "owner");
  await I.addMembership(them.id, "other", "owner");
  const here = await C.getTenant("roles", { fresh: true });
  const mine = await withTenant(here, () => listMyStores({ kind: "merchant", id: me.id, role: "owner" }));
  eq(mine, [
    { id: "annex", name: "Roles Annex", role: "admin", url: "http://annex.localhost:6101/admin", current: false },
    { id: "roles", name: "Roles Demo Co", role: "owner", url: "http://roles.localhost/admin", current: true },
  ], "mine:");
  const theirs = await withTenant(here, () => listMyStores({ kind: "merchant", id: them.id, role: "owner" }));
  eq(C && (await import("../lib/admin/stores.js")).consoleUrl("x.localhost", "http://other.localhost:9/"), "http://x.localhost/admin", "a site_url on another host lends no port:");
  const { consoleUrl } = await import("../lib/admin/stores.js");
  eq(consoleUrl("shop-localhost.com", "http://shop-localhost.com:9/"), "https://shop-localhost.com" + "/admin", "a public host containing \"localhost\" is https and borrows no port:");
  eq(consoleUrl("my127.0.0.1.example.com"), "https://my127.0.0.1.example.com" + "/admin", "a public host containing 127.0.0.1 is https:");
  eq(consoleUrl("annex.localhost:6101", "http://annex.localhost:6101"), "http://annex.localhost:6101/admin", "a .localhost host with a port stays local:");
  eq(consoleUrl("127.0.0.1", "http://127.0.0.1:3017"), "http://127.0.0.1:3017" + "/admin", "127.0.0.1 is local:");
  eq(consoleUrl("localhost"), "http://localhost/admin", "localhost is local:");
  eq(theirs.map((s) => `${s.id} ${s.url}`), ["other https://other.example.com" + "/admin"], "theirs (https off localhost):");
  eq(await withTenant(here, () => listMyStores({ kind: "operator-support", id: me.id, role: "support" })), [], "operator-support:");
  eq(await withTenant(here, () => listMyStores({ kind: "bootstrap", id: "bootstrap", role: "owner" })), [], "bootstrap:");
  ok(read("app/api/admin/stores/route.js").includes("listMyStores(auth.actor)"), "the stores route answers from the same function:");
});

// ---------- 3b. consoleNotices drops what is not for display ----------
// Phase 3 line 5 (decision 5): the grant names the operator by name (operatorName), never the id
await t("consoleNotices(): only operatorName, reason, expires_at of a grant and id, tenant_id, title, public_message of an incident", async () => {
  const notices = await world({
    "../platform/support.js": {
      activeSupportGrant: async (id) => ({ id: "grt_1", tenant_id: id, operator: "usr_op1", operator_id: "usr_op1", reason: "Checkout bug", expires_at: "2026-11-25T00:00:00.000Z", granted_by: "usr_x", created_at: "2026-11-24T00:00:00.000Z" }),
      operatorName: async (id) => (id === "usr_op1" ? "Asha Operator" : "A Storeasy operator"),
    },
    "../platform/incidents.js": { openIncidentsFor: async () => [{ id: "inc_1", tenant_id: null, title: "Slow sync", public_message: "Catching up", internal_notes: `ask ${OTHER_EMAIL}`, severity: "high", created_by: "usr_op1" }, { id: "inc_2", tenant_id: "roles", title: "Payments", public_message: "", internal_notes: "secret" }] },
    "../tenant-context.js": { currentTenant: () => ({ id: "roles" }) },
    "../console-request.js": { tfetch: (fn) => fn() },
  })(join(ROOT, "lib/admin/notices.js"));
  // Phase 2 line 7: without a signed-in member there is no grant, only incidents
  eq((await notices.consoleNotices()).grant, null, "no member, no grant:");
  const n = await notices.consoleNotices({ member: { kind: "merchant", role: "owner" } });
  eq(n, {
    grant: { operatorName: "Asha Operator", reason: "Checkout bug", expires_at: "2026-11-25T00:00:00.000Z" },
    incidents: [
      { id: "inc_1", tenant_id: null, title: "Slow sync", public_message: "Catching up" },
      { id: "inc_2", tenant_id: "roles", title: "Payments", public_message: null },
    ],
  }, "display fields only:");
  ok(!JSON.stringify(n).includes("internal") && !JSON.stringify(n).includes(OTHER_EMAIL) && !JSON.stringify(n).includes("secret"), "no internal notes:");
  ok(!JSON.stringify(n).includes("usr_op1"), "no operator id:");
  const failed = await world({
    "../platform/support.js": { activeSupportGrant: async () => { throw new Error("down"); }, operatorName: async () => "A Storeasy operator" },
    "../platform/incidents.js": { openIncidentsFor: async () => [] },
    "../tenant-context.js": { currentTenant: () => ({ id: "roles" }) },
    "../console-request.js": { tfetch: (fn) => fn() },
  })(join(ROOT, "lib/admin/notices.js"));
  eq(await failed.consoleNotices(), { grant: null, incidents: [] }, "a failed read shows no notice:");
});

// ---------- 4. support's shell, rendered on the server ----------
console.log("— the shell, rendered");
// every merchant console page (scripts/support/admin-pages.js), a dynamic
// segment filled with "x"; Phase 2 line 11: every one is new UI, so the
// stray-control rule covers the whole of main on each
const PAGE_PATHS = ADMIN_PAGES.filter((r) => r.page).map((r) => `/admin/${r.page.replace(/\[[^\]]+\]/g, "x")}`);
let pathname = "/admin/orders/ord_1";
const shellStubs = {
  "next/navigation": { usePathname: () => pathname, useRouter: () => ({ push() {}, refresh() {}, replace() {} }) },
  "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
};
const { AdminShell } = await world(shellStubs)(join(ROOT, "components/admin/shell/AdminShell.js"));
const PAGE = '<p id="page-marker">page</p>';
const NOTICES = '<p id="notices-marker">notice</p>';
const render = (role, actor, path = "/admin/orders/ord_1", { Shell = AdminShell, notices = null, page = React.createElement("p", { id: "page-marker" }, "page") } = {}) => {
  pathname = path;
  return renderToStaticMarkup(
    React.createElement(
      Shell,
      { nav: Nav.navFor(role), badges: { returns: 2, publish: "1" }, actor, account: actor.kind === "merchant" ? { name: "Sam Support", email: "support@roles.test" } : null, stores: [], storeName: "Roles Demo Co", storeId: "roles", notices },
      page,
    ),
  );
};
const mainOf = (html) => html.slice(html.indexOf("<main "), html.indexOf("</main>"));
const withoutMain = (html) => html.slice(0, html.indexOf("<main ")) + html.slice(html.indexOf("</main>"));
const interactive = (html) => [...html.matchAll(/<(a|button|input|select|textarea)\b[^>]*>|<[a-z]+\b[^>]*(?:role="(?:menuitem|button|link)"|tabindex="(?!-1")[^"]*")[^>]*>/g)].map((m) => m[0]);
const ALLOWED_CONTROLS = ["skip", "toggle", "switcher", "account"];
// a control in main passes when it carries data-read-control itself, is
// natively disabled, or is RoleGate's (aria-disabled="true" with
// data-role-gate="disabled"): the drill's rule. Attributes are read from the
// opening tag, so a class like "disabled:opacity-50" or a marked ancestor
// never counts.
const attrsOf = (openTag) => new Map([...openTag.replace(/^<[a-z]+/, "").matchAll(/\s([\w:-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? ""]));
const mainPasses = (openTag) => {
  const a = attrsOf(openTag);
  return (a.has("data-read-control") && a.get("data-read-control") !== "false") || a.has("disabled") || (a.get("aria-disabled") === "true" && a.get("data-role-gate") === "disabled");
};

await t("support's shell: outside main only nav links and the allowlisted shell controls; the read-only label; the current item", async () => {
  for (const [label, actor, words] of [
    ["support member", { kind: "merchant", role: "support" }, "Read-only access"],
    ["operator support", { kind: "operator-support", role: "support", id: "usr_op1" }, "Platform support access · read-only"],
  ]) {
    const out = withoutMain(render("support", actor));
    const els = interactive(out);
    ok(els.length >= 11, `${label}: found ${els.length} interactive elements:`);
    const bad = els.filter((e) => !/data-nav-item="/.test(e) && !ALLOWED_CONTROLS.some((c) => e.includes(`data-shell-control="${c}"`)));
    eq(bad, [], `${label}: interactive elements outside the allowlist:`);
    eq(ALLOWED_CONTROLS.filter((c) => !out.includes(`data-shell-control="${c}"`)), [], `${label}: every shell control is there:`);
    eq([...out.matchAll(/data-nav-item="([\w-]+)"/g)].map((m) => m[1]), READ_IDS, `${label}: the nav links are support's:`);
    ok(out.includes(`data-shell="read-only"`) && out.includes(words.replace("·", "&#183;")) || out.includes(words), `${label}: the read-only label "${words}":`);
    ok(/<a [^>]*href="\/admin\/orders"[^>]*aria-current="page"|<a [^>]*aria-current="page"[^>]*href="\/admin\/orders"/.test(out), `${label}: Orders is current on /admin/orders/ord_1:`);
  }
  const owner = render("owner", { kind: "merchant", role: "owner" });
  ok(!owner.includes('data-shell="read-only"'), "an owner has no read-only label:");
  eq([...owner.matchAll(/data-nav-item="([\w-]+)"/g)].map((m) => m[1]), ALL_IDS, "an owner's nav links:");
  ok(/data-shell="topbar"[^>]*class="[^"]*\bh-14\b/.test(owner) || /class="[^"]*\bh-14\b[^"]*"[^>]*data-shell="topbar"/.test(owner), "the top bar is 56px (h-14):");
  ok(owner.indexOf('data-shell-control="skip"') < owner.indexOf("data-nav-item"), "the skip link comes before the nav:");
  ok(/max-w-\[1200px\]/.test(owner) && /\bpx-4\b[^"]*\bmd:px-6\b/.test(owner), "content capped at 1200px, 16px / 24px side padding:");
});

await t("support's shell on every console page: main holds the page directly (no old region), the notices above it, no stray control anywhere", async () => {
  ok(PAGE_PATHS.length >= 30, `pages: ${PAGE_PATHS.length}`);
  for (const path of PAGE_PATHS) {
    for (const [label, actor] of [
      ["support member", { kind: "merchant", role: "support" }],
      ["operator support", { kind: "operator-support", role: "support", id: "usr_op1" }],
    ]) {
      const html = render("support", actor, path);
      // no old region: test:no-legacy-ui keeps its attribute out of every source (Phase 3 line 7)
      ok(/<main [^>]*id="console-content"[^>]*>\s*<p id="page-marker">/.test(html), `${label} on ${path}: main > the page:`);
      eq(interactive(mainOf(html)).filter((e) => !ALLOWED_CONTROLS.some((c) => e.includes(`data-shell-control="${c}"`)) && !mainPasses(e)), [], `${label} on ${path}: interactive elements in main:`);
      const bad = interactive(html).filter((e) => !/data-nav-item="/.test(e) && !ALLOWED_CONTROLS.some((c) => e.includes(`data-shell-control="${c}"`)));
      eq(bad, [], `${label} on ${path}: interactive elements outside the allowlist:`);
      if (path.startsWith("/admin/onboarding")) continue;
      const withNotices = render("support", actor, path, { notices: React.createElement("p", { id: "notices-marker" }, "notice") });
      ok(new RegExp(`<main [^>]*id="console-content"[^>]*>\\s*<div class="mb-6">${NOTICES}</div>\\s*${PAGE}`).test(withNotices), `${label} on ${path}: the notices, then the page:`);
    }
  }
  // the rule bites: a stray write in main fails it; a marked read and a gated control pass
  const h = React.createElement;
  const page = h("div", null,
    h("a", { href: "/admin/orders/ord_2", "data-read-control": true }, "Open"),
    h("button", { "aria-disabled": true, "data-role-gate": "disabled" }, "Push"),
    h("button", { disabled: true }, "Cancel"),
    h("button", null, "Delete"),
    h("button", { "aria-disabled": true }, "Refund"),
    h("button", { className: "disabled:opacity-50", "data-x": "disabled" }, "Archive"),
    h("div", { "data-read-control": true }, h("button", { id: "inner" }, "Remove")),
  );
  const html = render("support", { kind: "merchant", role: "support" }, "/admin/orders", { page });
  eq(interactive(mainOf(html)).filter((e) => !mainPasses(e)), ["<button>", '<button aria-disabled="true">', '<button class="disabled:opacity-50" data-x="disabled">', '<button id="inner">'], "stray: Delete, aria-disabled without RoleGate's mark, the word disabled in a class, a button under a marked ancestor:");
});

await t("Phase 2 line 6: /admin/editor is full-bleed (data-shell=\"editor\", no max width or side padding); Saved templates keeps the column", async () => {
  const actor = { kind: "merchant", id: "usr_owner", role: "owner" };
  const ed = render("owner", actor, "/admin/editor");
  const main = ed.match(/<main [^>]*id="console-content"[^>]*>/)?.[0] || "";
  ok(main.includes('data-shell="editor"') && !main.includes("max-w-[1200px]") && !/\bpx-4\b/.test(main), `the editor's main: ${main}`);
  const tpl = render("owner", actor, "/admin/editor/templates").match(/<main [^>]*id="console-content"[^>]*>/)?.[0] || "";
  ok(tpl.includes("max-w-[1200px]") && !tpl.includes('data-shell="editor"'), `templates keep the column: ${tpl}`);
});

await t("no notices: the layout passes none, so main has no empty box", async () => {
  eq([RealNotices.hasConsoleNotices({ grant: null, incidents: [] }), RealNotices.hasConsoleNotices({ grant: { operator: "x" }, incidents: [] }), RealNotices.hasConsoleNotices({ grant: null, incidents: [{ id: "i" }] }), RealNotices.hasConsoleNotices(null)], [false, true, true, false], "hasConsoleNotices:");
  // the real element renders nothing for empty data: that is why the layout must not pass it
  eq(renderToStaticMarkup(React.createElement(RealNotices.ConsoleNotices, { grant: null, incidents: [] })), "", "ConsoleNotices with nothing to show renders nothing:");
  const actor = { kind: "merchant", id: "usr_support", role: "support" };
  Object.assign(L, { actor, getUserCalls: 0, storesCalls: [], shellProps: null, notices: { grant: null, incidents: [] } });
  try {
    renderToStaticMarkup(await Layout({ children: null }));
    eq(L.shellProps.notices, null, "the layout passes no notices element:");
    const html = render("support", actor, "/admin/orders", { notices: L.shellProps.notices });
    ok(/<main [^>]*id="console-content"[^>]*>\s*<p id="page-marker">/.test(html), "main > the page:");
    // and with a notice the layout passes the element
    L.notices = null;
    renderToStaticMarkup(await Layout({ children: null }));
    ok(React.isValidElement(L.shellProps.notices), "with an incident the layout passes the notices:");
  } finally {
    L.notices = null;
  }
});

await t("ConsoleNotices is the new UI's Alert: a grant is a warning, an incident is info, neither interrupts (role=status)", () => {
  const html = renderToStaticMarkup(React.createElement(RealNotices.ConsoleNotices, { grant: { operatorName: "Asha Operator", reason: "checkout bug", expires_at: "2026-11-25T10:00:00.000Z" }, incidents: [{ id: "inc_1", tenant_id: null, title: "Slow sync", public_message: "Shopify is slow." }] }));
  ok(/data-slot="alert"[^>]*>|role="status"/.test(html) && (html.match(/data-slot="alert"/g) || []).length === 2, `two alerts: ${html}`);
  ok(!html.includes('role="alert"'), "no assertive alert on every page load:");
  ok(html.includes("Platform support access is active") && html.includes("Asha Operator from Storeasy") && html.includes("Platform notice: Slow sync") && html.includes("Shopify is slow."), "the words:");
});

// ---------- 6. the old regions are gone; the editor preview ----------
console.log("— old regions");
await t("the old regions are gone from both consoles (test:no-legacy-ui scans every source since Phase 3 line 7); the operator layout is the shell or the page alone; the editor sits under the 56px top bar", () => {
  const platformLayout = read("app/(console)/platform/layout.js").replace(/^\s*\/\/.*$/gm, "");
  // Phase 3 line 0: operators get the shell (components/ui), anyone else the page alone
  ok(/if \(!operator\) return children;/.test(platformLayout) && /<PlatformShell /.test(platformLayout), "the platform layout: the shell for operators, the page alone otherwise:");
  for (const f of ["app/(console)/platform/legacy", "components/console", "components/platform/PlatformAdmin.js", "components/platform/TenantDetail.js"]) ok(!require("node:fs").existsSync(join(ROOT, f)), `${f} is gone (Phase 3 line 7):`);
  const de = read("components/admin/editor/DocumentEditor.js");
  // Phase 2 line 6: the editor's panes fill the height under the 56px top bar (no sticky preview)
  ok(de.includes("lg:h-[calc(100svh-3.5rem)]") && !de.includes("lg:sticky"), "the editor frame sits under the 56px top bar:");
  ok(!de.includes("lg:top-4"), "no lg:top-4 left:");
  ok(!require("node:fs").existsSync(join(ROOT, "app/(console)/admin/layout.js")), "the old admin layout is gone (its notices moved):");
  for (const f of ["components/console/nav/ConsoleShell.js", "components/console/nav/SidebarNav.js", "components/admin/StoreSwitcher.js", "lib/admin/new-ui-routes.js", "components/console/Toast.js"]) ok(!require("node:fs").existsSync(join(ROOT, f)), `${f} is gone:`);
  ok(!read("components/admin/shell/AdminShell.js").includes("localStorage"), "console.nav in localStorage is retired:");
  ok(read("app/(console)/admin/(auth)/layout.js").includes("<ConsoleNotices"), "the sign-in pages keep the notices:");
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
