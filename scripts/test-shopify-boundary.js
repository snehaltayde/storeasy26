// Decision 2 as a failing test (SHOP-01 to SHOP-04, SHOP-06): content is never
// written back to Shopify. Only orders and admin data go there.
//   node scripts/test-shopify-boundary.js          (pnpm test:shopify-boundary)
//
// Three parts. Source scans read every file in lib, app, components and scripts
// for mutations, Admin REST calls, OAuth scopes and Shopify cart links. Payload
// checks run the real push and cancel code against a fake Shopify and lock what
// is sent. Gate checks run the real hook and a copy of the real test runner on
// throwaway packages. Fully isolated: temp files, fake transports, no network.
//
// This file is the one file the scans skip, because it has to name what it bans.
import { rm, readFile, readdir, mkdtemp, mkdir, copyFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-shopify-boundary.db";
process.env.SHOPIFY_STORE_DOMAIN = "boundary-test.myshopify.com";
process.env.ALERT_WEBHOOK_URL = "";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const SELF = "scripts/test-shopify-boundary.js";
await rm(join(ROOT, ".test-shopify-boundary.db"), { force: true });

const { libsql, db } = await import("../lib/db.js");
await libsql.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
const O = await import("../lib/orders.js");
const P = await import("../lib/shopify-push.js");
const { cancelOrder } = await import("../lib/order-cancel.js");
const { registerWebhooks, WEBHOOK_TOPICS } = await import("../lib/platform/shopify-webhooks.js");
const { mintStorefrontToken } = await import("../lib/shopify-admin.js");
const { OAUTH_SCOPES } = await import("../lib/platform/oauth.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { evaluateOffers } = await import("../lib/offers/engine.js");

// --- harness ---------------------------------------------------------------
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
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label || "expected truthy");
};
const sorted = (xs) => [...new Set(xs)].sort();
const listIn = (hits) => hits.map((h) => `\n      ${h}`).join("");

// --- the source scanners -----------------------------------------------------
const SCAN_DIRS = ["lib", "app", "components", "scripts"];

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function sourceFiles(dirs = SCAN_DIRS) {
  const files = [];
  for (const dir of dirs) {
    for (const full of await walk(join(ROOT, dir))) {
      const path = relative(ROOT, full).split("\\").join("/");
      if (path === SELF) continue;
      const buf = await readFile(full);
      if (buf.includes(0)) continue; // binary
      files.push({ path, text: buf.toString("utf8") });
    }
  }
  return files;
}

// A GraphQL # comment runs to the end of its line, written as a real newline or,
// in a one-line JS string, as \n.
function skipComment(text, start) {
  let i = start;
  while (i < text.length && text[i] !== "\n" && !(text[i] === "\\" && text[i + 1] === "n")) i++;
  return i;
}

function skipBalanced(text, start, open, close, { graphql = true } = {}) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (graphql && text[i] === "#") i = skipComment(text, i);
    else if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return text.length;
}

const skipBlank = (text, start) => {
  let i = start;
  while (i < text.length) {
    if (/[\s,]/.test(text[i])) i++;
    else if (text[i] === "#") i = skipComment(text, i);
    else break;
  }
  return i;
};

// Root fields of one selection set, as "name(args)" with spaces removed. Anything
// that cannot be named from the source (an interpolated field, a fragment, a
// document that never closes, a selection with no field in it) comes back as
// <unreadable>, which no list allows.
function rootFields(text, open) {
  const fields = [];
  const end = skipBalanced(text, open, "{", "}");
  if (end === text.length && text[end - 1] !== "}") return ["<unreadable>"];
  let i = skipBlank(text, open + 1);
  while (i < end - 1) {
    const name = /^[A-Za-z_]\w*/.exec(text.slice(i, end));
    if (!name) return [...fields, "<unreadable>"];
    let field = name[0];
    i = skipBlank(text, i + field.length);
    if (text[i] === ":") {
      const aliasOf = skipBlank(text, i + 1);
      const real = /^[A-Za-z_]\w*/.exec(text.slice(aliasOf, end));
      if (!real) return [...fields, "<unreadable>"];
      field = real[0];
      i = skipBlank(text, aliasOf + field.length);
    }
    let args = "";
    if (text[i] === "(") {
      const close = skipBalanced(text, i, "(", ")");
      args = text.slice(i, close).replace(/\s+/g, "");
      i = skipBlank(text, close);
    }
    if (text[i] === "{") i = skipBlank(text, skipBalanced(text, i, "{", "}"));
    fields.push(field + args);
  }
  return fields.length ? fields : ["<unreadable>"];
}

// True when only whitespace (real, or written as \n) sits between an opening quote
// and this position, which is how an indented document starts.
function startsString(text, index) {
  let i = index - 1;
  while (i >= 0) {
    if (/\s/.test(text[i])) i--;
    else if (text[i - 1] === "\\" && /[nrt]/.test(text[i])) i -= 2;
    else break;
  }
  return i >= 0 && /["'`]/.test(text[i]);
}

// Every GraphQL mutation written in a piece of source text. Prose that uses the
// word ("a duplicate-mutation guard") has no selection set and is ignored. A
// string that starts with "mutation" but has no readable document is a mutation
// built at run time, so it counts as unreadable instead of being skipped.
function findMutations(text) {
  const found = [];
  const re = /\bmutation\b/g;
  let m;
  while ((m = re.exec(text))) {
    let i = skipBlank(text, m.index + "mutation".length);
    const name = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (name) i = skipBlank(text, i + name[0].length);
    else if (text.startsWith("${", i)) i = skipBlank(text, skipBalanced(text, i + 1, "{", "}", { graphql: false }));
    let graphqlHead = false;
    if (text[i] === "(") {
      graphqlHead = true;
      i = skipBlank(text, skipBalanced(text, i, "(", ")"));
    }
    for (let directive; (directive = /^@[A-Za-z_]\w*/.exec(text.slice(i))); ) {
      graphqlHead = true;
      i = skipBlank(text, i + directive[0].length);
      if (text[i] === "(") i = skipBlank(text, skipBalanced(text, i, "(", ")"));
    }
    if (text[i] === "{") {
      found.push(...rootFields(text, i));
      continue;
    }
    const closesString = /^["'`]/.test(text.slice(m.index + "mutation".length));
    const bodyIsInterpolated = graphqlHead && text.startsWith("${", i);
    if (bodyIsInterpolated || (startsString(text, m.index) && !closesString)) found.push("<unreadable>");
  }
  return found;
}

const fieldName = (field) => field.split("(")[0];

// Shopify mutation names read as resource + verb. This catches one written
// anywhere, even outside a document (a comment, a string assembled later), which
// is what "adding productUpdate anywhere fails" asks for.
const MUTATION_NAME =
  /\b(?:product|productVariant|productVariants|collection|metafield|metafields|metaobject|metaobjects|metaobjectDefinition|page|article|blog|comment|theme|themeFiles|menu|file|files|translation|translations|publishable|publication|customer|discount|discountCode|discountAutomatic|tags|urlRedirect|shop|priceList|stagedUploads|inventory|order|draftOrder|refund|fulfillment|fulfillmentOrder|webhookSubscription|storefrontAccessToken|bulkOperation|location|market|giftCard|sellingPlanGroup|scriptTag)(?:[A-Z][A-Za-z]*?)?(?:Create|Update|Delete|Set|Upsert|Add|Remove|Register|Publish|Unpublish|Reorder|Duplicate|Adjust|Activate|Deactivate|Cancel|Complete|Capture|MarkAsPaid)\b/g;

const findMutationNames = (text) => [...text.matchAll(MUTATION_NAME)].map((m) => m[0]);

// The only Shopify Admin endpoints this codebase may call.
const SHOPIFY_ADMIN_ENDPOINT = /^\/admin\/(?:api\/(?:\$\{[^}]*\}|[\w.-]+)\/graphql\.json|oauth\/(?:access_token|authorize))(?:\?.*)?$/;
// This app's own console pages, always built on a store's own origin, which is a
// variable. A URL that spells out http(s):// and its host gets no such allowance.
const CONSOLE_PAGE = /^\/admin(?:\/(?:login|accept-invite|reset|dashboard))?(?:\?.*)?$/;
// Not Shopify: test/seed console login URLs.
const NOT_SHOPIFY_URLS = ["http://localhost:3017/admin/login", "http://ma.test/admin/login"];
// A literal local test host (localhost, *.localhost, *.test, with an optional port)
// is never a Shopify store, so one of the app's console pages on it is allowed.
const LOCAL_CONSOLE_URL = /^https?:\/\/(?:localhost|[\w.-]+\.localhost|[\w.-]+\.test)(?::\d+)?(\/admin(?:\/[^\s"'`<]*)?)$/;
const isLocalConsoleUrl = (u) => { const m = LOCAL_CONSOLE_URL.exec(u); return !!m && CONSOLE_PAGE.test(m[1]); };

// There is no way to read the HTTP method reliably from source, so any Admin API
// URL other than graphql.json counts as a REST write until someone reviews it. So
// does any URL whose path starts at /admin and is not on the lists above, which
// sees a call whose path arrives as an argument (`https://${d}/admin/${p}`).
function findAdminRest(text) {
  const hits = [];
  for (const m of text.matchAll(/https?:\/\/(?:\$\{[^}]*\}|[^\s"'`\/$])*(\/admin(?![\w-])[^\s"'`<]*)/g)) {
    if (!SHOPIFY_ADMIN_ENDPOINT.test(m[1]) && !NOT_SHOPIFY_URLS.includes(m[0]) && !isLocalConsoleUrl(m[0])) hits.push(m[0]);
  }
  // After a variable (`${base}/admin/...`) or a join (base + "/admin/..."). With
  // the origin out of sight, one of the app's own console pages is allowed.
  for (const m of text.matchAll(/(?:\}|\+\s*["'`])(\/admin(?![\w-])[^\s"'`<]*)/g)) {
    if (!SHOPIFY_ADMIN_ENDPOINT.test(m[1]) && !CONSOLE_PAGE.test(m[1])) hits.push(m[0]);
  }
  for (const m of text.matchAll(/\/admin\/api(?![\w-])/g)) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
    if (!/^\/(?:\$\{[^}]*\}|[\w.-]+)\/graphql\.json/.test(rest)) hits.push(`${m[0]}${rest.split(/[\s"'`]/)[0]}`);
  }
  for (const m of text.matchAll(/\/admin\/(?!api\/|oauth\/)[^\s"'`]*\.json\b/g)) hits.push(m[0]);
  for (const m of text.matchAll(/\/admin\/oauth\/([\w.-]*)/g)) {
    if (!["access_token", "authorize"].includes(m[1])) hits.push(m[0]);
  }
  return hits;
}

// Shopify cart and checkout links, not this app's own cart paths and imports.
function findShopifyCartLinks(text) {
  const patterns = [
    /\bcheckoutUrl\b/g,
    /\bNEXT_PUBLIC_SHOPIFY_DOMAIN\b/g,
    /\/cart\/(?:\$\{|\d|add\b|clear\b|change\b|update\b)/g,
    /\/cart\/["'`]/g,
    /https?:\/\/[^\s"'`]*\/cart\b/g,
    /https?:\/\/(?!checkout\.razorpay\.com)[^\s"'`]*\/checkouts?\b/g,
  ];
  return patterns.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
}

// A Shopify client library makes REST calls with no /admin URL, no mutation text and
// no token header in this source, so none of the scans above could see them. Any
// string naming one counts, which covers import, require and import().
const SHOPIFY_CLIENT = /^(?:@shopify\/.*|shopify-api-node(?:\/.*)?)$/;
const findShopifyClientImports = (text) =>
  [...text.matchAll(/["'`](@shopify\/[^"'`]*|shopify-api-node(?:\/[^"'`]*)?)["'`]/g)].map((m) => m[1]);

const WRITE_SCOPE_TOKEN = /\b(?:unauthenticated_|customer_)?write_[a-z_]+\b/g;
const READ_SCOPE_TOKEN = /\b(?:unauthenticated_|customer_)?read_[a-z_]+\b/g;

const files = await sourceFiles();
const prodFiles = files.filter((f) => !/^scripts\/test-/.test(f.path));

// ===========================================================================
// SHOP-01: mutation allowlist
// ===========================================================================
const ALLOWED_MUTATIONS = [
  "draftOrderCreate",
  "draftOrderComplete",
  "orderCancel",
  "webhookSubscriptionCreate",
  "webhookSubscriptionUpdate",
  "storefrontAccessTokenCreate",
];

// Known, labelled exception: the Session 8 spike is a one-off script run by hand.
// It also tried orderCreate. Only that name, only in that file, and never imported.
const SPIKE = "scripts/spike-order-push.js";
const SPIKE_ONLY = ["orderCreate"];

// Every mutation document in the codebase, with its exact arguments, one entry per
// document. Moving or adding one, adding a second identical one, or adding an
// argument (a new free-text one, say) is a reviewed change to this list.
const MUTATION_DOCUMENTS = [
  "lib/order-cancel.js::orderCancel(orderId:$id,reason:$reason,refund:false,restock:true,notifyCustomer:false,staffNote:$staffNote)",
  "lib/platform/shopify-webhooks.js::webhookSubscriptionCreate(topic:$topic,webhookSubscription:$sub)",
  "lib/platform/shopify-webhooks.js::webhookSubscriptionUpdate(id:$id,webhookSubscription:$sub)",
  "lib/shopify-admin.js::storefrontAccessTokenCreate(input:$input)",
  "lib/shopify-push.js::draftOrderComplete(id:$id,paymentPending:$pending)",
  "lib/shopify-push.js::draftOrderCreate(input:$input)",
  `${SPIKE}::draftOrderComplete(id:$id,paymentPending:false)`,
  `${SPIKE}::draftOrderCreate(input:$input)`,
  `${SPIKE}::orderCreate(order:$order)`,
];

await t("SHOP-01: scanners catch what they must and ignore prose", async () => {
  eq(findMutations("gql(`mutation { productUpdate(input: $i) { product { id } } }`)"), ["productUpdate(input:$i)"], "anonymous:");
  eq(findMutations("`mutation Save($i: ProductInput!) {\n  productUpdate(input: $i) { userErrors { message } }\n}`").map(fieldName), ["productUpdate"], "named:");
  eq(findMutations("`mutation($id: ID!) { a: orderCancel(orderId: $id) { job { id } } productSet(x: 1) { id } }`").map(fieldName), ["orderCancel", "productSet"], "alias + two roots:");
  eq(findMutations("`mutation { ${FIELD}(input: $i) { id } }`"), ["<unreadable>"], "interpolated:");
  eq(findMutations("`mutation { ...Save }`"), ["<unreadable>"], "fragment:");
  eq(findMutations('"mutation " + op'), ["<unreadable>"], "built at run time:");
  eq(findMutations("`\n  mutation Foo($i: ID!) @inContext(country: IN) {\n    collectionAddProducts(id: $i) { userErrors { message } }\n  }\n`"), ["collectionAddProducts(id:$i)"], "indented, with a directive:");
  eq(findMutations("`\n  mutation ${n}($i: ID!) {\n    collectionAddProducts(id: $i) { userErrors { message } }\n  }`"), ["collectionAddProducts(id:$i)"], "interpolated operation name:");
  eq(findMutations("mutation Foo($i: ID!) @inContext(country: IN) @x {\n  collectionReorderProducts(id: $i) { userErrors { message } }\n}\n"), ["collectionReorderProducts(id:$i)"], ".graphql file, two directives:");
  eq(findMutations("`\n  mutation ${rest}\n`"), ["<unreadable>"], "indented, built at run time:");
  eq(findMutations('"\\n  mutation " + op'), ["<unreadable>"], "escaped newline, built at run time:");
  eq(findMutations("`\n  mutation Foo($i: ID!) ${body}\n`"), ["<unreadable>"], "interpolated body:");
  eq(findMutations("`mutation { # }\n  collectionAddProducts(id: 1) { id }\n}`"), ["collectionAddProducts(id:1)"], "a # comment holding a brace:");
  eq(findMutations("`mutation {\n  orderCancel(orderId: $i) { job { id } } # }\n  collectionAddProducts(id: 1) { id }\n}`").map(fieldName), ["orderCancel", "collectionAddProducts"], "a # comment after a field:");
  eq(findMutations("`mutation Foo($i: ID # )\n) { collectionAddProducts(id: $i # )\n) { id } }`").map(fieldName), ["collectionAddProducts"], "a # comment in the brackets:");
  eq(findMutations('"mutation { # }\\n  collectionAddProducts(id: 1) { id }\\n}"'), ["<unreadable>"], "the same in a one-line string:");
  eq(findMutations("`mutation { # nothing\n}`"), ["<unreadable>"], "no field at all:");
  eq(findMutations("// every mutation hits the edge\nconst mutation = sub ? A : B; gql(mutation, vars); a duplicate-mutation guard"), [], "prose:");
  eq(findMutationNames("// see productUpdate later"), ["productUpdate"], "name in a comment:");
  eq(findMutationNames("const x = 'productVariantsBulkUpdate' + metafieldsSet"), ["productVariantsBulkUpdate", "metafieldsSet"], "bare names:");
  eq(findMutationNames("priceAtAdd giftPickerOpen orderCancelUserErrors setPage"), [], "ordinary identifiers:");

  ok(findAdminRest("fetch(`https://${shop}/admin/api/2025-10/products/1.json`, { method: 'PUT' })").length, "versioned REST write");
  ok(findAdminRest("fetch(`https://${shop}/admin/api/${v}/products.json`, { method: 'POST' })").length, "interpolated version REST write");
  ok(findAdminRest("const base = `https://${shop}/admin/api/${v}`;").length, "bare Admin base URL");
  ok(findAdminRest("const ADMIN_API = () => `https://${shop}/admin/api`;").length, "base URL with no trailing slash");
  ok(findAdminRest("fetch(`https://${shop}/admin/products/1.json`)").length, "unversioned REST");
  ok(findAdminRest("fetch(`https://${shop}/admin/oauth/access_scopes.json`)").length, "other oauth endpoint");
  ok(findAdminRest("const url = (d, p) => `https://${d}/admin/${p}`;").length, "path passed in as an argument");
  ok(findAdminRest("fetch(`https://${d}/admin/products/1`, { method: 'PUT', headers })").length, "no .json, no api");
  ok(findAdminRest("fetch(`http://x.myshopify.com/admin`)").length, "literal host, bare /admin");
  ok(findAdminRest("fetch(`https://${d}/admin/login`)").length, "a spelled-out host gets no console allowance");
  ok(findAdminRest("fetch(`${base}/admin/${p}`)").length, "origin in a variable");
  ok(findAdminRest("fetch(`${proto}://${d}/admin/products/1`)").length, "scheme in a variable");
  ok(findAdminRest("fetch('https://' + d + '/admin/' + p)").length, "joined with +");
  ok(findAdminRest("fetch(base + '/admin/products/1')").length, "joined to a variable");
  ok(findAdminRest("fetch(`https://${d}/admin/api/${v}/graphql.json${x}`)").length, "more after graphql.json");
  eq(findAdminRest("`https://${storeDomain()}/admin/api/${API_VERSION()}/graphql.json`"), [], "graphql.json:");
  eq(findAdminRest("`https://${d}/admin/oauth/access_token` `https://${d}/admin/oauth/authorize?x=1` href='/admin/orders' href='/admin/api-keys'"), [], "oauth + console paths:");
  eq(findAdminRest('"http://localhost:3017/admin/login" `http://rf1.test/api/admin/refs?${qs}`'), [], "not Shopify:");
  eq(findAdminRest("`${base}/admin/accept-invite?token=${t}` `${ORIGIN}/admin/dashboard` `${proto}://${host}/admin/reset?token=${t}\\n\\nIf` `${origin}/admin` <code>{origin}/admin/login</code>"), [], "console pages:");
  eq(findAdminRest("'http://a.localhost/admin' 'http://b.localhost:6101/admin/dashboard' 'http://ma.test/admin/reset?token=1'"), [], "console pages on local test hosts:");
  for (const u of ["'http://shop.myshopify.com/admin'", "'http://a.localhost/admin/products/1.json'", "'http://evil.localhost.com/admin'"]) ok(findAdminRest(u).length > 0, `still caught: ${u}`);

  eq(["'x,read_themes'", '"read_products read_themes"', "`\n  read_themes,\n`", "'unauthenticated_read_checkouts'"].map((s) => s.match(READ_SCOPE_TOKEN).at(-1)), ["read_themes", "read_themes", "read_themes", "unauthenticated_read_checkouts"], "read scopes in a string:");
  eq("thread_id spread_x already_read".match(READ_SCOPE_TOKEN), null, "ordinary identifiers:");

  eq(findShopifyClientImports('import { x } from "@shopify/admin-api-client"; import y from \'shopify-api-node\'; const z = require("@shopify/shopify-api"); await import(`@shopify/${n}`);').length, 4, "client imports:");
  eq(findShopifyClientImports('await import("shopify-api-node/lib"); const p = "@shopify/";'), ["shopify-api-node/lib", "@shopify/"], "subpath, bare scope:");
  eq(findShopifyClientImports('import x from "@/lib/shopify-admin.js"; import y from "./shopify-api-node-notes.js"; // a shopify-api-node style client, @shopify/x'), [], "own files, prose:");

  ok(findShopifyCartLinks("return `https://${domain}/cart/${parts}`;").length, "cart permalink");
  ok(findShopifyCartLinks("`https://x.myshopify.com/cart/123:1`").length, "literal permalink");
  ok(findShopifyCartLinks("`https://${d}/checkouts/abc`").length, "checkout link");
  ok(findShopifyCartLinks("`${base}/cart/` + parts").length, "permalink joined to a template");
  ok(findShopifyCartLinks("base + '/cart/' + parts").length, "permalink joined to a string");
  eq(findShopifyCartLinks('import x from "@/components/cart/CartContext"; fetch("/api/cart"); // navigation/cart/wishlist'), [], "own cart paths:");
  eq(findShopifyCartLinks('"https://checkout.razorpay.com/v1/checkout.js"'), [], "payment script:");
});

await t("SHOP-01: every GraphQL mutation in lib, app, components, scripts is on the allowlist", async () => {
  const bad = [];
  for (const f of files) {
    const allowed = f.path === SPIKE ? [...ALLOWED_MUTATIONS, ...SPIKE_ONLY] : ALLOWED_MUTATIONS;
    for (const field of findMutations(f.text)) {
      if (!allowed.includes(fieldName(field))) bad.push(`${f.path}: ${field}`);
    }
  }
  eq(bad.length, 0, `Decision 2: only orders and admin data go to Shopify. Mutations not on the allowlist:${listIn(bad)}\n   `);
});

await t("SHOP-01: no Shopify write mutation name appears outside the allowlist, even in a comment", async () => {
  const bad = [];
  for (const f of files) {
    const allowed = f.path === SPIKE ? [...ALLOWED_MUTATIONS, ...SPIKE_ONLY] : ALLOWED_MUTATIONS;
    for (const name of findMutationNames(f.text)) {
      if (!allowed.includes(name)) bad.push(`${f.path}: ${name}`);
    }
  }
  eq(bad.length, 0, `Decision 2: write mutation names found:${listIn(bad)}\n   `);
});

// What xs has beyond ys, counting repeats: a second copy of something ys holds once
// is left over.
function beyond(xs, ys) {
  const rest = [...ys];
  return xs
    .filter((x) => {
      const at = rest.indexOf(x);
      if (at < 0) return true;
      rest.splice(at, 1);
      return false;
    })
    .sort();
}

await t("SHOP-01: the mutation documents are exactly the known list, with their exact arguments and how many of each", async () => {
  const found = files.flatMap((f) => findMutations(f.text).map((field) => `${f.path}::${field}`));
  eq(beyond(found, MUTATION_DOCUMENTS), [], "mutation documents not on the list (a second identical one counts as new):");
  eq(beyond(MUTATION_DOCUMENTS, found), [], "listed mutation documents no longer found:");
  eq(sorted(found.map((d) => fieldName(d.split("::")[1])).filter((n) => !SPIKE_ONLY.includes(n))), sorted(ALLOWED_MUTATIONS), "every allowed mutation still in use:");
});

// A new send can reuse an allowed document and add no document at all, so the send
// sites are locked as well. A draft helper is reached only from pushOrderToShopify,
// whose sent draft the SHOP-04 checks read. The count includes each definition. Any
// other mention of these names in the file, even a comment, is a failure to look at.
const SEND_CALL = /\b(?:gql|adminGraphql|adminGraphqlWithToken)\s*\(/g;
const SEND_CALLS = {
  "lib/order-cancel.js": 2, // the cancel, and the check after an error
  "lib/platform/shopify-webhooks.js": 2, // list, and create or update
  "lib/shopify-admin.js": 6, // definitions, retries, the token mint
  "lib/shopify-push.js": 3, // find, create, complete
  [SPIKE]: 7,
};
const DRAFT_HELPERS = {
  createDraft: 2, // definition, and one call
  completeDraft: 3, // definition, and two calls: after a create, and for a leftover draft
};

await t("SHOP-01: each file holding a mutation document has a fixed number of Shopify calls", async () => {
  const withDocuments = files.filter((f) => findMutations(f.text).length).map((f) => f.path);
  eq(sorted(Object.keys(SEND_CALLS)), sorted(withDocuments), "files holding a mutation document:");
  for (const [path, count] of Object.entries(SEND_CALLS)) {
    const { text } = files.find((f) => f.path === path);
    eq([...text.matchAll(SEND_CALL)].length, count, `${path} Shopify calls. A new send can carry anything, so it is a reviewed change to SEND_CALLS:`);
  }
});

await t("SHOP-01: createDraft and completeDraft stay private, with known call sites", async () => {
  eq(Object.keys(DRAFT_HELPERS).filter((name) => name in P), [], "exported from lib/shopify-push.js:");
  const { text } = files.find((f) => f.path === "lib/shopify-push.js");
  for (const [name, count] of Object.entries(DRAFT_HELPERS)) {
    eq([...text.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length, count, `${name} mentions in lib/shopify-push.js:`);
  }
});

await t("SHOP-01: the spike stays a labelled one-off that nothing imports", async () => {
  const importers = files.filter((f) => f.path !== SPIKE && /from\s+["'][^"']*spike-order-push|import\(["'][^"']*spike-order-push/.test(f.text));
  eq(importers.map((f) => f.path), [], "importers:");
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  eq(Object.entries(pkg.scripts).filter(([, cmd]) => cmd.includes("spike-order-push")).map(([k]) => k), [], "package.json scripts:");
  ok(files.find((f) => f.path === SPIKE)?.text.startsWith("// Session 8 SPIKE"), "spike keeps its label");
});

// The two files that may send the Admin token. The token check cannot see a new
// call inside them, so their Admin URLs and fetch calls are locked exactly. A new
// one, however its URL is put together, is a reviewed change to this list.
const ADMIN_TOKEN_FILES = {
  "lib/shopify-admin.js": {
    urls: ["/admin/api/${API_VERSION()}/graphql.json", "/admin/oauth/access_token", "/admin/oauth/access_token"],
    fetches: 3,
  },
  [SPIKE]: { urls: ["/admin/api/${APIVER}/graphql.json"], fetches: 1 },
};

await t("SHOP-01: no REST call to the Admin API, and the Admin token header stays in known files", async () => {
  const rest = files.flatMap((f) => findAdminRest(f.text).map((h) => `${f.path}: ${h}`));
  eq(rest.length, 0, `Admin API must go through graphql.json so the mutation list can see it:${listIn(rest)}\n   `);
  const tokenUsers = files.filter((f) => /x-shopify-access-token/i.test(f.text)).map((f) => f.path);
  eq(sorted(tokenUsers), sorted(Object.keys(ADMIN_TOKEN_FILES)), "files sending the Admin token:");
});

await t("SHOP-01: no Shopify client library, in source or in package.json", async () => {
  const imports = files.flatMap((f) => findShopifyClientImports(f.text).map((name) => `${f.path}: ${name}`));
  eq(imports.length, 0, `A Shopify client library can write to the Admin API where no scan here can see it:${listIn(imports)}\n   `);
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  // By name, or under another name ("client": "npm:@shopify/admin-api-client@1").
  const declared = ["dependencies", "devDependencies"].flatMap((field) =>
    Object.entries(pkg[field] || {})
      .filter(([name, spec]) => SHOPIFY_CLIENT.test(name) || /^npm:(?:@shopify\/|shopify-api-node@)/.test(String(spec)))
      .map(([name]) => `${field}: ${name}`),
  );
  eq(declared, [], "package.json:");
});

await t("SHOP-01: the files that send the Admin token call only their known URLs", async () => {
  for (const [path, { urls, fetches }] of Object.entries(ADMIN_TOKEN_FILES)) {
    const { text } = files.find((f) => f.path === path);
    eq([...text.matchAll(/\/admin\b[^\s"'`]*/g)].map((m) => m[0]).sort(), urls, `${path} Admin URLs:`);
    eq([...text.matchAll(/\bfetch\b/g)].length, fetches, `${path} fetch calls:`);
  }
});

await t("SHOP-01: the allowed write scopes are exactly write_orders and write_draft_orders", async () => {
  const scopes = OAUTH_SCOPES.split(",");
  eq(new Set(scopes).size, scopes.length, "no duplicate scopes:");
  eq(sorted(scopes.filter((s) => s.includes("write"))), ["write_draft_orders", "write_orders"], "write scopes:");
});

// Not Shopify scopes: an audit field (lib/platform/rotate.js), placeholder
// comments (lib/platform/oauth.js), and the order CAS write_id (lib/orders.js).
const NOT_SCOPES = ["write_key_fp", "write_x", "write_id"];

await t("SHOP-01: no other write_* scope is named anywhere in the source", async () => {
  const bad = [];
  for (const f of files) {
    for (const m of f.text.matchAll(WRITE_SCOPE_TOKEN)) {
      if (!["write_orders", "write_draft_orders", ...NOT_SCOPES].includes(m[0])) bad.push(`${f.path}: ${m[0]}`);
    }
  }
  eq(bad.length, 0, `Write scopes not allowed (if this is not a Shopify scope, add it to NOT_SCOPES here):${listIn(bad)}\n   `);
});

// Where a read scope is named outside the list: a comment and an error message.
const READ_SCOPE_MENTIONS = ["lib/platform/shopify-webhooks.js: read_orders", "scripts/shopify-mint-token.js: unauthenticated_read_product_listings"];

await t("SHOP-01: there is one scope list in the codebase", async () => {
  const declarations = files.flatMap((f) => [...f.text.matchAll(/\b\w*SCOPES\s*=(?!=)/g)].map((m) => `${f.path}: ${m[0].trim()}`));
  eq(declarations, ["lib/platform/oauth.js: OAUTH_SCOPES ="], "scope list declarations:");
  const named = prodFiles.filter((f) => f.path !== "lib/platform/oauth.js").flatMap((f) => [...f.text.matchAll(READ_SCOPE_TOKEN)].map((m) => `${f.path}: ${m[0]}`));
  eq(named.filter((n) => !READ_SCOPE_MENTIONS.includes(n)), [], "Read scopes belong in OAUTH_SCOPES. If this is not a Shopify scope, add it to READ_SCOPE_MENTIONS here. Found:");
  const params = files.flatMap((f) => [...f.text.matchAll(/[?&]scope=([^\s"'`&]*)/g)].map((m) => [f.path, m[1]]));
  eq(sorted(params.map(([p]) => p)), ["lib/platform/oauth.js", "scripts/shopify-oauth.js"], "files building an authorize URL:");
  for (const [path, value] of params) eq(value, "${encodeURIComponent(OAUTH_SCOPES)}", `${path} scope param:`);
});

await t("SHOP-01: the one-time OAuth script still loads with the shared list", async () => {
  // It exits before listening when no app credentials are set, so this only
  // proves the import resolves. Credentials are stripped from the child's env.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SHOPIFY_")));
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/shopify-oauth.js")], { env, encoding: "utf8" });
  eq(r.status, 1, "exit code:");
  ok(r.stderr.includes("Need SHOPIFY_STORE_DOMAIN"), `expected the missing-credentials message, got: ${r.stderr.slice(0, 300)}`);
});

// ===========================================================================
// SHOP-02: an order push cannot carry content
// ===========================================================================
const LINE_KEYS = ["quantity", "variantId"];
const GIFT_LINE_KEYS = ["appliedDiscount", "quantity", "variantId"];
const GIFT_DISCOUNT = { valueType: "PERCENTAGE", value: 100, title: "Free gift", description: "FREE_GIFT offer" };

const PRODUCT_ID = "gid://shopify/Product/9001";
const VARIANT_ID = "gid://shopify/ProductVariant/9002";
const GIFT_PRODUCT_ID = "gid://shopify/Product/9003";
const GIFT_VARIANT_ID = "gid://shopify/ProductVariant/9004";

// What the catalog says, deliberately different from what the order froze.
// Every text column except the ids. A test below holds these lists to the schema.
const CATALOG_STRINGS = {
  handle: "CATALOG-HANDLE-SENTINEL",
  title: "CATALOG-TITLE-SENTINEL",
  description: "CATALOG-DESCRIPTION-SENTINEL",
  description_html: "<p>CATALOG-HTML-SENTINEL</p>",
  product_type: "CATALOG-TYPE-SENTINEL",
  vendor: "CATALOG-VENDOR-SENTINEL",
  tags: JSON.stringify(["CATALOG-TAG-SENTINEL"]),
  currency: "CATALOG-CURRENCY-SENTINEL",
  featured_image: "https://cdn.test/CATALOG-IMAGE-SENTINEL.png",
  featured_image_alt: "CATALOG-ALT-SENTINEL",
  options: JSON.stringify([{ name: "CATALOG-OPTIONS-SENTINEL", values: ["CATALOG-OPTIONS-SENTINEL"] }]),
  created_at: "CATALOG-CREATED-SENTINEL",
  updated_at: "CATALOG-UPDATED-SENTINEL",
  synced_at: "CATALOG-SYNCED-SENTINEL",
};
const CATALOG_VARIANT_STRINGS = {
  title: "CATALOG-VARIANT-TITLE-SENTINEL",
  sku: "CATALOG-SKU-SENTINEL",
  currency: "CATALOG-VARIANT-CURRENCY-SENTINEL",
  selected_options: JSON.stringify([{ name: "CATALOG-SELECTED-OPTIONS-SENTINEL", value: "CATALOG-SELECTED-OPTIONS-SENTINEL" }]),
  image_url: "https://cdn.test/CATALOG-VARIANT-IMAGE-SENTINEL.png",
};
const CATALOG_IMAGE_STRINGS = {
  url: "https://cdn.test/CATALOG-GALLERY-IMAGE-SENTINEL.png",
  alt: "CATALOG-GALLERY-ALT-SENTINEL",
};
const CATALOG_IDS = { products: ["id"], variants: ["id", "product_id"], product_images: ["id", "product_id"] };
// What the cart froze on the order.
const ORDER_STRINGS = {
  title: "ORDER-TITLE-SENTINEL",
  variantTitle: "ORDER-VARIANT-TITLE-SENTINEL",
  image: "https://cdn.test/ORDER-IMAGE-SENTINEL.png",
  handle: "order-handle-sentinel",
  // Named by OVL-06 as coming to snapshots. They must not reach Shopify either.
  catalog_title: "ORDER-CATALOG-TITLE-SENTINEL",
  sku: "ORDER-SKU-SENTINEL",
};

// OVL-03 (P4-EFFECTIVE): the overlay is a published row in product_content_live
// (migration 0024), read through lib/catalog/effective.js. seedOverlay() writes
// one for the catalog product below, as a publish would (the publish writer is
// P4-LIVEROW's). The hand-made CART stays here because it also carries order
// content (ORDER_STRINGS) the effective read never makes; the test after it
// builds the order's cart through the real effective read, with a gift and a
// bundle.
const OVERLAY_TITLE = "OVERLAY-TITLE-SENTINEL";
async function liveTable() {
  await libsql.executeMultiple(await readFile(join(ROOT, "migrations/tenant/0024_content_live.sql"), "utf8"));
}
async function seedOverlay() {
  await liveTable();
  await db
    .insertInto("product_content_live")
    .values({ product_id: PRODUCT_ID, document_id: "doc_prod_boundary", version_id: "ver_boundary", title: OVERLAY_TITLE, display_type: "OVERLAY-TYPE-SENTINEL", display_vendor: "OVERLAY-VENDOR-SENTINEL", description: "OVERLAY-DESCRIPTION-SENTINEL", published_at: "2026-11-04T00:00:00.000Z" })
    .execute();
}

// The sentinel inside each value, so a URL or JSON wrapper cannot hide it.
const sentinelOf = (s) => /[A-Z-]+-SENTINEL|order-handle-sentinel/.exec(s)[0];
const CONTENT_THAT_MUST_NOT_REACH_SHOPIFY = [
  OVERLAY_TITLE,
  ...[...Object.values(CATALOG_STRINGS), ...Object.values(CATALOG_VARIANT_STRINGS), ...Object.values(CATALOG_IMAGE_STRINGS), ...Object.values(ORDER_STRINGS)].map(sentinelOf),
];

const CART = {
  items: [{ variantId: VARIANT_ID, productId: PRODUCT_ID, price: 1000, quantity: 2, lineTotal: 2000, discount: 0, ...ORDER_STRINGS }],
  gifts: [{ variantId: GIFT_VARIANT_ID, productId: GIFT_PRODUCT_ID, ...ORDER_STRINGS }],
  appliedOffers: [{ id: "o1", label: "Launch offer", amount: 100 }],
  couponStatus: null,
  subtotal: 2000,
  discountTotal: 100,
  total: 1900,
  currency: "INR",
};
const CONTACT = { email: "shopper@example.test", phone: "9000000012", name: "Boundary Tester" };
const ADDRESS = { line1: "12 Sync St", line2: "Floor 2", city: "Pune", state: "MH", pincode: "411001", country: "India" };

let seq = 0;
async function seedOrder({ method = "razorpay", paid = true, cart = CART, shipping } = {}) {
  const o = await O.createOrder({
    cart,
    contact: CONTACT,
    address: ADDRESS,
    paymentMethod: method,
    idempotencyKey: `boundary-${++seq}`,
    razorpayOrderId: method === "razorpay" ? `order_B${seq}` : null,
    ...(shipping ? { shipping } : {}),
  });
  if (paid && method === "razorpay") await O.markOrderPaid(o.id, { razorpayPaymentId: `pay_B${seq}` });
  return o.id;
}

function fakeShopify(total = CART.total) {
  const calls = [];
  const gql = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes("draftOrderCreate"))
      return { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1" }, userErrors: [] } };
    if (query.includes("draftOrderComplete"))
      return {
        draftOrderComplete: {
          draftOrder: {
            id: variables.id,
            status: "COMPLETED",
            order: { id: "gid://shopify/Order/1", name: "#T1", displayFinancialStatus: "PAID", totalPriceSet: { shopMoney: { amount: String(total) } } },
          },
          userErrors: [],
        },
      };
    if (query.includes("orderCancel")) return { orderCancel: { job: { id: "j1" }, orderCancelUserErrors: [] } };
    return { orders: { nodes: [] }, draftOrders: { nodes: [] } };
  };
  gql.calls = calls;
  return gql;
}

// A hand-built order with every optional part present, so every path shows up.
const fullOrder = (overrides = {}) => ({
  id: "BL-BOUNDARY1",
  email: CONTACT.email,
  total: 1900,
  shipping_total: 49,
  razorpay_order_id: "order_X",
  razorpay_payment_id: "pay_X",
  snapshot: {
    items: [{ variantId: VARIANT_ID, quantity: 2, ...ORDER_STRINGS, description: "ORDER-DESCRIPTION-SENTINEL", vendor: "ORDER-VENDOR-SENTINEL" }],
    gifts: [{ variantId: GIFT_VARIANT_ID, ...ORDER_STRINGS, quantity: 9 }],
    appliedOffers: [{ id: "o1", label: "Launch offer", amount: 100 }],
    totals: { discountTotal: 100, shippingTotal: 49 },
    shipping: { method: "standard", label: "Standard shipping" },
    contact: CONTACT,
    address: ADDRESS,
  },
  ...overrides,
});

// fullOrder() can only fire branches for fields it has. A key added behind a field
// it lacks, such as `...(it.displayTitle ? { title: it.displayTitle } : {})`, would
// never show up. So this wraps the whole order: a field the fixture does not have
// reads as a marker string and is written down. That fires the branch, and the
// exact key and path checks then see what comes out.
const UNKNOWN_FIELD = "UNKNOWN-FIELD-MARKER";
function probeUnknownFields(order) {
  const unknownReads = [];
  const wrap = (value, path) =>
    new Proxy(value, {
      get(target, key, receiver) {
        if (typeof key === "symbol") return Reflect.get(target, key, receiver);
        if (!(key in target)) {
          unknownReads.push(`${path}.${key}`);
          return UNKNOWN_FIELD;
        }
        const v = Reflect.get(target, key, receiver);
        return v && typeof v === "object" ? wrap(v, Array.isArray(target) ? `${path}[]` : `${path}.${key}`) : v;
      },
    });
  return { order: wrap(order, "order"), unknownReads };
}
const READS_UNKNOWN = "The draft order reads a field this test does not have. Add it to fullOrder() so its branch runs:";

await t("SHOP-02: the unknown-field probe fires a branch the fixture would not", async () => {
  const items = (o) => o.snapshot.items.map((it) => ({ variantId: it.variantId, ...(it.displayTitle ? { title: it.displayTitle } : {}) }));
  eq(Object.keys(items(fullOrder())[0]), ["variantId"], "plain fixture:");
  const { order, unknownReads } = probeUnknownFields(fullOrder());
  eq(items(order)[0], { variantId: VARIANT_ID, title: UNKNOWN_FIELD }, "probed:");
  eq(sorted(unknownReads), ["order.snapshot.items[].displayTitle"], "reads written down:");
});

await t("SHOP-02: a paid line item carries only variantId and quantity", async () => {
  const input = P.buildDraftOrderInput(fullOrder());
  eq(Object.keys(input.lineItems[0]).sort(), LINE_KEYS, "line item keys:");
  eq(input.lineItems[0], { variantId: VARIANT_ID, quantity: 2 }, "line item:");
});

await t("SHOP-02: a gift line carries only variantId, quantity and the fixed discount", async () => {
  const input = P.buildDraftOrderInput(fullOrder());
  eq(Object.keys(input.lineItems[1]).sort(), GIFT_LINE_KEYS, "gift keys:");
  eq(input.lineItems[1], { variantId: GIFT_VARIANT_ID, quantity: 1, appliedDiscount: GIFT_DISCOUNT }, "gift line:");
});

await t("SHOP-02: a line key behind a field the order does not have yet fails here too", async () => {
  const { order, unknownReads } = probeUnknownFields(fullOrder());
  const { lineItems } = P.buildDraftOrderInput(order);
  eq(lineItems.map((l) => Object.keys(l).sort()), [LINE_KEYS, GIFT_LINE_KEYS], "line item keys:");
  eq(sorted(unknownReads), [], READS_UNKNOWN);
});

await t("SHOP-02: content on the snapshot (title, handle, image, sku, catalog_title) stays out of the draft", async () => {
  const wire = JSON.stringify(P.buildDraftOrderInput(fullOrder()));
  for (const s of [...Object.values(ORDER_STRINGS), "ORDER-DESCRIPTION-SENTINEL", "ORDER-VENDOR-SENTINEL"]) {
    ok(!wire.includes(s), `${s} reached the draft order`);
  }
});

await t("SHOP-02: the push test below seeds every text column of the catalog tables", async () => {
  const seeded = { products: CATALOG_STRINGS, variants: CATALOG_VARIANT_STRINGS, product_images: CATALOG_IMAGE_STRINGS };
  for (const [table, strings] of Object.entries(seeded)) {
    const { rows } = await libsql.execute(`PRAGMA table_info(${table})`);
    const text = rows.filter((c) => c.type === "TEXT").map((c) => c.name);
    eq(sorted(text.filter((c) => !CATALOG_IDS[table].includes(c))), sorted(Object.keys(strings)), `${table} text columns:`);
  }
});

await t("SHOP-02: through the real push, no catalog text and no order content appears anywhere", async () => {
  await db.insertInto("products").values({ id: PRODUCT_ID, available: 1, ...CATALOG_STRINGS }).execute();
  await db.insertInto("variants").values({ id: VARIANT_ID, product_id: PRODUCT_ID, available: 1, ...CATALOG_VARIANT_STRINGS }).execute();
  await db.insertInto("product_images").values({ id: `${PRODUCT_ID}::img::0`, product_id: PRODUCT_ID, ...CATALOG_IMAGE_STRINGS }).execute();
  await seedOverlay();
  ok(CATALOG_STRINGS.title !== ORDER_STRINGS.title, "the fixture must have two different titles");

  const id = await seedOrder();
  const gql = fakeShopify();
  const r = await P.pushOrderToShopify(id, { gql });
  ok(r.ok, `push failed: ${JSON.stringify(r)}`);
  eq(gql.calls.length, 3, "find, create, complete:");

  const everythingSent = JSON.stringify(gql.calls);
  for (const s of CONTENT_THAT_MUST_NOT_REACH_SHOPIFY) ok(!everythingSent.includes(s), `${s} reached Shopify`);

  const { lineItems } = gql.calls[1].variables.input;
  eq(lineItems.map((l) => Object.keys(l).sort()), [LINE_KEYS, GIFT_LINE_KEYS], "line item keys on the wire:");
});

await t("SHOP-02 (OVL-03): a cart built through the effective read, with published titles on a paid line, a gift and both bundle components, sends no overlay text to Shopify, not even in a discount description", async () => {
  await liveTable();
  // the cart and bundle tables as a real tenant has them (this suite's store is the bare baseline)
  for (const m of ["0004_cart_price_at_add", "0011_commerce_expansion"]) await libsql.executeMultiple(await readFile(join(ROOT, `migrations/tenant/${m}.sql`), "utf8"));
  const Cart = await import("../lib/cart.js");
  const { upsertOffer, deleteOffer } = await import("../lib/offers/store.js");
  const Bun = await import("../lib/bundles.js");
  const pid = (n) => `gid://shopify/Product/95${n}`;
  const vid = (n) => `gid://shopify/ProductVariant/95${n}1`;
  const OVERLAY = { 1: "OVERLAY-PAID-TITLE-SENTINEL", 2: "OVERLAY-GIFT-TITLE-SENTINEL", 3: "OVERLAY-BUNDLE-A-SENTINEL", 4: "OVERLAY-BUNDLE-B-SENTINEL" };
  for (const n of [1, 2, 3, 4]) {
    await db.insertInto("products").values({ id: pid(n), handle: `ov-${n}`, title: `RAW-TITLE-${n}-SENTINEL`, price_min: 500, price_max: 500, currency: "INR", available: 1, tags: "[]" }).execute();
    await db.insertInto("variants").values({ id: vid(n), product_id: pid(n), title: "Default Title", sku: `OV-SKU-${n}-SENTINEL`, price: 500, currency: "INR", available: 1 }).execute();
    await db.insertInto("product_content_live").values({ product_id: pid(n), document_id: `doc_prod_ov${n}`, version_id: `ver_ov${n}`, title: OVERLAY[n], display_type: `OVERLAY-TYPE-${n}-SENTINEL`, display_vendor: `OVERLAY-VENDOR-${n}-SENTINEL`, description_html: `<p>OVERLAY-HTML-${n}-SENTINEL</p>`, published_at: "2026-11-04T00:00:00.000Z" }).execute();
  }
  await upsertOffer({ offer: { id: "ov-gift", type: "FREE_GIFT", scope: "gift", priority: 40, title: "Gift deal", threshold: 100, gift: { variantId: vid(2), productId: pid(2), handle: "ov-2", title: "STORED-GIFT-TITLE", image: null, value: 500 } } });
  const bundle = await Bun.upsertBundle({ slug: "ov-duo", title: "Duo deal", items: [{ variantId: vid(3) }, { variantId: vid(4) }], bundle_price: 800, enable: true });
  try {
    await Cart.createCart("ov-cart");
    for (const n of [1, 3, 4]) await Cart.addItem("ov-cart", vid(n), 1);
    const cart = await Cart.getCart("ov-cart");
    // the overlay really is in the cart and on the order: the shopper saw it
    eq(cart.items.map((i) => i.title), [OVERLAY[1], OVERLAY[3], OVERLAY[4]], "cart titles:");
    eq(cart.gifts.map((g) => g.title), [OVERLAY[2]], "gift title:");
    eq(cart.appliedOffers.map((o) => o.label).sort(), ["Duo deal", "Gift deal"], "offers applied:");
    const id = await seedOrder({ cart });
    const snapshot = (await libsql.execute({ sql: "SELECT snapshot FROM orders WHERE id = ?", args: [id] })).rows[0].snapshot;
    for (const s of Object.values(OVERLAY)) ok(snapshot.includes(s), `${s} is not on the order (the test would prove nothing)`);
    const gql = fakeShopify(cart.total);
    const r = await P.pushOrderToShopify(id, { gql });
    ok(r.ok, `push failed: ${JSON.stringify(r)}`);
    const wire = JSON.stringify(gql.calls);
    const leaked = [...new Set(wire.match(/OVERLAY-[A-Z0-9-]*SENTINEL|RAW-TITLE-\d-SENTINEL|OV-SKU-\d-SENTINEL|STORED-GIFT-TITLE/g) || [])];
    eq(leaked, [], "content reached Shopify:");
    const input = gql.calls[1].variables.input;
    eq(input.lineItems.map((l) => Object.keys(l).sort()), [LINE_KEYS, LINE_KEYS, LINE_KEYS, GIFT_LINE_KEYS], "line item keys:");
    eq(input.lineItems[3].appliedDiscount, GIFT_DISCOUNT, "the gift line's discount (fixed words):");
    eq(input.appliedDiscount.description.split(" + ").sort(), ["Duo deal", "Gift deal"], "the order discount's description is offer and bundle titles only:");
  } finally {
    await deleteOffer("ov-gift");
    await Bun.deleteBundle(bundle.id);
  }
});

// ===========================================================================
// SHOP-04: every free-text route, by name
// ===========================================================================
// Merchant-typed or merchant-set text that reaches Shopify. All of it is order
// data, not content write-back, so it is consistent with Decision 2.
const MERCHANT_TEXT_ROUTES = {
  "discount description": { path: "appliedDiscount.description", from: "offer and bundle titles, through the offer engine's label" },
  "discount title": { path: "appliedDiscount.title", from: "the store name" },
  "shipping title": { path: "shippingLine.title", from: "the shipping label, which can carry a merchant's zone label" },
  note: { path: "note", from: "a fixed sentence with our order id, which carries the store's order-id prefix" },
  tags: { path: "tags[]", from: "a fixed tag and our order id" },
  "order id attribute": { path: "customAttributes[].value", from: "our order id on bl_order_id, with the store's order-id prefix. The other attributes are a fixed string, an amount and payment ids" },
};
const CANCEL_STAFF_NOTE = { variable: "staffNote", from: "the reason typed when cancelling an order" };

const ADDRESS_PATHS = ["firstName", "lastName", "address1", "address2", "city", "province", "zip", "country", "phone"];
// Typed by the shopper, for delivery. Not merchant text and not content.
const SHOPPER_PATHS = ["email", ...["shippingAddress", "billingAddress"].flatMap((a) => ADDRESS_PATHS.map((k) => `${a}.${k}`))];
// Ids, amounts, and strings fixed in code.
const FIXED_PATHS = [
  "appliedDiscount.value",
  "appliedDiscount.valueType",
  "customAttributes[].key",
  "lineItems[].appliedDiscount.description",
  "lineItems[].appliedDiscount.title",
  "lineItems[].appliedDiscount.value",
  "lineItems[].appliedDiscount.valueType",
  "lineItems[].quantity",
  "lineItems[].variantId",
  "shippingLine.price",
];
const KNOWN_PATHS = [...Object.values(MERCHANT_TEXT_ROUTES).map((r) => r.path), ...SHOPPER_PATHS, ...FIXED_PATHS];

// Paths of every value, in the form that goes over the wire. An empty array or
// object gets a path too, so a new field cannot go out unnamed and fill up later.
function leaves(value, path = "", out = []) {
  if (Array.isArray(value)) {
    if (!value.length) out.push({ path: `${path}[]`, value });
    for (const v of value) leaves(v, `${path}[]`, out);
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) out.push({ path, value });
    for (const [k, v] of entries) leaves(v, path ? `${path}.${k}` : k, out);
  } else out.push({ path, value });
  return out;
}
const wireLeaves = (value) => leaves(JSON.parse(JSON.stringify(value)));

await t("SHOP-04: an empty array or object still gets a path", async () => {
  eq(wireLeaves({ a: [], b: {}, c: [{ d: [] }] }).map((l) => l.path), ["a[]", "b", "c[].d[]"], "paths:");
});

await t("SHOP-04: the route list names the spec's six (discount description and title, shipping title, note, tags, cancel staff note) and the order id attribute", async () => {
  eq(Object.keys(MERCHANT_TEXT_ROUTES).sort(), ["discount description", "discount title", "note", "order id attribute", "shipping title", "tags"], "draft order routes:");
  eq(CANCEL_STAFF_NOTE.variable, "staffNote", "cancel route:");
});

await t("SHOP-04: a draft order holds only known fields, so a new free-text field fails here", async () => {
  const found = sorted(wireLeaves(P.buildDraftOrderInput(fullOrder())).map((l) => l.path));
  const unknown = found.filter((p) => !KNOWN_PATHS.includes(p));
  eq(unknown, [], "New field sent to Shopify. Decide whether it is order data, then name it in this test:");
  eq(found, sorted(KNOWN_PATHS), "every known field still sent:");
});

await t("SHOP-04: a field behind a value the order does not have yet fails here too", async () => {
  const { order, unknownReads } = probeUnknownFields(fullOrder());
  const found = sorted(wireLeaves(P.buildDraftOrderInput(order)).map((l) => l.path));
  eq(found.filter((p) => !KNOWN_PATHS.includes(p)), [], "New field sent to Shopify. Decide whether it is order data, then name it in this test:");
  eq(found, sorted(KNOWN_PATHS), "every known field still sent:");
  eq(sorted(unknownReads), [], READS_UNKNOWN);
});

// The checks above read what the builder returns. These read what the fake Shopify
// received from the real push, so anything added between the builder and the send
// fails too. The sent draft must equal the builder's, which carries those checks over.
function checkRealPush({ order, gql, pending, attributeKeys }) {
  eq(gql.calls.map((c) => Object.keys(c.variables).sort()), [["q"], ["input"], ["id", "pending"]], "variables of find, create, complete:");
  eq(gql.calls[0].variables.q, `tag:'${order.id}'`, "find:");
  eq(gql.calls[2].variables, { id: "gid://shopify/DraftOrder/1", pending }, "complete:");
  const { input } = gql.calls[1].variables;
  const found = sorted(wireLeaves(input).map((l) => l.path));
  eq(found.filter((p) => !KNOWN_PATHS.includes(p)), [], "New field sent to Shopify. Decide whether it is order data, then name it in this test:");
  eq(input.customAttributes.map((a) => a.key).sort(), attributeKeys, "custom attribute keys on the wire:");
  eq(input, P.buildDraftOrderInput(order), "the draft sent is the draft the builder returned:");
  return found;
}

await t("SHOP-04: through the real push, a paid order sends only known fields and variables", async () => {
  const id = await seedOrder();
  const gql = fakeShopify();
  const r = await P.pushOrderToShopify(id, { gql });
  ok(r.ok, `push failed: ${JSON.stringify(r)}`);
  const attributeKeys = ["bl_order_id", "captured_amount_inr", "channel", "razorpay_order_id", "razorpay_payment_id"];
  const found = checkRealPush({ order: await O.getOrder(id), gql, pending: false, attributeKeys });
  eq(found, sorted(KNOWN_PATHS), "every known field still sent:");
});

await t("SHOP-04: through the real push, a COD order with nothing optional sends only known fields and variables", async () => {
  const id = await seedOrder({ method: "cod", cart: { ...CART, gifts: [], appliedOffers: [], discountTotal: 0, total: 2000 } });
  const gql = fakeShopify(2000);
  const r = await P.pushOrderToShopify(id, { gql });
  ok(r.ok, `push failed: ${JSON.stringify(r)}`);
  checkRealPush({ order: await O.getOrder(id), gql, pending: true, attributeKeys: ["bl_order_id", "captured_amount_inr", "channel"] });
});

await t("SHOP-04: each piece of merchant text reaches Shopify only through its named field", async () => {
  const STORE = "STORE-NAME-SENTINEL";
  const OFFER = "OFFER-LABEL-SENTINEL";
  const SHIP = "SHIP-LABEL-SENTINEL";
  const PREFIX = "PREFIX-SENTINEL";
  const input = withTenant({ id: "boundary", config: { site: { name: STORE } } }, () =>
    P.buildDraftOrderInput(
      fullOrder({
        id: `${PREFIX}-1`,
        snapshot: {
          ...fullOrder().snapshot,
          appliedOffers: [{ id: "o1", label: OFFER, amount: 100 }],
          shipping: { method: "standard", label: SHIP },
        },
      }),
    ),
  );
  const whereIs = (needle) => sorted(wireLeaves(input).filter((l) => String(l.value).includes(needle)).map((l) => l.path));
  eq(whereIs(OFFER), [MERCHANT_TEXT_ROUTES["discount description"].path], "offer label:");
  eq(whereIs(STORE), [MERCHANT_TEXT_ROUTES["discount title"].path], "store name:");
  eq(whereIs(SHIP), [MERCHANT_TEXT_ROUTES["shipping title"].path], "shipping label:");
  eq(whereIs(PREFIX), sorted(["note", "tags", "order id attribute"].map((r) => MERCHANT_TEXT_ROUTES[r].path)), "order id:");
  eq(input.tags, ["storeasy26", `${PREFIX}-1`], "tags are the fixed tag and the order id:");
  eq(input.customAttributes.map((a) => a.key).sort(), ["bl_order_id", "captured_amount_inr", "channel", "razorpay_order_id", "razorpay_payment_id"], "custom attribute keys:");
});

await t("SHOP-04: a bundle's title reaches Shopify as the discount description, capped at 250 characters", async () => {
  const BUNDLE_TITLE = `BUNDLE-TITLE-SENTINEL ${"x".repeat(300)}`;
  // Same shape as syncOffer in lib/bundles.js.
  const offer = { id: "bundle:b1", type: "BUNDLE", scope: "line", priority: 5, title: BUNDLE_TITLE, items: [{ variantId: "v-a", quantity: 1 }, { variantId: "v-b", quantity: 1 }], price: 2500 };
  const line = (id, price) => ({ variantId: id, productId: `p-${id}`, handle: id, tags: [], price, quantity: 1 });
  const { appliedOffers } = evaluateOffers([line("v-a", 2000), line("v-b", 1000)], { offers: [offer] });
  eq(appliedOffers.map((o) => o.label), [BUNDLE_TITLE], "engine label:");
  const { appliedDiscount } = P.buildDraftOrderInput(fullOrder({ snapshot: { ...fullOrder().snapshot, appliedOffers } }));
  ok(appliedDiscount.description.startsWith("BUNDLE-TITLE-SENTINEL"), "bundle title in the description");
  eq(appliedDiscount.description.length, 250, "description length:");
});

await t("SHOP-04: the cancel reason reaches Shopify only as the staff note", async () => {
  const REASON = "CANCEL-REASON-SENTINEL";
  const id = await seedOrder({ method: "cod" });
  await db.updateTable("orders").set({ shopify_order_id: "gid://shopify/Order/55" }).where("id", "=", id).execute();
  const gql = fakeShopify();
  const r = await cancelOrder(id, { reason: REASON, gql });
  ok(r.ok, JSON.stringify(r));
  eq(gql.calls.length, 1, "one call:");
  const { variables, query } = gql.calls[0];
  eq(variables, { id: "gid://shopify/Order/55", reason: "OTHER", staffNote: `storeasy26: ${REASON}` }, "cancel variables:");
  eq(wireLeaves(variables).filter((l) => String(l.value).includes(REASON)).map((l) => l.path), [CANCEL_STAFF_NOTE.variable], "reason:");
  ok(!query.includes(REASON), "reason stays out of the document");
});

await t("SHOP-04: the admin mutations carry no merchant text at all", async () => {
  const seen = [];
  const gql = async (query, variables) => {
    seen.push(variables);
    if (query.includes("webhookSubscriptions(")) return { webhookSubscriptions: { nodes: [{ id: "w1", topic: WEBHOOK_TOPICS[0], endpoint: { callbackUrl: "https://old.test/hook" } }] } };
    return { webhookSubscriptionCreate: { webhookSubscription: { id: "w2" }, userErrors: [] }, webhookSubscriptionUpdate: { webhookSubscription: { id: "w1" }, userErrors: [] } };
  };
  const callbackUrl = "https://new.test/hook";
  await registerWebhooks({ id: "boundary", name: "MERCHANT-NAME-SENTINEL", config: {} }, { callbackUrl, gql });
  const writes = seen.filter(Boolean).filter((v) => v.sub);
  ok(writes.length === WEBHOOK_TOPICS.length, `one write per topic, got ${writes.length}`);
  for (const v of writes) {
    eq(Object.keys(v).sort(), v.id ? ["id", "sub"] : ["sub", "topic"], "webhook variables:");
    eq(v.sub, { callbackUrl }, "webhook subscription:");
  }

  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ data: { storefrontAccessTokenCreate: { storefrontAccessToken: { accessToken: "t", title: "x" }, userErrors: [] } } }), { status: 200 });
  };
  try {
    await mintStorefrontToken("fake-admin-token");
  } finally {
    globalThis.fetch = realFetch;
  }
  eq(bodies[0].variables, { input: { title: "storeasy26 catalog sync" } }, "storefront token variables:");
});

// ===========================================================================
// SHOP-03: the dead Shopify checkout link
// ===========================================================================
await t("SHOP-03: no Shopify cart or checkout link in lib, app, components", async () => {
  const bad = (await sourceFiles(["lib", "app", "components"])).flatMap((f) => findShopifyCartLinks(f.text).map((h) => `${f.path}: ${h}`));
  eq(bad.length, 0, `A Shopify cart link shows Shopify titles and skips the offer engine:${listIn(bad)}\n   `);
});

// ===========================================================================
// SHOP-06: the check is wired up
// ===========================================================================
await t("SHOP-06: pnpm test, the workflow and the hook name this suite, and their text has no off switch", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  eq(pkg.scripts.test, "node scripts/run-tests.js", "test script:");
  eq(pkg.scripts["test:shopify-boundary"], "node scripts/test-shopify-boundary.js", "suite script:");
  const weakened = Object.entries(pkg.scripts).filter(([name, cmd]) => name.startsWith("test:") && !/^node scripts\/[\w.-]+\.js$/.test(cmd));
  eq(weakened, [], "every test:* command must be exactly node scripts/<file>.js:");
  const runner = await readFile(join(ROOT, "scripts/run-tests.js"), "utf8");
  ok(runner.includes('const NOT_A_GATE = new Set(["test:perf"]);'), "only test:perf is left out of the gate");

  // Comment lines first: a line that has been commented out runs nothing.
  const code = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

  const workflow = code(await readFile(join(ROOT, ".github/workflows/test.yml"), "utf8"));
  ok(/^on:\n  push:\n  workflow_dispatch: \{\}$/m.test(workflow), "the workflow runs on every push");
  ok(/^\s*- run: pnpm test\s*$/m.test(workflow), "the workflow runs pnpm test");
  eq([...workflow.matchAll(/^[\s-]*["']?(if|continue-on-error)["']?\s*:/gm)].map((m) => m[1]), [], "switches that skip the gate or ignore its failure:");

  const hook = code(await readFile(join(ROOT, ".githooks/pre-commit"), "utf8"));
  ok(/^pnpm test\nstatus=\$\?$/m.test(hook), "the hook runs pnpm test and keeps its result");
  ok(hook.trimEnd().endsWith('exit "$status"'), 'the hook ends with exit "$status"');
  eq([...hook.matchAll(/\bexit\b.*/g)].map((m) => m[0]), ["exit 1", "exit 1", 'exit "$status"'], "the hook's exits:");
});

// Runs copies of the real hooks in a throwaway git repo, with a stand-in pnpm first on
// PATH so nothing recurses. Throwaway, because the hook looks at the repo's state and
// this suite has to pass on a tree with work in progress. core.hooksPath is given per
// call, in that repo only, and nothing here touches this repo's config.
async function withHookRepo(pnpmExit, fn) {
  const dir = await mkdtemp(join(tmpdir(), "boundary-hook-"));
  try {
    const repo = join(dir, "repo");
    const stubs = join(dir, "stubs");
    const log = join(dir, "calls");
    await mkdir(join(repo, ".githooks"), { recursive: true });
    await mkdir(stubs);
    await writeFile(log, "");
    await writeFile(join(stubs, "pnpm"), `#!/bin/sh\necho "$*" >> "$STUB_PNPM_LOG"\nexit ${pnpmExit}\n`, { mode: 0o755 });
    for (const hook of ["pre-commit", "pre-merge-commit"]) await copyFile(join(ROOT, ".githooks", hook), join(repo, ".githooks", hook));
    // Anything git set for an outer hook would point these calls back at this repo.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const env = { ...inherited, PATH: `${stubs}${delimiter}${inherited.PATH}`, STUB_PNPM_LOG: log, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args) => {
      const identity = ["-c", "user.name=Boundary Test", "-c", "user.email=boundary@example.test", "-c", "core.hooksPath=.githooks"];
      const r = spawnSync("git", [...identity, ...args], { cwd: repo, env, encoding: "utf8" });
      return { status: r.status, output: r.stdout + r.stderr };
    };
    const must = (...args) => {
      const r = git(...args);
      eq(r.status, 0, `git ${args.join(" ")}: ${r.output}\n`);
      return r.output.trim();
    };
    const write = (file, text) => writeFile(join(repo, file), text);
    const calls = () => readFile(log, "utf8");
    const runHook = (hook = "pre-commit") => {
      const r = spawnSync(join(repo, ".githooks", hook), [], { cwd: repo, env, encoding: "utf8" });
      return { status: r.status, stderr: r.stderr };
    };
    must("init", "-q", "-b", "main");
    await write("a.js", "one\n");
    must("add", ".");
    must("commit", "-q", "--no-verify", "-m", "base");
    return await fn({ git, must, write, calls, runHook, repo });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await t("SHOP-06: the hook runs pnpm test and stops the commit when it fails", async () => {
  await withHookRepo(3, async ({ runHook, calls }) => {
    const failed = runHook();
    eq(await calls(), "test\n", "what the hook ran:");
    eq(failed.status, 3, "hook exit when pnpm test fails:");
    ok(failed.stderr.includes("Commit stopped"), `expected the stop message, got: ${failed.stderr.slice(0, 200)}`);
  });
  await withHookRepo(0, async ({ runHook, calls }) => {
    eq(runHook().status, 0, "hook exit when pnpm test passes:");
    eq(await calls(), "test\n", "what the hook ran:");
  });
});

await t("SHOP-06: a real commit stops on a failing pnpm test, and goes through on a passing one", async () => {
  await withHookRepo(3, async ({ git, must, write, calls }) => {
    const head = must("rev-parse", "HEAD");
    await write("b.js", "two\n");
    must("add", "b.js");
    const r = git("commit", "-m", "next");
    ok(r.status !== 0, `commit went through: ${r.output}`);
    eq(must("rev-parse", "HEAD"), head, "HEAD:");
    eq(await calls(), "test\n", "what the hook ran:");
  });
  await withHookRepo(0, async ({ must, write, calls }) => {
    await write("b.js", "two\n");
    must("add", "b.js");
    must("commit", "-q", "-m", "next");
    eq(must("log", "--format=%s", "-1"), "next", "the commit:");
    eq(await calls(), "test\n", "what the hook ran:");
  });
});

await t("SHOP-06: the hook refuses a commit whose staged content is not what is on disk", async () => {
  // Staged, then gone from disk: pnpm test would pass with the staged text unread.
  await withHookRepo(0, async ({ git, must, write, calls, repo }) => {
    const head = must("rev-parse", "HEAD");
    await write("staged.js", "productUpdate\n");
    must("add", "staged.js");
    await rm(join(repo, "staged.js"));
    const r = git("commit", "-m", "next");
    ok(r.status !== 0, `commit went through: ${r.output}`);
    ok(r.output.includes("Commit stopped") && r.output.includes("staged.js"), r.output);
    eq(must("rev-parse", "HEAD"), head, "HEAD:");
    eq(await calls(), "", "stopped before running anything:");
  });
  // Staged, then changed on disk.
  await withHookRepo(0, async ({ git, must, write, calls }) => {
    await write("a.js", "productUpdate\n");
    must("add", "a.js");
    await write("a.js", "clean\n");
    ok(git("commit", "-m", "next").status !== 0, "a changed file must stop the commit");
    eq(await calls(), "", "stopped before running anything:");
  });
  // A file only touched is not different.
  await withHookRepo(0, async ({ must, write, calls }) => {
    await write("a.js", "one\n");
    must("commit", "-q", "--allow-empty", "-m", "next");
    eq(await calls(), "test\n", "what the hook ran:");
  });
  // commit -a commits what is on disk, so nothing differs. The hook has to read the
  // index git hands it, not the old one.
  await withHookRepo(0, async ({ must, write, calls }) => {
    await write("a.js", "two\n");
    must("commit", "-q", "-a", "-m", "next");
    eq(must("show", "HEAD:a.js"), "two", "the commit:");
    eq(await calls(), "test\n", "what the hook ran:");
  });
});

await t("SHOP-06: a real merge commit runs the same check", async () => {
  const diverged = async ({ must, write }) => {
    must("checkout", "-q", "-b", "other");
    await write("other.js", "other\n");
    must("add", "other.js");
    must("commit", "-q", "--no-verify", "-m", "other");
    must("checkout", "-q", "main");
    await write("main.js", "main\n");
    must("add", "main.js");
    must("commit", "-q", "--no-verify", "-m", "main");
  };
  await withHookRepo(3, async (repo) => {
    await diverged(repo);
    const head = repo.must("rev-parse", "HEAD");
    const r = repo.git("merge", "--no-edit", "other");
    ok(r.status !== 0, `merge went through: ${r.output}`);
    eq(repo.must("rev-parse", "HEAD"), head, "HEAD:");
    eq(await repo.calls(), "test\n", "what the hook ran:");
  });
  await withHookRepo(0, async (repo) => {
    await diverged(repo);
    repo.must("merge", "-q", "--no-edit", "other");
    eq(repo.must("log", "--format=%p", "-1").split(" ").length, 2, "parents of the merge commit:");
    eq(await repo.calls(), "test\n", "what the hook ran:");
  });
  // Work in progress on disk that the merge would not carry.
  await withHookRepo(0, async (repo) => {
    await diverged(repo);
    await repo.write("a.js", "unstaged\n");
    ok(repo.git("merge", "--no-edit", "other").status !== 0, "unstaged work must stop the merge commit");
    eq(await repo.calls(), "", "stopped before running anything:");
  });
});

// Runs a copy of the real runner over a small package of its own, through the real
// pnpm, as the gate does.
const PASSES = "";
async function runGate({ scripts = {}, suites = {}, env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "boundary-gate-"));
  try {
    await mkdir(join(dir, "scripts"));
    await copyFile(join(ROOT, "scripts/run-tests.js"), join(dir, "scripts/run-tests.js"));
    for (const [file, text] of Object.entries({ "test-shopify-boundary.js": PASSES, ...suites })) {
      await writeFile(join(dir, "scripts", file), text);
    }
    const allScripts = { "test:shopify-boundary": "node scripts/test-shopify-boundary.js", ...scripts };
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "gate-fixture", private: true, type: "module", scripts: allScripts }));
    const started = Date.now();
    const r = spawnSync(process.execPath, ["scripts/run-tests.js"], {
      cwd: dir,
      env: { ...process.env, TEST_SUITE_TIMEOUT_MS: "60000", ...env },
      encoding: "utf8",
    });
    return { status: r.status, output: r.stdout + r.stderr, ms: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await t("SHOP-06: the runner exits non-zero when a suite fails, this one included", async () => {
  const r = await runGate({
    scripts: { "test:other": "node scripts/test-other.js" },
    suites: { "test-shopify-boundary.js": "console.log('BOUNDARY-OUTPUT');\nprocess.exit(1);\n", "test-other.js": PASSES },
  });
  eq(r.status, 1, `exit code, output:\n${r.output}\n`);
  ok(r.output.includes("1 of 2 suites passed"), r.output);
  ok(r.output.includes("Failed: test:shopify-boundary\n"), r.output);
  ok(r.output.includes("BOUNDARY-OUTPUT"), "shows the failed suite's output");
});

await t("SHOP-06: the runner refuses a weakened suite command, and a suite file no gated script runs", async () => {
  const suites = { "test-zz.js": "process.exit(1);\n" };
  const refused = async (scripts, message) => {
    const r = await runGate({ scripts, suites });
    eq(r.status, 1, `${JSON.stringify(scripts)} exit code, output:\n${r.output}\n`);
    ok(r.output.includes(message), r.output);
    ok(!r.output.includes("Running"), "refused before any suite ran");
  };
  const BAD_COMMAND = "must be: node scripts/<file>.js";
  await refused({ "test:zz": "node scripts/test-zz.js || true" }, BAD_COMMAND);
  await refused({ "test:zz": "FOO=1 node scripts/test-zz.js" }, BAD_COMMAND);
  await refused({ "test:zz": "true" }, BAD_COMMAND);
  const NOT_RUN = "scripts/test-zz.js has no test:* script";
  await refused({ "zz:helper": "node scripts/test-zz.js" }, NOT_RUN);
  await refused({ "test:perf": "node scripts/test-zz.js" }, NOT_RUN);
  await refused({}, NOT_RUN);
});

// A suite that starts a process in its own group, which holds the suite's output
// pipes after everything the runner can kill has gone. It writes down the pid so
// the test can clean up. The sleep outlasts the limits asserted below.
const HOLDER_SECONDS = 30;
const HOLDER = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn("sleep", ["${HOLDER_SECONDS}"], { detached: true, stdio: "inherit" });
child.unref();
writeFileSync(process.env.HOLDER_PID_FILE, String(child.pid));
`;
async function runGateWithHolder(suiteBody, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "boundary-holder-"));
  const pidFile = join(dir, "pid");
  try {
    return await runGate({
      scripts: { "test:holder": "node scripts/test-holder.js" },
      suites: { "test-holder.js": HOLDER + suiteBody },
      env: { HOLDER_PID_FILE: pidFile, ...env },
    });
  } finally {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => 0));
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  }
}

await t("SHOP-06: a suite that exits leaving a detached child on its output does not hold up the runner", async () => {
  const r = await runGateWithHolder("");
  eq(r.status, 0, `exit code, output:\n${r.output}\n`);
  ok(r.output.includes("2 of 2 suites passed"), r.output);
  ok(r.ms < (HOLDER_SECONDS - 10) * 1000, `took ${r.ms}ms, so it waited for the child`);
});

await t("SHOP-06: a stuck suite is stopped at its limit, even with a detached child on its output", async () => {
  const r = await runGateWithHolder("setInterval(() => {}, 1000);\n", { TEST_SUITE_TIMEOUT_MS: "2000" });
  eq(r.status, 1, `exit code, output:\n${r.output}\n`);
  ok(r.output.includes("stopped after 2.0s without finishing"), r.output);
  ok(r.ms < (HOLDER_SECONDS - 10) * 1000, `took ${r.ms}ms, so it waited for the child`);
});

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
await rm(join(ROOT, ".test-shopify-boundary.db"), { force: true });
process.exit(fail ? 1 : 0);
