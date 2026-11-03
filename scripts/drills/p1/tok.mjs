// TOK-01 / TOK-02 / checkout width: screenshot sets and browser checks on the
// design harness (edge runtime). Run through the P1 runner:
//   TOK_RAW_DIR=<folder outside the repo> DESIGN_PORT=3204 node scripts/drills/p1/run.mjs tok <part>
//
// Parts
//   baseline   10 storefront pages × 375/768/1440 for the seeded brand and for
//              no brand at all (the platform default look), BEFORE the sweep.
//   after      the same set after the sweep (label "after").
//   pinned     the seeded brand again, with every TOK-01 role pinned to the
//              value today's classes had (an injected style), so a pixel
//              comparison against the baseline shows only what the sweep
//              changed besides the roles' new brand-derived values.
//   themes     the two test themes (light, dark): every text/background pair
//              on home, product, collection, cart and checkout, measured
//              from computed styles in Chrome.
//   width      checkout with one item at 320/360/375/390/414.
//
// Lossless full-page captures go to $TOK_RAW_DIR/<label>/<set>/<page>-<w>.png
// (the pixel comparison runs on those: scripts/pixel-diff.js). Small copies for
// the review packet go to docs/cms-reviews/drills/TOK-01-02/<label>/.
//
// The live brand is switched by publishing a copy of the live release with
// another brand/theme straight into the LOCAL harness database (db.mjs only
// talks to this checkout's sqld). Each part puts the seeded release back.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settle } from "../../drill.js";
import { rows, sql } from "./db.mjs";
import { audit } from "./contrast.mjs";

export const id = "TOK-01-02";
export const title = "TOK-01/02: storefront tokens, pairing matrix, checkout width";

const WIDTHS = [375, 768, 1440];
const HEIGHTS = { 320: 640, 360: 740, 375: 812, 390: 844, 414: 896, 768: 1024, 1440: 900 };
// committed copies are a visual record only; the comparison uses the lossless captures
const SMALL_BYTES = 40 * 1024;
const UNIT = "tok-drill-fixed-unit"; // fixed experiment unit: the hero variant never varies between runs
const CONSENT = encodeURIComponent(JSON.stringify({ v: 2, a: 0, m: 0, at: "2026-11-01T00:00:00.000Z" }));

export const PAGES = [
  { name: "home", path: "/" },
  { name: "product", path: "/products/glow-serum" },
  { name: "collection", path: "/collections/serums" },
  { name: "collections", path: "/collections" },
  { name: "search", path: "/search?q=serum" },
  { name: "cart-drawer", path: "/products/glow-serum", cart: true },
  { name: "checkout", path: "/checkout", needsCart: true },
  { name: "account", path: "/account" },
  { name: "cms-page", path: "/policies/shipping" },
  { name: "not-found", path: "/tok-no-such-page", status: 404 },
];

// The two TOK exit-check test themes. Light: warm paper with the Glow kit's
// light header and hero. Dark: a near-black store on the Pulse kit.
export const TEST_THEMES = {
  light: { brand: { accent: "#c2410c", background: "#fffdf8", foreground: "#1c1917", radius: "lg", type_scale: "regular" }, theme: { kit: "glow", version: 1 } },
  dark: { brand: { accent: "#2dd4bf", background: "#0b0f17", foreground: "#f1f5f9", radius: "md", type_scale: "regular" }, theme: { kit: "pulse", version: 1 } },
};

const rawRoot = () => {
  const d = process.env.TOK_RAW_DIR;
  if (!d) throw new Error("Set TOK_RAW_DIR to a folder outside the repo for the lossless captures");
  return d;
};

// ---- live release switching (local harness database only) -----------------

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}
async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function liveRelease() {
  const [st] = await rows("tenant", "SELECT live_release_id id FROM release_state WHERE id = 1");
  const [rel] = await rows("tenant", "SELECT id, content FROM releases WHERE id = ?", [st.id]);
  return { id: rel.id, content: JSON.parse(rel.content) };
}

// Publish a copy of `base` with brand/theme replaced; returns the new id.
export async function publishCopy(base, { brand, theme }) {
  const content = { ...base, brand: brand ?? null, theme: theme ?? null };
  const canonical = stableStringify(content);
  const hash = await sha256Hex(canonical);
  const rid = "rel_tok" + Math.random().toString(16).slice(2, 11);
  const now = new Date().toISOString();
  await sql("tenant", [
    { sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)", args: [rid, canonical, hash, "TOK drill", now, now] },
    { sql: "UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1", args: [rid, now] },
  ]);
  return rid;
}

export async function pointLiveAt(releaseId) {
  await sql("tenant", "UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1", [releaseId, new Date().toISOString()]);
}

// ---- capture ------------------------------------------------------------------

// A small copy of a full-page capture for the packet: at most 360 wide,
// 48 colours, the top 2,000px (scaled) at most. A visual record only.
export async function smallCopy(raw, { maxBytes = SMALL_BYTES } = {}) {
  const sharp = (await import("sharp")).default;
  let out = null;
  for (const [width, colours, maxH] of [[360, 64, 2000], [360, 48, 1600], [320, 32, 1400], [280, 24, 1200]]) {
    const scaled = await sharp(raw).resize({ width, withoutEnlargement: true }).png().toBuffer();
    const meta = await sharp(scaled).metadata();
    const img = meta.height > maxH ? sharp(scaled).extract({ left: 0, top: 0, width: meta.width, height: maxH }) : sharp(scaled);
    out = await img.png({ palette: true, colours, compressionLevel: 9, effort: 8 }).toBuffer();
    if (out.length <= maxBytes) return out;
  }
  return out;
}

// serviceWorkers "block": the store's service worker would otherwise answer
// navigations itself, out of reach of page.route (used to pin roles)
async function shopper(drill, width, { blockSw = false } = {}) {
  const ctx = await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width, height: HEIGHTS[width] || 900 }, deviceScaleFactor: 1, ...(blockSw ? { serviceWorkers: "block" } : {}) });
  const host = new URL(drill.baseUrl).hostname;
  await ctx.addCookies([
    { name: "_unit", value: UNIT, domain: host, path: "/" },
    { name: "_consent", value: CONSENT, domain: host, path: "/" },
  ]);
  return ctx;
}

async function addToCart(page) {
  const posted = page.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST", { timeout: 60_000 });
  await page.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
  const res = await posted;
  // the drawer slides in (300ms) and the total pops (500ms): let both finish
  await page.waitForFunction(() => {
    const d = document.querySelector('[role="dialog"][aria-label="Shopping cart"]');
    return d && d.getBoundingClientRect().left < window.innerWidth - 10;
  }, null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return res.status();
}

// Lossless full page into the raw folder, a small copy into the packet folder.
async function capture(drill, page, label, set, name, { keep = true } = {}) {
  await page.mouse.move(1, 1); // nothing hovered
  await page.waitForTimeout(300);
  const raw = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
  const rawDir = join(rawRoot(), label, set);
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(rawDir, `${name}.png`), raw);
  if (!keep) return raw.length;
  const small = await smallCopy(raw);
  const dir = join(drill.dir, label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${set}-${name}.png`), small);
  drill.shots.push({ name: `${label}/${set}-${name}`, bytes: small.length });
  return raw.length;
}

export async function captureSet(drill, label, set, { pin = false, widths = WIDTHS, pages = PAGES, keep = true } = {}) {
  for (const width of widths) {
    const ctx = await shopper(drill, width);
    if (pin) await pinRoles(ctx, drill.baseUrl);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e?.message || e).slice(0, 200)));
    try {
      for (const p of pages) {
        const res = await page.goto(p.path, { waitUntil: "load", timeout: 120_000 });
        await settle(page);
        const status = res?.status() ?? 0;
        drill.check(status === (p.status || 200), `${label}/${set}: ${p.name} at ${width} answers ${p.status || 200}`, status);
        if (p.cart) {
          const s = await addToCart(page);
          drill.check(s === 200, `${label}/${set}: cart at ${width}: Add to cart answers 200`, s);
        }
        await capture(drill, page, label, set, `${p.name}-${width}`, { keep });
      }
    } finally {
      drill.check(!errors.length, `${label}/${set}: no page errors at ${width}`, errors.slice(0, 4));
      await ctx.close();
    }
  }
}

async function withLive(drill, sets, fn) {
  const orig = await liveRelease();
  drill.note(`live release before: ${orig.id}`);
  try {
    for (const [set, override] of Object.entries(sets)) {
      if (override) await publishCopy(orig.content, override);
      else await pointLiveAt(orig.id);
      await fn(set);
    }
  } finally {
    await pointLiveAt(orig.id);
    drill.note(`live release put back: ${orig.id}`);
  }
}

// ---- parts ---------------------------------------------------------------------

export const SEEDED = null; // the seeded live release as it is
export const DEFAULT_LOOK = { brand: null, theme: null };

// The two TOK-02 negatives, as a shopper sees them, on whatever code runs.
// dark:  a dark background with light text, the founder's real choice. Before
//        TOK-01 the product titles stayed hard-coded near-black (1.12:1).
// black: a black accent. Its hero highlight and badge render in the 400 shade
//        of black, a dark grey on the near-black hero (2.08:1).
export const NEGATIVE_BRANDS = {
  dark: (b) => ({ ...b, background: "#0a0a0b", foreground: "#fafafa" }),
  black: (b) => ({ ...b, accent: "#000000" }),
};

async function measureNegatives(drill, label) {
  const orig = await liveRelease();
  const seededBrand = orig.content.brand || {};
  const out = {};
  try {
    for (const [key, make] of Object.entries(NEGATIVE_BRANDS)) {
      await publishCopy(orig.content, { brand: make(seededBrand), theme: orig.content.theme });
      const ctx = await shopper(drill, 1440);
      const page = await ctx.newPage();
      const path = key === "dark" ? "/collections/serums" : "/";
      await page.goto(path, { waitUntil: "load" });
      await settle(page);
      const all = await audit(page);
      const pick =
        key === "dark"
          ? all.filter((r) => r.tag === "h3" && /Serum|Booster/.test(r.text))
          : all.filter((r) => r.tag === "span" && /accent/.test(r.cls)).concat(all.filter((r) => r.tag === "p" && / products · /.test(r.text)));
      out[key] = { path, brand: make(seededBrand), measured: pick.map(({ text, fg, bg, ratio, need, large, cls }) => ({ text, fg, bg, ratio, need, large, cls })) };
      drill.note(`${label}/${key}: ${JSON.stringify(out[key].measured)}`);
      await page.mouse.move(1, 1);
      const raw = await page.screenshot({ fullPage: false, animations: "disabled", caret: "hide" });
      mkdirSync(join(drill.dir, label), { recursive: true });
      writeFileSync(join(drill.dir, label, `negative-${key}-1440.png`), await smallCopy(raw, { maxBytes: 60 * 1024 }));
      await ctx.close();
    }
  } finally {
    await pointLiveAt(orig.id);
  }
  writeFileSync(join(drill.dir, label, "negatives.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

// Every TOK-01 role pinned to what the class it replaced rendered before the
// sweep, on a branded page: the brand's own role overrides are taken out of
// its <style data-href="brand-vars"> (so each role falls back to the compiled
// globals.css default: zinc, lime, amber, red, accent roles as their ladder
// step), surfaces and text on solid buttons go back to white (bg-white,
// text-white) and radii to today's fixed Tailwind steps. Everything else in
// the brand (accent ladder, background, foreground, type scale) stays. It
// shows what the sweep changed apart from the roles' new brand-derived
// values. How: a stylesheet added before the first paint (an init script)
// re-declares every role with !important, using the exact value the BUILD
// compiled for globals.css (it turns the oklch defaults into lab(), and a
// hand-written oklch renders 1 unit off). Changing the variables after load
// instead left stale anti-aliased edges; editing the HTML broke React's
// length-prefixed payload.
export const PIN = "--sf-surface:#fff!important;--sf-on-inverse:#fff!important;--sf-radius-card:1rem!important;--sf-radius-control:0.75rem!important;--sf-radius-small:0.5rem!important;--sf-radius-xs:0.375rem!important;--sf-radius-2xs:0.25rem!important;";
export async function compiledRoleDefaults(baseUrl) {
  const html = await (await fetch(`${baseUrl}/`)).text();
  const hrefs = [...new Set([...html.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]))];
  const css = (await Promise.all(hrefs.map((h) => fetch(baseUrl + h).then((r) => r.text())))).join("\n");
  const plain = {};
  const lab = {};
  for (const m of css.matchAll(/@supports \(color:lab\(0% 0 0\)\)\{:root\{([^}]*)\}\}/g)) for (const d of m[1].matchAll(/(--sf-[a-z0-9-]+):([^;]+)/g)) lab[d[1]] = d[2];
  for (const m of css.matchAll(/:root\{([^}]*)\}/g)) for (const d of m[1].matchAll(/(--sf-[a-z0-9-]+):([^;]+)/g)) plain[d[1]] ??= d[2];
  return { ...plain, ...lab };
}
async function pinCss(baseUrl) {
  const defaults = await compiledRoleDefaults(baseUrl);
  const own = Object.entries(defaults)
    .filter(([k]) => !/^--sf-(radius-|surface$|on-inverse$)/.test(k))
    .map(([k, v]) => `${k}:${v}!important;`)
    .join("");
  return `html:root{${own}${PIN}}`;
}
async function pinRoles(ctx, baseUrl) {
  const css = await pinCss(baseUrl);
  await ctx.addInitScript((text) => {
    const add = () => {
      if (document.getElementById("tok-pin")) return;
      const s = document.createElement("style");
      s.id = "tok-pin";
      s.textContent = text;
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.documentElement) add();
    else new MutationObserver((_, o) => document.documentElement && (add(), o.disconnect())).observe(document, { childList: true });
  }, css);
  return css;
}

export const parts = {
  async pinned(drill) {
    await withLive(drill, { seeded: SEEDED }, (set) => captureSet(drill, process.env.TOK_LABEL || "pinned", set, { pin: true, keep: false }));
  },
  // control for `pinned`: the same injected style on the default look, which
  // has no brand variables to override, so any difference is the injection
  async "pinned-control"(drill) {
    await withLive(drill, { default: DEFAULT_LOOK }, (set) => captureSet(drill, process.env.TOK_LABEL || "pinned", set, { pin: true, keep: false }));
  },

  async "negatives-before"(drill) {
    const out = await measureNegatives(drill, "before");
    const dark = out.dark.measured;
    drill.check(dark.length > 0 && dark.every((r) => r.ratio < 1.5), "before: with a dark background, product titles render dark on dark (the bug)", dark);
    const black = out.black.measured;
    drill.check(black.some((r) => r.ratio < 2.5), "before: with a black accent, the hero highlight or badge renders near-invisible (the bug)", black);
  },

  async baseline(drill) {
    await withLive(drill, { seeded: SEEDED, default: DEFAULT_LOOK }, (set) => captureSet(drill, "baseline", set));
  },
  // The same capture again, raw only: proves two runs of unchanged code give
  // byte-identical pixels, so a difference later is the code, not the harness.
  async repeat(drill) {
    const label = process.env.TOK_LABEL || "repeat";
    await withLive(drill, { seeded: SEEDED, default: DEFAULT_LOOK }, (set) => captureSet(drill, label, set, { keep: false }));
  },
  async after(drill) {
    await withLive(drill, { seeded: SEEDED, default: DEFAULT_LOOK }, (set) => captureSet(drill, "after", set));
  },
};
