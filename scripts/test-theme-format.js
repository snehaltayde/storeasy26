// Phase 5 step 0: the theme package contract (docs/plans/phase-5.md).
// Pure, no database: the styles compiler's output for the aurora fixture,
// tampered rules skipped whole (a hand-edited theme_packages row), the design
// document's theme setting accepting an uploaded package id, and the aurora
// fixture's tokens passing the brand validator and contrast check.
//   pnpm test:theme-format
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FORMAT, LIMITS, PARTS, PROPS, BASES, REFUSALS, FORBIDDEN_KEYS } from "../lib/themes/package-format.js";
import { validateStyles, compileStyles } from "../lib/themes/styles.js";
import { SETTING_KINDS } from "../lib/registry/settings.js";
import { validateBrand, publishBlocked, contrastRatio, ROLE_IDS } from "../lib/brand.js";
import { KITS } from "../lib/themes/kits.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "themes");
const fixture = (name) => JSON.parse(readFileSync(join(FIX, `${name}.theme.json`), "utf8"));
const aurora = fixture("aurora");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.message || e).split("\n").join("\n    ")}`);
  }
}
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};

t("the format constants match the plan", () => {
  eq(FORMAT, "storeasy-theme/1");
  eq(JSON.stringify(LIMITS), JSON.stringify({ bytes: 262144, rules: 60, depth: 12, nodes: 5000, installed: 30, issues: 20 }));
  eq(PARTS.length, 15, "parts:");
  for (const p of ["buy-box", "cart", "checkout", "add-to-cart"]) ok(!PARTS.includes(p), `${p} is not a part:`);
  for (const p of ["display", "position", "visibility", "opacity", "z-index", "content", "pointer-events"]) ok(!Object.hasOwn(PROPS, p), `${p} is not a property:`);
  for (const b of BASES) ok(KITS[b]?.id === b, `${b} is a real kit:`);
  for (const k of ["scripts", "__proto__", "constructor", "prototype"]) ok(FORBIDDEN_KEYS.includes(k), `${k} forbidden:`);
  ok(REFUSALS.find((r) => r.id === "url").re.test("background:url(x)"), "url( refused:");
});

t("aurora's styles validate and compile to scoped rules, role colours as role variables", () => {
  eq(JSON.stringify(validateStyles(aurora.styles)), "[]");
  const css = compileStyles(aurora.styles, aurora.id);
  const lines = css.split("\n");
  eq(lines.length, aurora.styles.length, "one rule per style:");
  eq(lines[0], ':where([data-theme="aurora"]) [data-part="hero-title"]{letter-spacing:-0.02em;font-weight:800;color:var(--sf-hero-fg);}');
  eq(lines[3], ':where([data-theme="aurora"]) [data-part="announcement"]{background-color:#312e81;color:#eef2ff;text-align:center;}');
  eq(lines[5], ':where([data-theme="aurora"]) [data-part="product-card"]{border-radius:16px;border-width:1px;border-color:var(--sf-border-soft);box-shadow:0 1px 2px rgb(0 0 0 / 0.06);}');
  for (const l of lines) ok(l.startsWith(':where([data-theme="aurora"]) [data-part="'), `scoped: ${l}`);
  ok(!/[<]|url\(|@import|expression/i.test(css), "nothing unsafe:");
});

t("tampered rules are skipped whole; the good rule next to them still compiles", () => {
  const good = { part: "badge", set: { "font-weight": 700 } };
  const bad = [
    { part: "hero", set: { "background-color": "url(https://evil.example/x.png)" } },
    { part: "hero", set: { color: "#fff;}body{display:none" } },
    { part: "hero", set: { color: "#000}</style><script>alert(1)</script>" } },
    { part: "hero", set: { "letter-spacing": "0.1em</style>" } },
    { part: "buy-box", set: { color: "#000000" } },
    { part: 'hero"]{}*{color:red}', set: { color: "#000000" } },
    { part: "hero", set: { display: "none" } },
    { part: "hero", set: { "z-index": 9999 } },
    { part: "hero", set: { color: "role:not-a-role" } },
    { part: "hero", set: { color: "red" } },
    { part: "hero", set: { "border-width": "5px" } },
    { part: "hero", set: { "font-weight": 450 } },
    { part: "hero", set: { "box-shadow": "0 0 0 9999px red" } },
    { part: "hero", set: { color: "#111111", "background-color": "#222222" } }, // 1.1:1
    { part: "hero", set: { color: "#000000" }, extra: 1 },
    { part: "hero", set: {} },
    null,
    "hero{color:red}",
  ];
  const styles = [...bad, good];
  const issues = validateStyles(styles);
  for (let i = 0; i < bad.length; i++) ok(issues.some((x) => x.path.startsWith(`styles[${i}]`)), `styles[${i}] reported:`);
  ok(!issues.some((x) => x.path.startsWith(`styles[${bad.length}]`)), "the good rule has no issue:");
  eq(compileStyles(styles, "aurora"), ':where([data-theme="aurora"]) [data-part="badge"]{font-weight:700;}');
});

t("the compiler re-checks a part that is an inherited key and caps the rule count", () => {
  eq(compileStyles([{ part: "constructor", set: { color: "#000000" } }, { part: "hero", set: { toString: "x" } }], "aurora"), "");
  const many = Array.from({ length: 70 }, () => ({ part: "badge", set: { gap: "1rem" } }));
  eq(compileStyles(many, "aurora").split("\n").length, LIMITS.rules, "rules written:");
  ok(validateStyles(many).some((x) => x.path === "styles"), "too many reported:");
});

t("a bad theme id compiles to nothing", () => {
  for (const id of ['aurora"]{}*{x:y', "Aurora", "", "a".repeat(41), "aur<ora", null, 7]) eq(compileStyles(aurora.styles, id), "", `${JSON.stringify(id)}:`);
  eq(compileStyles(aurora.styles, "a".repeat(40)).split("\n").length, aurora.styles.length, "40 chars ok:");
});

t("every role id compiles to its --sf- variable", () => {
  for (const r of ROLE_IDS) eq(compileStyles([{ part: "hero", set: { "border-color": `role:${r}` } }], "x"), `:where([data-theme="x"]) [data-part="hero"]{border-color:var(--sf-${r});}`);
});

t("the design document's theme setting accepts an uploaded package id and refuses a bad one", () => {
  const check = (v) => {
    const issues = [];
    SETTING_KINDS.theme.check(v, {}, "theme", (path, code, message) => issues.push({ path, code, message }));
    return issues;
  };
  eq(check({ kit: "pulse", version: 1 }).length, 0, "no package:");
  eq(check({ kit: "glow", version: 1, applied_at: "2026-11-25T00:00:00.000Z", package: "thm_0123456789abcdef" }).length, 0, "package:");
  for (const bad of ["thm_0123456789ABCDEF", "thm_0123", "doc_0123456789abcdef", "thm_0123456789abcdef0", 42, ""]) {
    const issues = check({ kit: "pulse", version: 1, package: bad });
    eq(issues.length, 1, `${JSON.stringify(bad)}:`);
    eq(issues[0].path, "theme.package");
    eq(issues[0].code, "THEME_INVALID");
  }
  ok(check({ kit: "pulse", version: 1, packages: "thm_0123456789abcdef" }).length > 0, "unknown key refused:");
});

t("aurora's tokens pass validateBrand, its contrast checks and the publish check", () => {
  const r = validateBrand(aurora.tokens);
  ok(r.ok, `errors: ${r.errors.join("; ")}`);
  for (const k of Object.keys(aurora.tokens)) eq(r.value[k], aurora.tokens[k], `${k}:`);
  ok(contrastRatio(aurora.tokens.foreground, aurora.tokens.background) >= 4.5, "text on background:");
  for (const s of Object.values(aurora.surfaces)) {
    ok(contrastRatio(s.fg, s.bg) >= 4.5, "surface fg:");
    ok(contrastRatio(s.muted, s.bg) >= 4.5, "surface muted:");
  }
  const blocked = publishBlocked(aurora.tokens, { kit: `${aurora.base}-1` });
  eq(blocked, false, "publish blocked:");
  eq(aurora.format, FORMAT);
  ok(BASES.includes(aurora.base), "base:");
});

t("every evil fixture is aurora with one unsafe change", () => {
  const evil = readdirSync(FIX).filter((f) => f.startsWith("evil-")).map((f) => f.replace(".theme.json", "")).sort();
  eq(evil.join(" "), "evil-deep evil-external evil-iframe evil-import evil-javascript-entity evil-onclick-key evil-proto evil-script evil-url");
  for (const name of evil) ok(JSON.stringify(fixture(name)) !== JSON.stringify(aurora), `${name} differs:`);
  ok(Object.hasOwn(fixture("evil-proto").tokens, "__proto__"), "evil-proto keeps an own __proto__ key:");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
