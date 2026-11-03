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

async function shopper(drill, width) {
  const ctx = await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width, height: HEIGHTS[width] || 900 }, deviceScaleFactor: 1 });
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
async function capture(drill, page, label, set, name, { style, keep = true } = {}) {
  if (style) await page.addStyleTag({ content: style });
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

export async function captureSet(drill, label, set, { style, widths = WIDTHS, pages = PAGES, keep = true } = {}) {
  for (const width of widths) {
    const ctx = await shopper(drill, width);
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
        await capture(drill, page, label, set, `${p.name}-${width}`, { style, keep });
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

export const parts = {
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
