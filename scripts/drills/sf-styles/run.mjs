// SF-STYLES: `pnpm drill:sf-styles`, the storefront render comparison
// (Phase 0 line 7, docs/plans/phase-0.md §5). Proves a console-only CSS
// change leaves every storefront page, and the legacy /admin/login, rendered
// exactly as before. A reusable tool, not a permanent golden.
//
//   pnpm drill:sf-styles                                    capture only
//   SF_STYLES_BASELINE=<abs dir> pnpm drill:sf-styles       capture, then compare
//   SF_STYLES_BITE=1 SF_STYLES_BASELINE=<dir> pnpm drill:sf-styles
//                    adds 0.01em letter-spacing to :root; passes only when the
//                    compare catches it (proves the tool bites)
//
// Only in a throwaway worktree (scripts/drills/run-isolated.mjs): runDrill
// refuses anywhere else. The store is the phase 3 seed (--p3: the live design
// store on localhost and the closed store on closed.localhost).
//
// Pages: /, a product, a collection, the cart drawer open (one item), the
// closed store's page, /admin/login; at 375, 768 and 1280 wide. For each:
// every element and its ::before/::after, full getComputedStyle and the box
// rounded to 0.5px, plus a full-page screenshot hash. Held fixed: reduced
// motion, animations and transitions off (an adopted stylesheet, so no
// element is added), document.fonts.ready, images complete, service workers
// blocked, the same consent and experiment cookies, running experiments'
// salts pinned (each seed makes a random one).
//
// Saved in docs/cms-reviews/drills/SF-STYLES/ (the runner copies it to
// .drill-results/<stamp>/SF-STYLES/, which is what SF_STYLES_BASELINE names):
//   <page>-<width>.json.gz   the capture, with each element's hash
//   <page>-<width>.png       the full-page screenshot (cut at 6000px)
//   manifest.json            pages, statuses, hashes, stylesheet sizes
//   compare.json             (compare runs) the diff against the baseline
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { ROOT } from "../../design-harness.js";
import { reseed, runDrill, settle, storeSql, storeUrl } from "../p3/lib.mjs";
import { CONSENT_COOKIE, serializeConsent } from "../../../lib/track/names.js";
import { diffRuns, elementHash, hashOf, isClean } from "./compare.js";

export const DRILL_ID = "SF-STYLES";
export const WIDTHS = [375, 768, 1280];
const HEIGHTS = { 375: 812, 768: 1024, 1280: 900 };
const PRODUCT = "/products/glow-serum";
const MAX_SHOT_HEIGHT = 6000;
const UNIT = "sf-styles";
const FREEZE = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";
const BITE = ":root{letter-spacing:0.01em!important}";

// In the page (self-contained: page.evaluate serialises it).
export function captureDom() {
  const r2 = (n) => Math.round(n * 2) / 2;
  const out = [];
  const styleOf = (cs) => {
    const s = {};
    for (let i = 0; i < cs.length; i++) s[cs[i]] = cs.getPropertyValue(cs[i]);
    return s;
  };
  const walk = (el, path) => {
    const r = el.getBoundingClientRect();
    out.push({ k: path, s: styleOf(getComputedStyle(el)), b: [r2(r.x + scrollX), r2(r.y + scrollY), r2(r.width), r2(r.height)] });
    for (const pseudo of ["::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content === "none" || cs.content === "normal") continue;
      out.push({ k: path + pseudo, s: styleOf(cs), b: null });
    }
    // <script>s are never drawn, and Next dev streams a varying number of
    // them (123 or 124 on one page between two runs of the same commit),
    // which would shift every later sibling's path: skipped, not counted
    let i = 0;
    for (const c of el.children) if (c.tagName !== "SCRIPT") walk(c, `${path}>${c.tagName.toLowerCase()}:${++i}`);
  };
  walk(document.documentElement, "html");
  return out;
}

async function context(drill, width, origin) {
  const ctx = await drill.browser.newContext({ viewport: { width, height: HEIGHTS[width] }, deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block" });
  ctx.setDefaultTimeout(60_000);
  // declined, at a fixed time: the same cookie on every run
  const consent = encodeURIComponent(JSON.stringify({ ...JSON.parse(serializeConsent({ analytics: false, marketing: false })), at: "2026-01-01T00:00:00.000Z" }));
  await ctx.addCookies([
    { name: "_unit", value: UNIT, url: origin },
    { name: CONSENT_COOKIE, value: consent, url: origin },
  ]);
  return ctx;
}

async function freeze(page, bite) {
  await page.evaluate(
    async ({ css }) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      await document.fonts?.ready;
      await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => ((i.onload = i.onerror = r), setTimeout(r, 5000)))));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    { css: bite ? `${FREEZE}\n${BITE}` : FREEZE },
  );
}

// The pages, as { name, origin, path, after(page) }.
async function pagesOf(drill) {
  const live = storeUrl(drill, "live", "");
  const closed = storeUrl(drill, "closed", "");
  const handle = (await storeSql("tenant", ["SELECT handle FROM collections ORDER BY handle LIMIT 1"]))[0].rows[0]?.handle;
  const pages = [
    { name: "home", origin: live, path: "/" },
    { name: "product", origin: live, path: PRODUCT },
    { name: "collection", origin: live, path: handle ? `/collections/${handle}` : null },
    {
      name: "cart-drawer",
      origin: live,
      path: PRODUCT,
      async after(page) {
        const posted = page.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST", { timeout: 60_000 });
        await page.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
        await posted;
        await page.waitForFunction(() => {
          const d = document.querySelector('[role="dialog"][aria-label="Shopping cart"]');
          return d && d.getBoundingClientRect().left < window.innerWidth - 10;
        });
        await settle(page);
      },
    },
    { name: "closed", origin: closed, path: "/" },
    { name: "admin-login", origin: live, path: "/admin/login" },
  ];
  return pages;
}

async function capture(drill, spec, width, bite) {
  const ctx = await context(drill, width, spec.origin);
  try {
    const page = await ctx.newPage();
    const res = await page.goto(spec.origin + spec.path, { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    await freeze(page, bite);
    if (spec.after) {
      await spec.after(page);
      await freeze(page, false);
    }
    const elements = (await page.evaluate(captureDom)).map((e) => ({ ...e, h: elementHash(e) }));
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    const png = await page.screenshot({ fullPage: true, clip: h > MAX_SHOT_HEIGHT ? { x: 0, y: 0, width, height: MAX_SHOT_HEIGHT } : undefined, animations: "disabled", caret: "hide" });
    const css = await page.evaluate(async () => {
      const out = [];
      for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
        const text = await fetch(l.href).then((r) => r.text(), () => "");
        out.push({ href: new URL(l.href).pathname, bytes: new TextEncoder().encode(text).length });
      }
      return out;
    });
    return { page: spec.name, width, url: spec.path, status: res?.status() ?? 0, shot: hashOf(png), png, css, elements };
  } finally {
    await ctx.close();
  }
}

export function readCaptures(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  return { manifest, captures: manifest.pages.map((p) => JSON.parse(gunzipSync(readFileSync(join(dir, p.file))).toString("utf8"))) };
}

const cssTotal = (pages) => {
  const seen = new Map();
  for (const p of pages) for (const c of p.css || []) seen.set(c.href, c.bytes);
  return { files: Object.fromEntries(seen), bytes: [...seen.values()].reduce((n, b) => n + b, 0) };
};

async function sfStyles(drill) {
  const baselineDir = process.env.SF_STYLES_BASELINE || "";
  const bite = process.env.SF_STYLES_BITE === "1";
  if (bite && !baselineDir) throw new Error("SF_STYLES_BITE=1 needs SF_STYLES_BASELINE=<abs dir> (a bite is only caught by a compare).");
  if (baselineDir && !existsSync(join(baselineDir, "manifest.json"))) throw new Error(`SF_STYLES_BASELINE has no manifest.json: ${baselineDir}`);
  await reseed(drill, { start: true });
  // risk 3: a running experiment's salt is random per seed, so the same _unit
  // got a different hero variant (other text, other heights) on each run.
  // Pinned here, in this worktree's own store, before any page is captured.
  const [pinned] = await storeSql("tenant", ["UPDATE experiments SET salt = 'sf-styles' WHERE status = 'running'"]);
  drill.note(`experiment salts pinned to "sf-styles" (${pinned.rowsAffected} running)`);
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
  drill.note(`HEAD ${head}${bite ? "; bite mode: :root letter-spacing 0.01em" : ""}${baselineDir ? `; baseline ${baselineDir}` : ""}`);
  const captures = [];
  for (const spec of await pagesOf(drill)) {
    drill.check(Boolean(spec.path), `${spec.name}: the page has an address`, spec.path);
    if (!spec.path) continue;
    for (const width of WIDTHS) {
      const c = await capture(drill, spec, width, bite);
      const expected = spec.name === "closed" ? [200, 503] : [200];
      drill.check(expected.includes(c.status), `${spec.name} ${width}px answers ${expected.join(" or ")}`, c.status);
      const file = `${spec.name}-${width}.json.gz`;
      writeFileSync(join(drill.dir, file), gzipSync(JSON.stringify({ page: c.page, width, url: c.url, status: c.status, shot: c.shot, css: c.css, elements: c.elements })));
      writeFileSync(join(drill.dir, `${spec.name}-${width}.png`), c.png);
      captures.push({ ...c, file, png: undefined });
      console.log(`  · ${spec.name} ${width}px: ${c.elements.length} elements, status ${c.status}`);
    }
  }
  const manifest = {
    id: DRILL_ID,
    head,
    bite,
    ranAt: new Date().toISOString(),
    css: cssTotal(captures),
    pages: captures.map((c) => ({ page: c.page, width: c.width, url: c.url, status: c.status, file: c.file, shot: c.shot, elements: c.elements.length, hash: hashOf(c.elements.map((e) => e.h).join("\n")) })),
  };
  writeFileSync(join(drill.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  drill.note(`storefront CSS: ${manifest.css.bytes} bytes (${Object.entries(manifest.css.files).map(([f, b]) => `${f} ${b}`).join(", ")})`);
  if (!baselineDir) return;

  const base = readCaptures(baselineDir);
  const diff = diffRuns(base.captures, captures);
  const report = {
    id: DRILL_ID,
    ranAt: manifest.ranAt,
    baseline: { dir: baselineDir, head: base.manifest.head, ranAt: base.manifest.ranAt, css: base.manifest.css },
    run: { head, bite, css: manifest.css },
    cssDeltaBytes: manifest.css.bytes - base.manifest.css.bytes,
    totals: diff.totals,
    missing: diff.missing,
    customAdded: diff.customAdded,
    pages: diff.pages,
  };
  writeFileSync(join(drill.dir, "compare.json"), `${JSON.stringify(report, null, 2)}\n`);
  const t = diff.totals;
  drill.note(`compare: ${t.style} computed-style, ${t.box} box, ${t.added} added and ${t.removed} removed element differences; ${t.customChanged} changed and ${t.customAdded} added custom properties (${diff.customAdded.join(", ") || "none"}); ${t.shots} screenshot(s) differ; ${t.missing} missing; CSS ${report.cssDeltaBytes >= 0 ? "+" : ""}${report.cssDeltaBytes} bytes`);
  if (bite) {
    const caught = diff.pages.some((p) => p.samples.some((s) => s.prop === "letter-spacing"));
    drill.check(!isClean(t) && caught, "bite: the 0.01em letter-spacing is caught as computed-style differences", t);
  } else {
    drill.check(isClean(t), "no computed-style, box or element differences against the baseline (custom properties: additions only)", t);
    if (t.shots) drill.note(`screenshot differences: ${diff.pages.filter((p) => p.shot !== "same").map((p) => `${p.page}@${p.width}`).join(", ")} (they fail only if the baseline-vs-baseline screenshots were identical; see compare.json)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDrill({ id: DRILL_ID, part: "main", title: "SF-STYLES — the storefront renders as before" }, sfStyles).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`✗ ${e.message || e}`);
      process.exit(1);
    },
  );
}
