// Uploaded theme packages (Phase 5 line 1, docs/plans/phase-5.md "Line 1").
//   pnpm test:theme-packages
// The refusal scanner (every refusal, plus obfuscations: case, tabs and
// zero-width characters, named/decimal/hex entities, double encoding, event
// handler keys, __proto__, depth and node caps), the package checks (unknown
// keys, tokens, surfaces and role-colour contrast, templates, home sections, no
// pictures), every evil fixture, the routes as every caller (the role matrix:
// storefront.read for every role, themes.manage for owner and admin only, 401
// signed out and for another store's owner), 413 on a big or lying
// Content-Length, duplicates, the 30-package cap, archive refused while live
// or in the draft, the kill switch ff_theme-packages, audit rows, the refusal
// log line (codes and size, never content), support reads with a canary from
// store B, the nav item and Edge safety. fetch() is blocked; every database is
// a throwaway file: database.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-theme-packages-default.db";
process.env.PLATFORM_SECRET = "test-theme-packages-platform-secret";
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

const { roleAllows } = await import("../lib/platform/authz.js");
const G = await import("../lib/themes/package-guard.js");
const V = await import("../lib/themes/package-validate.js");
const F = await import("../lib/themes/package-format.js");
const FLAGS = await import("../lib/platform/flags.js");
const { listAudit } = await import("../lib/platform/audit.js");
const { NAV } = await import("../lib/admin/nav.js");
const { KILL_FLAG } = await import("../lib/themes/packages.js");

const fixture = async (name) => readFile(join(ROOT, "scripts/fixtures/themes", `${name}.theme.json`), "utf8");
const AURORA_TEXT = await fixture("aurora");
const aurora = () => JSON.parse(AURORA_TEXT);
const codes = (text) => (V.parseThemePackage(text).issues ?? []).map((i) => i.code);
const withPatch = (fn) => {
  const p = aurora();
  fn(p);
  return JSON.stringify(p);
};
// a string placed in the hero subtitle (a plain text setting)
const inSubtitle = (s) => withPatch((p) => (p.templates.home.sections[0].settings.subtitle = s));
const refusedAs = (text, code, label) => {
  const r = V.parseThemePackage(text);
  ok(r.issues, `${label}: refused`);
  ok(r.issues.some((i) => i.code === code), `${label}: ${code} in ${JSON.stringify(r.issues)}`);
  return r.issues;
};

// --- the scanner -----------------------------------------------------------------
await t("aurora passes; every evil fixture is refused with its own code and place", async () => {
  const r = V.parseThemePackage(AURORA_TEXT);
  ok(r.pkg, JSON.stringify(r.issues));
  eq(r.pkg.id, "aurora", "id:");
  const want = {
    "evil-deep": ["depth", ""],
    "evil-external": ["external", "templates.home.sections[0].settings.subtitle"],
    "evil-iframe": ["tag", "templates.home.sections[1].settings.html"],
    "evil-import": ["import", "description"],
    "evil-javascript-entity": ["javascript", "templates.home.sections[0].settings.primary.link.href"],
    "evil-onclick-key": ["handler", "templates.home.sections[0].settings.onClick"],
    "evil-proto": ["data-only", "tokens.__proto__"],
    "evil-script": ["script", "templates.home.sections[1].settings.html"],
    "evil-url": ["url", "styles[0].set.color"],
  };
  for (const [name, [code, path]] of Object.entries(want)) {
    const issues = V.parseThemePackage(await fixture(name)).issues;
    ok(issues?.some((i) => i.code === code && i.path === path), `${name}: ${JSON.stringify(issues)}`);
    ok(issues.every((i) => i.message && !/undefined/.test(i.message)), `${name} words`);
  }
});

await t("refusals: each pattern in plain words, with its place", () => {
  const cases = [
    ["<script>alert(1)</script>", "script", "Themes can't contain scripts."],
    ['<p onclick="x()">Hi</p>', "handler", "Themes can't contain event handlers like onclick."],
    ["<img src=x onerror=alert(1)>", "handler", null],
    ["javascript:alert(1)", "javascript", "Themes can't contain javascript: links."],
    ["vbscript:msgbox", "javascript", null],
    ["data:text/html;base64,PHNjcmlwdD4=", "javascript", null],
    ["@import 'x.css'", "import", "Themes can't import other files."],
    ["url(/x.png)", "url", "Themes can't load files with url(…)."],
    ["width: expression(alert(1))", "css-code", null],
    ["-moz-binding: x", "css-code", null],
    ["behavior: x.htc", "css-code", null],
    ["https://evil.example/x", "external", "Themes can't load anything from other websites."],
    ["http://evil.example/x", "external", null],
    ["//evil.example/x", "external", null],
  ];
  for (const tag of ["style", "iframe", "object", "embed", "link", "meta", "base", "svg"]) cases.push([`<${tag}>`, "tag", "Themes can't contain HTML tags like <iframe>."]);
  for (const [s, code, words] of cases) {
    const issues = refusedAs(inSubtitle(s), code, JSON.stringify(s));
    const hit = issues.find((i) => i.code === code);
    eq(hit.path, "templates.home.sections[0].settings.subtitle", `${s} place:`);
    if (words) eq(hit.message, words, `${s} words:`);
    eq(G.issueText(hit), `${hit.message} (at templates.home.sections[0].settings.subtitle)`, "issue text:");
  }
});

await t("obfuscations: case, tabs, newlines, zero-width, controls, entities (named, decimal, hex, no semicolon, double), fullwidth", () => {
  const cases = [
    ["<ScRiPt>", "script"],
    ["< script>", "script"],
    ["<scr\u200bipt>", "script"],
    ["<scr\u0000ipt>", "script"],
    ["&lt;script&gt;", "script"],
    ["&#60;script", "script"],
    ["&#x3C;SCRIPT", "script"],
    ["java\tscript:alert(1)", "javascript"],
    ["java\nscript:alert(1)", "javascript"],
    ["JaVaScRiPt:alert(1)", "javascript"],
    ["&#106;avascript:alert(1)", "javascript"],
    ["&#x6A;avascript&colon;alert(1)", "javascript"],
    ["&#106avascript:alert(1)", "javascript"],
    ["&amp;#106;avascript:alert(1)", "javascript"],
    ["java\u00adscript:x", "javascript"],
    ["ｊａｖａｓｃｒｉｐｔ:x", "javascript"],
    ["<p\nonmouseover=x>", "handler"],
    ["<p/ONCLICK=x>", "handler"],
    ["@IM\u200dPORT x", "import"],
    ["URL (x)", "url"],
    ["&lt;iframe src=/x&gt;", "tag"],
    ["h&#116;tps://evil.example", "external"],
  ];
  for (const [s, code] of cases) refusedAs(inSubtitle(s), code, JSON.stringify(s));
});

await t("keys: onClick / ONLOAD keys, every data-only key, __proto__, constructor; a refused key is reported at its own place", () => {
  for (const k of ["onClick", "ONLOAD", "onmouseover"]) {
    const issues = refusedAs(withPatch((p) => (p.surfaces.header[k] = "x")), "handler", k);
    ok(issues.some((i) => i.path === `surfaces.header.${k}`), `${k} place: ${JSON.stringify(issues)}`);
  }
  for (const k of F.FORBIDDEN_KEYS) {
    const text = AURORA_TEXT.replace('"tokens": {', `"tokens": { "${k}": 1,`);
    const issues = refusedAs(text, "data-only", k);
    eq(issues.find((i) => i.code === "data-only").message, `Themes are data only: remove "${k}".`, `${k} words:`);
  }
  // a raw __proto__ key in the file text (JSON.parse keeps it as an own key)
  refusedAs(AURORA_TEXT.replace('"tokens": {', '"tokens": { "__proto__": { "polluted": true },'), "data-only", "raw __proto__");
  eq({}.polluted, undefined, "nothing was polluted:");
  // a declared registry setting named like a data-only key (rich_text's html) is allowed; its value is still scanned
  ok(V.parseThemePackage(AURORA_TEXT).pkg, "aurora's rich_text html");
  refusedAs(withPatch((p) => (p.templates.home.sections[1].settings.html = "<p>x</p><SCRIPT>")), "script", "html value");
  // but the same key elsewhere is refused
  refusedAs(withPatch((p) => (p.templates.home.sections[0].settings.html = "<p>x</p>")), "data-only", "html on a hero");
});

await t("links: only a page on the store, as a founder's Publish allows (outside, protocol-relative, backslash and data: links refused)", () => {
  const link = (href) => withPatch((p) => (p.templates.home.sections[0].settings.primary.link = { type: "url", href }));
  for (const href of ["https://evil.com", "//evil.com", "/\\evil.com", "\\\\evil.com", "data:text/plain,x"]) {
    const issues = V.parseThemePackage(link(href)).issues;
    ok(issues?.some((i) => i.code === "external" || i.code === "javascript"), `${href}: ${JSON.stringify(issues)}`);
  }
  ok(V.parseThemePackage(link("/collections/new")).pkg, "a store page is fine");
  refusedAs(withPatch((p) => (p.templates.home.sections[0].settings.primary.label = "https://example.com")), "external", "a label");
  refusedAs(withPatch((p) => (p.templates.home.sections[0].settings.primary.link = { type: "url", href: "javascript:alert(1)" })), "javascript", "a javascript: link");
});

await t("review fixes: long zero-padded entities, CSS escapes, inline styles, pictures and srcdoc in rich_text html are refused", () => {
  const html = (s) => withPatch((p) => (p.templates.home.sections[1].settings.html = s));
  refusedAs(html('<p><a href="&#00000000106;avascript:alert(1)">x</a></p>'), "javascript", "decimal zeros in html");
  refusedAs(inSubtitle("&#x000000006a;avascript:x"), "javascript", "hex zeros");
  refusedAs(withPatch((p) => (p.templates.home.sections[0].settings.primary.link = { type: "url", href: "java&#0000000115;cript:x" })), "javascript", "hero link");
  refusedAs(html('<p style="position:fixed">x</p>'), "inline-style", "style=");
  refusedAs(html("<p>\\75 rl(/x.png)</p>"), "url", "CSS-escaped url(");
  refusedAs(html('<p srcdoc="x">x</p>'), "assets", "srcdoc=");
  refusedAs(html('<img src="/x.png">'), "assets", "<img>");
});

await t("stored home sections are the registry's sanitised settings", () => {
  const { pkg } = V.parseThemePackage(AURORA_TEXT);
  ok(pkg.templates.home.sections.every((s) => s.settings && typeof s.settings === "object"), "settings kept");
  eq(pkg.templates.home.sections[1].settings.html, "<p>Small batches, honest materials, fast delivery.</p>", "html sanitised as the registry writes it:");
});

await t("depth over 12 and more than 5,000 values are refused; at most 20 issues", () => {
  let deep = "x";
  for (let i = 0; i < 14; i++) deep = { a: deep };
  const d = refusedAs(withPatch((p) => (p.templates.home.sections[0].settings.extra = deep)), "depth", "deep");
  eq(d[0].message, F.MESSAGES.tooDeep, "depth words:");
  const many = refusedAs(withPatch((p) => (p.templates.home.sections[0].settings.extra = Array.from({ length: 5100 }, () => 1))), "nodes", "many");
  eq(many[0].message, F.MESSAGES.tooManyNodes, "nodes words:");
  const lots = V.parseThemePackage(withPatch((p) => (p.templates.home.sections[0].settings.list = Array.from({ length: 40 }, () => "<script>"))));
  eq(lots.issues.length, F.LIMITS.issues, "capped at 20:");
});

await t("not JSON, not an object, the wrong format and over 256 KB are refused in plain words", () => {
  eq(V.parseThemePackage("{nope").issues[0].message, F.MESSAGES.notJson, "not json:");
  eq(V.parseThemePackage("[]").issues[0].message, F.MESSAGES.wrongFormat, "array:");
  eq(V.parseThemePackage(withPatch((p) => (p.format = "storeasy-theme/9"))).issues[0].message, F.MESSAGES.wrongFormat, "format:");
  const big = V.parseThemePackage(withPatch((p) => (p.description = "x".repeat(F.LIMITS.bytes))));
  eq(big.status, 413, "413:");
  eq(big.issues[0].message, F.MESSAGES.tooBig, "too big words:");
});

await t("shape: unknown keys anywhere, id, version, base, tokens, surfaces contrast, templates, styles, role-colour contrast, no pictures", () => {
  refusedAs(withPatch((p) => (p.extra = 1)), "unknown-key", "top");
  refusedAs(withPatch((p) => (p.author.email = "a@b.c")), "unknown-key", "author");
  refusedAs(withPatch((p) => (p.tokens.glow = 1)), "unknown-key", "tokens");
  refusedAs(withPatch((p) => (p.id = "Aurora!")), "invalid", "id");
  refusedAs(withPatch((p) => (p.version = "1.2")), "invalid", "version");
  refusedAs(withPatch((p) => (p.base = "neon")), "invalid", "base");
  refusedAs(withPatch((p) => (p.tokens.accent = "red")), "invalid", "accent");
  refusedAs(withPatch((p) => (p.tokens.radius = "huge")), "invalid", "radius");
  refusedAs(withPatch((p) => (p.surfaces.hero.fg = "#1e1b4c")), "contrast", "hero fg on hero bg");
  refusedAs(withPatch((p) => (p.surfaces.header.bg = "url(x)")), "url", "surface url");
  refusedAs(withPatch((p) => (p.templates.pdp = "fancy")), "invalid", "pdp");
  refusedAs(withPatch((p) => (p.templates.home.sections.push({ kind: "product_main", settings: {} }))), "invalid", "product_main");
  refusedAs(withPatch((p) => (p.templates.home.sections[0].settings.title = 7)), "section", "registry check");
  refusedAs(withPatch((p) => (p.templates.home.sections[0].settings.image = { media: "med_0123456789abcdef" })), "assets", "a med_ picture");
  refusedAs(withPatch((p) => p.styles.push({ part: "buy-box", set: { color: "#000" } })), "style", "a protected part");
  refusedAs(withPatch((p) => p.styles.push({ part: "hero", set: { display: "none" } })), "style", "display");
  refusedAs(withPatch((p) => (p.styles = Array.from({ length: 61 }, () => ({ part: "hero", set: { gap: "1rem" } })))), "style", "61 rules");
  // role colours resolved against the package's own surfaces: hero-fg on a near-identical hero bg
  const issues = refusedAs(withPatch((p) => p.styles.push({ part: "hero", set: { color: "role:hero-fg", "background-color": "#fefefe" } })), "contrast", "role contrast");
  ok(issues.some((i) => i.path === `styles[${aurora().styles.length}].set.color`), "its place");
  ok(V.parseThemePackage(withPatch((p) => p.styles.push({ part: "hero", set: { color: "role:hero-fg", "background-color": "role:hero" } }))).pkg, "hero-fg on hero reads");
});

await t("the stored package is normalised: known keys only, in the format's order", () => {
  const { pkg } = V.parseThemePackage(AURORA_TEXT);
  eq(Object.keys(pkg).join(","), F.TOP_KEYS.join(","), "keys:");
  eq(pkg.styles.length, aurora().styles.length, "styles kept:");
  eq(pkg.templates.home.sections.length, 2, "sections kept:");
});

// --- the role matrix and routes -------------------------------------------------------
await t("roles: themes.manage for owner and admin only; storefront.read for every role", () => {
  eq(["owner", "admin", "staff", "support"].filter((r) => roleAllows(r, "themes.manage")).join(","), "owner,admin", "themes.manage:");
  for (const r of ["owner", "admin", "staff", "support"]) ok(roleAllows(r, "storefront.read"), `${r} storefront.read`);
});

const store = await H.makeRoleStore({ name: "themes" });
const { a, b, call } = store;
const hostB = b.tenant.domains[0];
const MERCHANT = ["owner", "admin", "staff", "support"];
const OPS = ["operator-support", "operator-support-entry"];
const auditRows = async (tenantId = a.id) => listAudit({ tenantId, limit: 200 });
const upload = (caller, pkg, opts = {}) => call(caller, "themes", "POST", { body: pkg, ...opts });
const B_CANARY = "cnybthemepkg0";
let auroraId = null;

await t("signed out and another store's owner: 401 on every themes route of store A", async () => {
  for (const caller of ["signed-out", "owner-b"]) {
    eq((await call(caller, "themes", "GET")).status, 401, `${caller} GET:`);
    eq((await upload(caller, aurora())).status, 401, `${caller} POST:`);
    eq((await call(caller, "themes/[id]", "GET", { params: { id: "thm_0000000000000000" } })).status, 401, `${caller} GET [id]:`);
    eq((await call(caller, "themes/[id]", "GET", { params: { id: "thm_0000000000000000" }, query: "download=1" })).status, 401, `${caller} GET [id] ?download:`);
    eq((await call(caller, "themes/[id]", "POST", { params: { id: "thm_0000000000000000" }, body: { archive: true } })).status, 401, `${caller} POST [id]:`);
  }
});

await t("empty store: every role reads the built-in looks and no uploaded themes", async () => {
  for (const caller of [...MERCHANT, ...OPS]) {
    const r = await call(caller, "themes", "GET");
    eq(r.status, 200, `${caller}:`);
    eq(r.body.builtins.map((k) => k.id).join(","), "pulse,glow", `${caller} builtins:`);
    eq(r.body.packages.length, 0, `${caller} packages:`);
  }
});

await t("upload: staff, support and operator support get 403 and nothing is stored", async () => {
  for (const caller of ["staff", "support", ...OPS]) eq((await upload(caller, aurora())).status, 403, `${caller}:`);
  eq((await call("owner", "themes", "GET")).body.packages.length, 0, "none:");
});

await t("upload: the owner uploads Aurora; the answer summarises base, templates, sections and rules; audit themes.upload {slug, version, sha256}", async () => {
  const r = await call("owner", "themes", "POST", { body: aurora() });
  eq(r.status, 200, r.text.slice(0, 300));
  const p = r.body.package;
  auroraId = p.id;
  ok(F.PACKAGE_ID_RE.test(p.id), `id ${p.id}`);
  eq(`${p.name} ${p.version} ${p.base} ${p.status}`, "Aurora 1.2.0 pulse installed", "row:");
  eq(JSON.stringify(p.summary), JSON.stringify({ base: "pulse", templates: { pdp: "editorial", collection: "sidebar", header: "centered", footer: "minimal" }, sections: 2, rules: aurora().styles.length }), "summary:");
  eq(p.swatch.join(","), "#4f46e5,#f8fafc,#0f172a", "swatch:");
  ok(p.uploadedByName && !/merchant:/.test(p.uploadedByName), `uploaded by: ${p.uploadedByName}`);
  const row = (await auditRows()).find((x) => x.action === "themes.upload");
  ok(row, "an audit row");
  const diff = JSON.parse(row.diff);
  eq(`${diff.slug} ${diff.version}`, "aurora 1.2.0", "diff:");
  ok(/^[0-9a-f]{64}$/.test(diff.sha256), "sha256");
  eq(row.resource, `theme:${p.id}`, "resource:");
});

await t("upload: the same slug and version is 409 in plain words; a new version is a new row", async () => {
  const dup = await upload("admin", aurora());
  eq(dup.status, 409, "dup:");
  eq(dup.body.error, "Aurora 1.2.0 is already installed. Raise the version to upload a change.", "words:");
  const next = await upload("admin", { ...aurora(), version: "1.3.0" });
  eq(next.status, 200, next.text.slice(0, 200));
  ok(next.body.package.id !== auroraId, "a new row");
  eq((await call("owner", "themes", "GET")).body.packages.length, 2, "two:");
});

await t("upload: an evil package is 422 with every issue and its place; nothing stored; the log has codes and size, never content", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  let r;
  try {
    r = await call("owner", "themes", "POST", { body: JSON.parse(await fixture("evil-script")) });
  } finally {
    console.log = orig;
  }
  eq(r.status, 422, r.text.slice(0, 200));
  eq(r.body.code, "REFUSED", "code:");
  ok(r.body.issues.some((i) => i.code === "script" && i.path === "templates.home.sections[1].settings.html" && i.text.endsWith("(at templates.home.sections[1].settings.html)")), JSON.stringify(r.body.issues));
  const log = lines.find((l) => l.includes("theme_upload_refused"));
  ok(log, `a log line: ${lines.join(" | ").slice(0, 300)}`);
  const ev = JSON.parse(log);
  eq(ev.codes.join(","), "script", "codes:");
  ok(Number.isInteger(ev.size) && ev.size > 0, "size");
  ok(!/alert|<script/i.test(log), "no content in the log");
  eq((await call("owner", "themes", "GET")).body.packages.length, 2, "still two:");
  const notJson = await call("owner", "themes", "POST", { body: "{nope" });
  eq(notJson.status, 422, "a JSON string body is not a package:");
});

await t("413: a Content-Length over 256 KB, and a lying small Content-Length on a big body, both stop", async () => {
  const big = JSON.stringify({ ...aurora(), description: "x".repeat(F.LIMITS.bytes + 10) });
  const r1 = await call("owner", "themes", "POST", { body: JSON.parse(big), headers: { "content-length": String(F.LIMITS.bytes + 1) } });
  eq(r1.status, 413, "big header:");
  eq(r1.body.error, F.MESSAGES.tooBig, "words:");
  const r2 = await call("owner", "themes", "POST", { body: JSON.parse(big), headers: { "content-length": "100" } });
  eq(r2.status, 413, "lying header:");
  const { bodyTextCapped } = await import("../lib/themes/packages.js");
  // no header at all, streamed in pieces: stops at 256 KB + 1
  let pulled = 0;
  const stream = new ReadableStream({
    pull(c) {
      pulled += 64 * 1024;
      c.enqueue(new Uint8Array(64 * 1024).fill(120));
      if (pulled > 10 * 1024 * 1024) c.close();
    },
  });
  let status = 0;
  try {
    await bodyTextCapped({ headers: new Headers(), body: stream });
  } catch (e) {
    status = e.status;
  }
  eq(status, 413, "no header:");
  ok(pulled <= F.LIMITS.bytes + 2 * 64 * 1024, `stopped early (${pulled} bytes pulled)`);
});

await t("detail: every role reads a package and its content; Download returns the stored normalised JSON; unknown and malformed ids are 404", async () => {
  for (const caller of [...MERCHANT, ...OPS]) {
    const r = await call(caller, "themes/[id]", "GET", { params: { id: auroraId } });
    eq(r.status, 200, `${caller}:`);
    eq(r.body.content.id, "aurora", `${caller} content:`);
    const d = await call(caller, "themes/[id]", "GET", { params: { id: auroraId }, query: "download=1" });
    eq(d.status, 200, `${caller} download:`);
    ok(/attachment; filename="aurora-1\.2\.0\.theme\.json"/.test(d.headers.get("content-disposition")), `${caller} filename`);
    eq(d.text, JSON.stringify(V.parseThemePackage(AURORA_TEXT).pkg), `${caller} normalised file:`);
  }
  eq((await call("owner", "themes/[id]", "GET", { params: { id: "thm_0000000000000000" } })).status, 404, "unknown:");
  eq((await call("owner", "themes/[id]", "GET", { params: { id: "../etc" } })).status, 404, "malformed:");
});

// the design document's draft and live version naming a package
async function setDesign({ draft = null, live = null }) {
  await a.run(async () => {
    const { libsql } = await import("../lib/db.js");
    const body = (pkg) => JSON.stringify({ schema: 1, type: "design", meta: {}, settings: { theme: { kit: "pulse", version: 1, ...(pkg ? { package: pkg } : {}) } }, sections: [] });
    const at = new Date().toISOString();
    await libsql.execute({ sql: "DELETE FROM documents WHERE id = 'doc_design'", args: [] });
    let ver = null;
    if (live) {
      ver = `ver_${Math.random().toString(16).slice(2, 10).padEnd(16, "0")}`;
      await libsql.execute({ sql: "INSERT INTO document_versions (id, document_id, kind, body, body_hash, schema_version, created_at) VALUES (?, 'doc_design', 'published', ?, 'h', 1, ?)", args: [ver, body(live), at] });
    }
    await libsql.execute({ sql: "INSERT INTO documents (id, type, label, draft, draft_hash, schema_version, published_version_id, created_at, updated_at) VALUES ('doc_design', 'design', 'Design', ?, 'h', 1, ?, ?, ?)", args: [body(draft), ver, at, at] });
  });
}

await t("archive: staff, support and operator support get 403; a live or drafted package is 409; otherwise archived (kept, listed under Archived), audit themes.archive", async () => {
  for (const caller of ["staff", "support", ...OPS]) eq((await call(caller, "themes/[id]", "POST", { params: { id: auroraId }, body: { archive: true } })).status, 403, `${caller}:`);
  eq((await call("owner", "themes/[id]", "POST", { params: { id: auroraId }, body: {} })).status, 400, "no action:");
  await setDesign({ draft: auroraId });
  const inDraft = await call("owner", "themes/[id]", "POST", { params: { id: auroraId }, body: { archive: true } });
  eq(inDraft.status, 409, "draft:");
  ok(/design draft/.test(inDraft.body.error), inDraft.body.error);
  eq((await call("owner", "themes", "GET")).body.packages.find((p) => p.id === auroraId).inUse, "draft", "listed as in the draft:");
  await setDesign({ live: auroraId });
  const live = await call("admin", "themes/[id]", "POST", { params: { id: auroraId }, body: { archive: true } });
  eq(live.status, 409, "live:");
  ok(/live on your store/.test(live.body.error), live.body.error);
  await setDesign({});
  const r = await call("admin", "themes/[id]", "POST", { params: { id: auroraId }, body: { archive: true } });
  eq(r.status, 200, r.text.slice(0, 200));
  eq(r.body.package.status, "archived", "status:");
  eq((await call("admin", "themes/[id]", "POST", { params: { id: auroraId }, body: { archive: true } })).status, 409, "twice:");
  ok(!(await call("support", "themes", "GET")).body.packages.some((p) => p.id === auroraId), "not installed");
  const arch = await call("support", "themes", "GET", { query: "status=archived" });
  ok(arch.body.archived && arch.body.packages.some((p) => p.id === auroraId && p.archivedByName), "under Archived");
  eq((await call("support", "themes/[id]", "GET", { params: { id: auroraId } })).status, 200, "its page still opens:");
  const row = (await auditRows()).find((x) => x.action === "themes.archive");
  ok(row && row.resource === `theme:${auroraId}`, "audit row");
  // archived rows still count for slug + version, and the refusal says so
  const again = await upload("owner", aurora());
  eq(again.status, 409, "archived 1.2.0 can't be uploaded again:");
  eq(again.body.error, "Aurora 1.2.0 was archived. Raise the version to upload it again.", "words:");
});

await t("the kill switch ff_theme-packages refuses uploads for store A only", async () => {
  await FLAGS.setFlag({ key: KILL_FLAG, description: "Uploaded themes", default_on: true, create: true, actor: "operator" });
  await FLAGS.setFlagOverride({ key: KILL_FLAG, tenant: a.id, on: false, actor: "operator" });
  FLAGS.__resetFlagCache();
  try {
    const r = await upload("owner", { ...aurora(), version: "9.0.0" });
    eq(r.status, 409, "refused:");
    eq(r.body.code, "TURNED_OFF_BY_STOREASY", "code:");
    eq((await call("support", "themes", "GET")).status, 200, "reads still work:");
    eq((await upload("owner-b", { ...aurora(), id: "cnyb-theme", name: B_CANARY, description: B_CANARY }, { host: hostB })).status, 200, "store B uploads:");
  } finally {
    await FLAGS.setFlagOverride({ key: KILL_FLAG, tenant: a.id, on: true, actor: "operator" });
    FLAGS.__resetFlagCache();
  }
  eq((await upload("owner", { ...aurora(), version: "9.0.0" })).status, 200, "allowed again:");
});

await t("at most 30 installed packages per store", async () => {
  const have = (await call("owner", "themes", "GET")).body.packages.length;
  for (let i = have; i < F.LIMITS.installed; i++) eq((await upload("owner", { ...aurora(), id: `bulk-${i}` })).status, 200, `upload ${i}:`);
  const r = await upload("owner", { ...aurora(), id: "one-too-many" });
  eq(r.status, 409, "31st:");
  // two at once at the cap: the guarded insert lets neither past 30
  const both = await Promise.all([upload("owner", { ...aurora(), id: "race-a" }), upload("admin", { ...aurora(), id: "race-b" })]);
  eq(both.map((x) => x.status).join(","), "409,409", "both refused at the cap:");
  eq((await call("owner", "themes", "GET")).body.packages.length, F.LIMITS.installed, "still 30:");
  eq(r.body.code, "TOO_MANY", "code:");
  ok(r.body.error.includes("30"), r.body.error);
});

await t("support (least trusted) and operator support: reads carry only listed keys and no store B canary; B's package is not found on A; no write is offered", async () => {
  const bId = (await call("owner-b", "themes", "GET", { host: hostB })).body.packages[0].id;
  for (const caller of ["support", ...OPS]) {
    const list = await call(caller, "themes", "GET");
    eq(Object.keys(list.body).sort().join(","), "archived,builtins,ok,packages,state", `${caller} keys:`);
    const want = "author,base,baseLabel,description,id,inUse,name,sizeBytes,slug,status,summary,swatch,uploadedAt,uploadedByName,version,archivedAt,archivedByName".split(",").sort().join(",");
    for (const p of list.body.packages) eq(Object.keys(p).sort().join(","), want, `${caller} package keys:`);
    ok(!list.text.includes(B_CANARY), `${caller}: no B canary in the list`);
    const detail = await call(caller, "themes/[id]", "GET", { params: { id: (await call("owner", "themes", "GET")).body.packages[0].id } });
    eq(Object.keys(detail.body).sort().join(","), "content,ok,package,tokens", `${caller} detail keys:`);
    ok(!detail.text.includes(B_CANARY), `${caller}: no B canary in a detail`);
    const other = await call(caller, "themes/[id]", "GET", { params: { id: bId } });
    eq(other.status, 404, `${caller} B's id on A:`);
    ok(!other.text.includes(B_CANARY), `${caller}: no canary in the 404`);
    eq((await call(caller, "themes/[id]", "GET", { params: { id: bId }, query: "download=1" })).status, 404, `${caller} B's file on A:`);
    ok(!roleAllows(caller === "support" ? "support" : "support", "themes.manage"), "no themes.manage");
  }
  // the owner of A does not see B's theme either; B's owner sees only B's
  ok(!(await call("owner", "themes", "GET")).text.includes(B_CANARY), "A's owner");
  eq((await call("owner-b", "themes/[id]", "GET", { host: hostB, params: { id: auroraId } })).status, 404, "A's id on B:");
  eq((await call("owner-b", "themes/[id]", "POST", { host: hostB, params: { id: auroraId }, body: { archive: true } })).status, 404, "A's id on B (archive):");
});

await t("pages: the upload and archive controls are hidden from roles without themes.manage", async () => {
  const lib = await readFile(join(ROOT, "components/admin/themes/UploadThemeDialog.js"), "utf8");
  const arc = await readFile(join(ROOT, "components/admin/themes/ArchiveThemeDialog.js"), "utf8");
  for (const src of [lib, arc]) ok(/<RoleGate role=\{role\} action="themes\.manage" reason=\{NO_MANAGE\} mode="hide">/.test(src), "RoleGate hide on themes.manage");
});

await t("nav: Themes is in the Store group on storefront.read; its page rows exist", async () => {
  const item = NAV.find((g) => g.label === "Store").items.find((i) => i.id === "themes");
  ok(item, "a Themes item");
  eq(`${item.href} ${item.action}`, "/admin/themes storefront.read", "item:");
  const { ADMIN_PAGES } = await import("./support/admin-pages.js");
  ok(ADMIN_PAGES.some((p) => p.page === "themes") && ADMIN_PAGES.some((p) => p.page === "themes/[id]"), "admin-pages rows");
});

await t("edge safety: the package format, guard, validator and styles import no node: module", async () => {
  for (const f of ["lib/themes/package-format.js", "lib/themes/package-guard.js", "lib/themes/package-validate.js", "lib/themes/styles.js"]) {
    ok(!/from\s+["']node:/.test(await readFile(join(ROOT, f), "utf8")), f);
  }
});

await t("no network: nothing reached fetch()", () => eq(network.length, 0, network.join(", ")));

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
