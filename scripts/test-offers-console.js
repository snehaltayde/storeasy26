// Offers and bundles on the new console UI (docs/plans/phase-2.md "Line 4").
//   pnpm test:offers-console
// No browser, no network; throwaway file: databases (route-harness role store).
//   1. the reads behind the four pages for every role, support (the
//      least-trusted) first: lists, detail, simulate and targets answer 200;
//      POST /api/admin/bundles {check} is 403 for support; signed out is 401
//   2. the four pages run as every role (scripts/support/page-harness.js):
//      support's carry canWrite false and the writers' true; an unknown id is
//      a not-found; "new" sends support back to the list; a bundle's own offer
//      opens its bundle; signed out goes to sign-in
//   3. the components rendered with the props those pages gave (Next's SWC,
//      real radix-ui and react): support's markup has no enabled switch, Save
//      or Delete and keeps "Try it"; the bundle-owned offer row has no switch
//      for any role and links to its bundle
//   4. the pure parts: store-time schedule conversion, the bundle form's rules,
//      the new-UI routes and the Bundles nav item
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
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

const ROLES = ["support", "staff", "admin", "owner"]; // the least-trusted first
const WRITERS = ["staff", "admin", "owner"];
const V1 = "gid://shopify/ProductVariant/91011";
const V2 = "gid://shopify/ProductVariant/91021";

const store = await H.makeRoleStore({ name: "offcon", a: { products: 2 } });
const { call, a, cookies } = store;
const C = await import("../lib/platform/control.js");

// the fixture: an offer and a live bundle (whose offer row the bundle owns), made as the owner
const made = await call("owner", "offers", "POST", { body: { offer: { id: "bxgy-fixture-aaaaaa", type: "BXGY", scope: "line", priority: 30, target: { kind: "productId", value: "gid://shopify/Product/9101", label: "Fixture product 1" }, buy: 2, free: 1, title: "Buy 2 get 1" }, enabled: true } });
const bundleMade = await call("owner", "bundles", "POST", { body: { create: { title: "Fixture pair", items: [{ variantId: V1, quantity: 1 }, { variantId: V2, quantity: 1 }], bundle_price: 250, enable: true, mustPass: true } } });
const OFFER_ID = made.body?.offer?.id;
const BUNDLE_ID = bundleMade.body?.bundle?.id;
const BUNDLE_OFFER = `bundle-${BUNDLE_ID}`;

await t("setup: an offer and a live bundle exist (made through the real routes as the owner)", () => {
  eq(made.status, 200, `offer create: ${made.text}`);
  eq(bundleMade.status, 200, `bundle create: ${bundleMade.text}`);
  ok(BUNDLE_ID?.startsWith("bun-"), "a bundle id:");
});

// ---------- 1. the reads, every role ----------
const offerBody = { offer: { id: "x-sim", type: "COUPON", scope: "order", priority: 50, code: "SAVE10", discount: { kind: "percent", value: 10 }, title: "Save 10" } };
const READS = [
  ["offers", "GET", {}],
  ["offers/[id]", "GET", { params: { id: "bxgy-fixture-aaaaaa" } }],
  ["offers/simulate", "POST", { body: offerBody }],
  ["offers/targets", "GET", {}],
  ["bundles", "GET", {}],
];
await t("reads: lists, detail, simulate and targets answer every role 200 (support first); signed out 401", async () => {
  for (const role of ROLES) for (const [path, method, opts] of READS) eq((await call(role, path, method, opts)).status, 200, `${role} ${method} ${path}:`);
  for (const [path, method, opts] of READS) eq((await call("signed-out", path, method, opts)).status, 401, `signed out ${method} ${path}:`);
});

await t("POST /api/admin/bundles {check}: support 403 (offers.write), every writer 200, signed out 401", async () => {
  const body = { check: { items: [{ variantId: V1, quantity: 1 }, { variantId: V2, quantity: 1 }], bundle_price: 250 } };
  eq((await call("support", "bundles", "POST", { body })).status, 403, "support:");
  for (const role of WRITERS) {
    const r = await call(role, "bundles", "POST", { body });
    eq(r.status, 200, `${role}:`);
    eq(r.body.compat.state, "available", `${role} sees the pair passes:`);
  }
  eq((await call("signed-out", "bundles", "POST", { body })).status, 401, "signed out:");
});

await t("support's writes are refused by the server whatever the page shows (403)", async () => {
  eq((await call("support", "offers/[id]", "PUT", { params: { id: OFFER_ID }, body: { enabled: false } })).status, 403, "toggle:");
  eq((await call("support", "offers/[id]", "DELETE", { params: { id: OFFER_ID } })).status, 403, "delete:");
  eq((await call("support", "bundles", "POST", { body: { enable: { id: BUNDLE_ID, enabled: false } } })).status, 403, "bundle off:");
});

// ---------- 2. the pages, every role ----------
const { makePageHarness } = await import("./support/page-harness.js");
const pages = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }) });
const rel = (p) => `app/(console)/admin/(authed)/${p}/page.js`;
const propsOf = (run, name) => run.props.find((p) => p.component.endsWith(`#${name}`))?.props;
const runs = {};
for (const role of ROLES) {
  runs[role] = {
    offers: await pages.run(rel("offers"), { cookies: cookies[role] }),
    offer: await pages.run(rel("offers/[id]"), { cookies: cookies[role], params: { id: OFFER_ID } }),
    bundles: await pages.run(rel("bundles"), { cookies: cookies[role] }),
    bundle: await pages.run(rel("bundles/[id]"), { cookies: cookies[role], params: { id: BUNDLE_ID } }),
  };
}
const PAGE_COMPONENTS = { offers: "OffersList", offer: "OfferEditor", bundles: "BundlesList", bundle: "BundleEditor" };

await t("pages: support's four pages carry canWrite false; every writer's true; no error, no unresolved import", () => {
  for (const role of ROLES) {
    for (const [k, comp] of Object.entries(PAGE_COMPONENTS)) {
      const run = runs[role][k];
      ok(!run.error, `${role} ${k}: ${run.error?.message}`);
      eq(run.unresolved, [], `${role} ${k} unresolved:`);
      const props = propsOf(run, comp);
      ok(props, `${role} ${k} renders ${comp}: ${run.props.map((p) => p.component).join(",")}`);
      eq(props.canWrite, role !== "support", `${role} ${k} canWrite:`);
      eq(props.role, role, `${role} ${k} role:`);
    }
  }
  const list = propsOf(runs.support.offers, "OffersList");
  ok(list.initialOffers.some((o) => o.id === OFFER_ID) && list.initialOffers.some((o) => o.id === BUNDLE_OFFER), "support's list has the offer and the bundle's offer:");
  eq(typeof list.timezone, "string", "the store's timezone:");
  const b = propsOf(runs.support.bundle, "BundleEditor");
  eq(b.initialCheck.components.length, 2, "support's bundle page has the products named by the page's own check:");
  ok(propsOf(runs.support.bundles, "BundlesList").initialBundles[0].components[0].title, "the bundles list names each product:");
});

await t("pages: unknown ids are a not-found; support's \"new\" goes to the list; a bundle's offer opens its bundle; signed out goes to sign-in", async () => {
  for (const role of ROLES) {
    ok((await pages.run(rel("offers/[id]"), { cookies: cookies[role], params: { id: "off_missing" } })).notFound, `${role} offers/off_missing:`);
    ok((await pages.run(rel("bundles/[id]"), { cookies: cookies[role], params: { id: "bun-missing" } })).notFound, `${role} bundles/bun-missing:`);
    eq((await pages.run(rel("offers/[id]"), { cookies: cookies[role], params: { id: BUNDLE_OFFER } })).redirect, `/admin/bundles/${BUNDLE_ID}`, `${role} bundle offer:`);
  }
  eq((await pages.run(rel("offers/[id]"), { cookies: cookies.support, params: { id: "new" } })).redirect, "/admin/offers", "support offers/new:");
  eq((await pages.run(rel("bundles/[id]"), { cookies: cookies.support, params: { id: "new" } })).redirect, "/admin/bundles", "support bundles/new:");
  for (const role of WRITERS) {
    const n = await pages.run(rel("offers/[id]"), { cookies: cookies[role], params: { id: "new" } });
    eq(propsOf(n, "OfferEditor")?.existing, null, `${role} offers/new is the create form:`);
    const nb = await pages.run(rel("bundles/[id]"), { cookies: cookies[role], params: { id: "new" } });
    eq(propsOf(nb, "BundleEditor")?.initial, null, `${role} bundles/new is the create form:`);
  }
  for (const p of ["offers", "bundles"]) eq((await pages.run(rel(p), { cookies: {} })).redirect, "/admin/login", `signed out ${p}:`);
  for (const [p, id] of [["offers/[id]", OFFER_ID], ["bundles/[id]", BUNDLE_ID]]) eq((await pages.run(rel(p), { cookies: {}, params: { id } })).redirect, "/admin/login", `signed out ${p}:`);
});

// ---------- 3. the markup ----------
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const STUBS = {
  "@/components/console/Toast": { useToast: () => ({ success() {}, error() {}, info() {} }) },
  "next/navigation": { useRouter: () => ({ push() {}, refresh() {}, replace() {} }), usePathname: () => "/admin/offers" },
};
const cache = new Map();
const resolveLocal = (id, from) => {
  const base = id.startsWith("@/") ? join(ROOT, id.slice(2)) : join(dirname(from), id);
  for (const c of [`${base}.js`, base]) if (existsSync(c) && !c.endsWith("/")) return c;
  throw new Error(`cannot resolve ${id}`);
};
async function load(file) {
  if (cache.has(file)) return cache.get(file);
  const out = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const deps = new Map();
  for (const [, , id] of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
    if (deps.has(id)) continue;
    if (STUBS[id]) deps.set(id, STUBS[id]);
    else if (id.startsWith("@/") || id.startsWith(".")) deps.set(id, await load(resolveLocal(id, file)));
    else deps.set(id, require(id));
  }
  const mod = { exports: {} };
  new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const { TooltipProvider } = await load(join(ROOT, "components/ui/tooltip.js"));
const COMPONENT_FILES = { OffersList: "components/admin/offers/OffersList.js", OfferEditor: "components/admin/offers/OfferEditor.js", BundlesList: "components/admin/bundles/BundlesList.js", BundleEditor: "components/admin/bundles/BundleEditor.js" };
async function markup(role, key) {
  const comp = PAGE_COMPONENTS[key];
  const mod = await load(join(ROOT, COMPONENT_FILES[comp]));
  return renderToStaticMarkup(React.createElement(TooltipProvider, null, React.createElement(mod[comp], propsOf(runs[role][key], comp))));
}
// every <button>/<a> a role could press that writes: an enabled switch, or a Save / Delete / Update / Start / Turn
const enabledTags = (html) => [...html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)].filter(([, , attrs]) => !/\sdisabled(=""|\s|$)/.test(attrs) && !/aria-disabled="true"/.test(attrs));
const writeControls = (html) =>
  enabledTags(html)
    .filter(([, , attrs, inner]) => /role="switch"/.test(attrs) || /data-(offer|bundle)-(save|switch)/.test(attrs) || /\b(Save|Delete|Update live offer|Start offer|Turn (on|off)|Go back)\b/.test(inner.replace(/<[^>]+>/g, "")))
    .map(([m]) => m.slice(0, 120));

const html = {};
for (const role of ROLES) {
  html[role] = {};
  // class lists are dropped, so a utility such as disabled:opacity-50 never reads as an attribute
  for (const key of Object.keys(PAGE_COMPONENTS)) html[role][key] = (await markup(role, key)).replace(/\sclass="[^"]*"/g, "");
}

await t("markup (support): no enabled switch, Save or Delete on any of the four pages; \"New offer\"/\"New bundle\" gated with the reason", () => {
  for (const key of Object.keys(PAGE_COMPONENTS)) eq(writeControls(html.support[key]), [], `support ${key}:`);
  for (const [key, word] of [["offers", "New offer"], ["bundles", "New bundle"]]) {
    const a = (html.support[key].match(new RegExp(`<a\\b[^>]*>(?:(?!</a>)[\\s\\S])*${word}`)) || [""])[0];
    ok(/aria-disabled="true"/.test(a) && /data-role-gate="disabled"/.test(a) && !/href=/.test(a), `support ${key}: ${word} is RoleGate-disabled with no href: ${a.slice(0, 200)}`);
  }
  const enabledFields = (h) => [...h.matchAll(/<(input|textarea)\b[^>]*>/g)].map(([m]) => m).filter((m) => !/\sdisabled(=""|\s|>)/.test(m));
  eq(enabledFields(html.support.offer), [], "support's offer fields are all disabled:");
  eq(enabledFields(html.support.bundle), [], "support's bundle fields are all disabled:");
  ok(enabledFields(html.staff.offer).length > 0 && enabledFields(html.staff.bundle).length > 0, "staff's fields are enabled (the check can fail):");
});

await t("markup (support): the simulator works: \"Try it\" is a marked read control, not disabled", () => {
  const btn = (html.support.offer.match(/<button\b[^>]*data-read-control[^>]*>(?:(?!<\/button>)[\s\S])*Try it/) || [""])[0];
  const open = btn.slice(0, btn.indexOf(">") + 1);
  ok(btn && !/\sdisabled/.test(open), `"Try it" for support: ${open}`);
});

await t("markup (writers): the switch, Save and Delete are there", () => {
  for (const role of WRITERS) {
    ok(new RegExp(`data-offer-switch="${OFFER_ID}"`).test(html[role].offers), `${role}: the offer's switch:`);
    ok(/data-offer-switch="detail"/.test(html[role].offer) && /data-offer-save/.test(html[role].offer) && />\s*(<svg[\s\S]*?<\/svg>)?\s*Delete\s*</.test(html[role].offer), `${role}: the offer page's switch, Save and Delete:`);
    ok(new RegExp(`data-bundle-switch="${BUNDLE_ID}"`).test(html[role].bundles) && /data-bundle-save/.test(html[role].bundle), `${role}: the bundle's switch and Save:`);
  }
});

await t("markup: the bundle-owned offer row has no switch for any role, says \"Part of bundle\" and links to the bundle", () => {
  for (const role of ROLES) {
    const s = html[role].offers;
    ok(!s.includes(`data-offer-switch="${BUNDLE_OFFER}"`), `${role}: no switch on the bundle's offer:`);
    const link = (s.match(/Part of bundle\s*(<a\b[^>]*>)/) || [])[1] || "";
    ok(link.includes(`href="/admin/bundles/${BUNDLE_ID}"`) && link.includes("data-read-control"), `${role}: "Part of bundle" links to it: ${link}`);
  }
});

// ---------- 4. the pure parts ----------
const SF = await load(join(ROOT, "components/admin/offers/ScheduleField.js"));
const BC = await load(join(ROOT, "components/admin/bundles/BundleCheck.js"));
await t("schedule: store time to and from UTC (Kolkata, New York across DST), a bad value is null", () => {
  eq(SF.zonedToIso("2026-11-25T09:00", "Asia/Kolkata"), "2026-11-25T03:30:00.000Z", "Kolkata:");
  eq(SF.isoToZoned("2026-11-25T03:30:00.000Z", "Asia/Kolkata"), "2026-11-25T09:00", "Kolkata back:");
  eq(SF.zonedToIso("2026-07-01T09:00", "America/New_York"), "2026-07-01T13:00:00.000Z", "New York summer:");
  eq(SF.zonedToIso("2026-12-01T09:00", "America/New_York"), "2026-12-01T14:00:00.000Z", "New York winter:");
  eq(SF.isoToZoned(SF.zonedToIso("2026-03-08T12:15", "America/New_York"), "America/New_York"), "2026-03-08T12:15", "round trip on the DST day:");
  eq([SF.zonedToIso("", "Asia/Kolkata"), SF.zonedToIso("nope", "Asia/Kolkata"), SF.isoToZoned(null, "Asia/Kolkata")], [null, null, ""], "empty and bad:");
});

await t("bundle rules: a picked product already listed adds to its quantity; empty quantities; the saving to the cent", () => {
  const rows = [{ variantId: V1, quantity: 1, label: "A" }];
  eq(BC.applyPick(rows, "new", { variantId: V1, label: "A" }), [{ variantId: V1, quantity: 2, label: "A" }], "same product adds:");
  eq(BC.applyPick(rows, "new", { variantId: V2, label: "B" }).length, 2, "a new product adds a row:");
  eq(BC.applyPick([...rows, { variantId: V2, quantity: 3, label: "B" }], 1, { variantId: V1 }), [{ variantId: V1, quantity: 4, label: "A" }], "changing a row to a listed product merges:");
  eq(["", null, "x", 0, -1, 1, 2].map(BC.emptyQuantity), [true, true, true, true, true, false, false], "empty quantities:");
  eq(BC.savingOf(300, 250.5), { exact: 49.5, cart: 50 }, "saving:");
  eq([BC.isPickedVariant(V1), BC.isPickedVariant("serum")], [true, false], "picked:");
  eq(BC.allWords([{ kind: "sold_out", title: "Serum" }, { kind: "no_saving", sum: 300 }], "INR"), ["Serum: Sold out", "Price must be lower than ₹300"], "reasons in words:");
});

await t("the new-UI routes and the nav: /admin/offers and /admin/bundles are new UI; Bundles sits after Offers in Growth", async () => {
  const { isNewUiRoute } = await import("../lib/admin/new-ui-routes.js");
  const Nav = await import("../lib/admin/nav.js");
  ok(["/admin/offers", "/admin/offers/new", "/admin/bundles", `/admin/bundles/${BUNDLE_ID}`].every((p) => isNewUiRoute(p)), "new UI:");
  ok(!isNewUiRoute("/admin/offersx"), "never a partial segment:");
  const growth = Nav.NAV.find((g) => g.label === "Growth").items.map((i) => i.id);
  eq(growth.slice(0, 2), ["offers", "bundles"], "Growth:");
  ok(Nav.navItems(Nav.navFor("support")).some((i) => i.id === "bundles"), "support sees Bundles (offers.read):");
});

await t("no fetch left the process", () => eq(network.attempts ?? [], [], "attempts:"));

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
