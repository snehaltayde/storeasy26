// Content service & brand suite (Session 35 / BE08 + MC10): HTML sanitizer
// abuse matrix, draft-revision CAS conflicts (both versions preserved),
// versioned schema stamping, brand token validation (WCAG contrast gate,
// shade ladder, CSS emission) and the content resolution order.
//   pnpm test:content
import { rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-content-default.db";
process.env.PLATFORM_DB_URL = "file:.test-content-platform.db";
process.env.PLATFORM_SECRET = "test-platform-secret";

const here = dirname(fileURLToPath(import.meta.url));
const dbs = [".test-content-default.db", ".test-content-platform.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const { libsql, db } = await import("../lib/db.js");
const S = await import("../lib/cms/store.js");
const { BLOCK_SCHEMAS, upgradeBlock } = await import("../lib/cms/schemas.js");
const { sanitizeHtml } = await import("../lib/sanitize.js");
const B = await import("../lib/brand.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
await libsql.executeMultiple(schema);
await runMigrations(libsql, await loadMigrations("tenant")); // fixture rule: ledger on raw schema

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
const eq = (a, b, msg = "") => {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const includes = (s, sub, msg = "") => {
  if (!String(s).includes(sub)) throw new Error(`${msg} expected to contain ${JSON.stringify(sub)}, got ${JSON.stringify(s)}`);
};
const excludes = (s, sub, msg = "") => {
  if (String(s).includes(sub)) throw new Error(`${msg} expected NOT to contain ${JSON.stringify(sub)}, got ${JSON.stringify(s)}`);
};

// ---------- sanitizer ----------
console.log("— HTML sanitizer (BE34 residual closed)");

await t("script/style/iframe are dropped WITH their content", async () => {
  const out = sanitizeHtml('<p>ok</p><script>alert(1)</script><style>.x{}</style><iframe src="https://evil"></iframe><p>after</p>');
  eq(out, "<p>ok</p><p>after</p>");
});

await t("event handlers and unknown attributes are stripped, allowed attrs kept", async () => {
  const out = sanitizeHtml('<p onclick="alert(1)" class="x" data-y="z">hi</p><td colspan="2" onmouseover="x()">c</td>');
  eq(out, '<p>hi</p><td colspan="2">c</td>');
});

await t("javascript:/data:/vbscript: URLs rejected, entity-encoded tricks included", async () => {
  excludes(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), "href");
  excludes(sanitizeHtml('<a href="  jAvAsCrIpT:alert(1)">x</a>'), "href");
  excludes(sanitizeHtml('<a href="java&#x73;cript:alert(1)">x</a>'), "href");
  excludes(sanitizeHtml('<img src="data:text/html;base64,xx">'), "src");
  includes(sanitizeHtml('<a href="https://ok.example/a">x</a>'), 'href="https://ok.example/a"');
  includes(sanitizeHtml('<a href="/collections">x</a>'), 'href="/collections"');
});

await t("unknown tags are stripped but their text survives; comments/doctype dropped", async () => {
  eq(sanitizeHtml("<!-- c --><custom-el>text</custom-el><marquee>hi</marquee>"), "texthi");
});

await t("dangling '<' is neutralized; a with target gains rel", async () => {
  eq(sanitizeHtml("a < b"), "a &lt; b"); // can't open a tag downstream
  const out = sanitizeHtml('<a href="https://x.example" target="_blank">x</a>');
  includes(out, 'rel="noopener noreferrer"');
  eq(sanitizeHtml(out), out); // sanitizing again doesn't add another rel (AU-05)
  eq(sanitizeHtml('<a rel="opener" href="/x" target="_blank">x</a>'), '<a href="/x" target="_blank" rel="noopener noreferrer">x</a>');
});

await t("typical Shopify description markup passes through intact", async () => {
  const html = "<p><strong>Whey</strong> isolate</p><ul><li>24g protein</li><li>5.5g BCAA</li></ul><h3>Usage</h3>";
  eq(sanitizeHtml(html), html);
});

// ---------- revisions (CAS) ----------
console.log("— draft revisions (expected-revision conflicts)");

await t("create → revision 1; save with the loaded revision → 2", async () => {
  const r1 = await S.setBlock("hero", { title: "A" }, { expectedRevision: null });
  eq(r1.revision, 1);
  const r2 = await S.setBlock("hero", { title: "B" }, { expectedRevision: 1 });
  eq(r2.revision, 2);
  eq((await S.getBlockRow("hero")).value.title, "B");
});

await t("stale revision → CmsConflictError carrying the server's current row", async () => {
  try {
    await S.setBlock("hero", { title: "C-stale" }, { expectedRevision: 1 });
  } catch (e) {
    eq(e.code, "CMS_CONFLICT");
    eq(e.current.revision, 2, "server version preserved:");
    eq(e.current.value.title, "B", "server value intact:");
    eq((await S.getBlockRow("hero")).value.title, "B", "nothing overwritten:");
    return;
  }
  throw new Error("expected CMS_CONFLICT");
});

await t("expecting-to-create when a row exists conflicts too; omitted revision skips the check", async () => {
  try {
    await S.setBlock("hero", { title: "D" }, { expectedRevision: null });
    throw new Error("expected CMS_CONFLICT");
  } catch (e) {
    eq(e.code, "CMS_CONFLICT");
  }
  const r = await S.setBlock("hero", { title: "E" }); // scripts/seeds path
  eq(r.revision, 3);
});

await t("pages: same CAS semantics + revisions exposed for the console", async () => {
  await S.upsertContentPage({ slug: "faq", title: "FAQ", sections: [{ heading: "Q", body: ["A"] }] }, { expectedRevision: null });
  eq((await S.pageRevisions()).faq, 1);
  await S.upsertContentPage({ slug: "faq", title: "FAQ v2", sections: [] }, { expectedRevision: 1 });
  try {
    await S.upsertContentPage({ slug: "faq", title: "stale", sections: [] }, { expectedRevision: 1 });
    throw new Error("expected CMS_CONFLICT");
  } catch (e) {
    eq(e.code, "CMS_CONFLICT");
  }
  eq((await S.getContentPage("faq")).title, "FAQ v2");
});

// ---------- schema registry ----------
console.log("— versioned schemas");

await t("writes stamp the current schema_version; registry covers every block key", async () => {
  const row = await db.selectFrom("cms_blocks").selectAll().where("key", "=", "hero").executeTakeFirst();
  eq(row.schema_version, BLOCK_SCHEMAS.hero.version);
  for (const key of Object.keys(BLOCK_SCHEMAS)) {
    if (typeof BLOCK_SCHEMAS[key].validate !== "function") throw new Error(`${key} missing validate`);
  }
});

await t("upgradeBlock is identity at the current version", async () => {
  const v = { title: "x" };
  eq(upgradeBlock("hero", v, 1), v);
});

// ---------- brand tokens ----------
console.log("— brand tokens (MC10)");

await t("validateBrand: bad hex rejected, enums checked", async () => {
  eq(B.validateBrand({ accent: "green" }).ok, false);
  eq(B.validateBrand({ radius: "round" }).ok, false);
  eq(B.validateBrand({ type_scale: "huge" }).ok, false);
  eq(B.validateBrand({ accent: "#0ea5e9" }).ok, true);
});

await t("S55 composition tokens: button_shape + section_spacing validate, default to today's look, emit vars", async () => {
  eq(B.validateBrand({ button_shape: "blob" }).ok, false);
  eq(B.validateBrand({ section_spacing: "huge" }).ok, false);
  const v = B.validateBrand({ button_shape: "square", section_spacing: "airy" });
  eq(v.ok, true);
  eq(v.value.button_shape, "square");
  const css = B.brandCssVars(v.value);
  includes(css, "--btn-radius:0.25rem");
  includes(css, "--section-pad-y:5rem");
  // defaults preserve the pre-S55 hardcoded look exactly
  const d = B.brandCssVars(B.validateBrand({}).value);
  includes(d, "--btn-radius:9999px");
  includes(d, "--section-pad-y:3.5rem");
});

await t("WCAG gate: unreadable body text BLOCKS; readable passes with the ratio computed", async () => {
  const bad = B.validateBrand({ foreground: "#cccccc", background: "#ffffff" });
  eq(bad.ok, false);
  includes(bad.errors.join(" "), "4.5:1");
  const good = B.validateBrand({ foreground: "#0a0a0b", background: "#ffffff" });
  eq(good.ok, true);
});

await t("accent ladder: 10 steps, input IS the 500, strictly light→dark even for extreme picks", async () => {
  for (const accent of ["#0ea5e9", "#1e3a8a", "#84cc16", "#0f172a", "#fde047"]) {
    const shades = B.accentShades(accent);
    eq(Object.keys(shades).length, 10, `${accent} steps:`);
    eq(shades[500], accent, `${accent} pinned at 500:`);
    const order = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"].map((s) => B.relativeLuminance(shades[s]));
    for (let i = 1; i < order.length; i++) {
      if (order[i] >= order[i - 1]) throw new Error(`${accent}: ladder inverts at step index ${i}`);
    }
  }
});

await t("accent_label is whichever of black/white reads best on the BUTTON surface (400 shade) and passes AA", async () => {
  for (const accent of ["#84cc16", "#1e3a8a", "#dc2626", "#0f172a"]) {
    const v = B.validateBrand({ accent }).value;
    const surface = B.accentShades(accent)[400];
    const black = B.contrastRatio("#0a0a0b", surface);
    const white = B.contrastRatio("#ffffff", surface);
    eq(v.accent_label, black >= white ? "#0a0a0b" : "#ffffff", `${accent}:`);
    if (Math.max(black, white) < 4.5) throw new Error(`${accent}: best label contrast ${Math.max(black, white).toFixed(2)} < 4.5`);
  }
});

await t("brandCssVars emits every token; resolveBrand falls back per invalid input", async () => {
  const css = B.brandCssVars(B.resolveBrand({ accent: "#1e3a8a" }));
  for (const token of ["--accent-50", "--accent-500", "--accent-900", "--accent-label", "--brand-radius", "--type-scale", "--background", "--foreground"]) {
    includes(css, token);
  }
  // invalid tenant row → platform default look, never a broken storefront
  const fallback = B.resolveBrand({ accent: "not-a-color" });
  eq(fallback.accent, B.DEFAULT_BRAND.accent);
});

await t("resolution order: no tenant brand → DEFAULT_BRAND (pre-S35 lime)", async () => {
  const r = B.resolveBrand(null);
  eq(r.accent, "#84cc16");
  eq(r.radius, "md");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
