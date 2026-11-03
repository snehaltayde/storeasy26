// pnpm drill:edge — proves the design harness serves the storefront on the
// edge runtime with real seeded content and no code edit (P1-HARNESS, spec 8.15).
// Every storefront page a shopper reaches first, the cart, checkout's first
// step, account sign-in, a CMS page, the maintenance page while the store is
// closed, and the console's Designer with its draft preview.
// Screenshots and results.json go to docs/cms-reviews/drills/P1-HARNESS/.
//
// It switches maintenance on through the operator console and always switches
// it off again before it ends.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drawerOpen, settle } from "../drill.js";

export const id = "P1-HARNESS";
export const title = "P1-HARNESS: the storefront on the edge runtime, on the design harness, with no code edit";

const PRODUCT = "Radiance Glow Serum 30ml";
const CLOSED_MESSAGE = "Closed for a quick harness check. Back in a minute.";

// Real content each page must show. `any` means at least one of them.
const PAGES = [
  { name: "home", path: "/", all: ["Festive sale"], any: ["Makeup second", "Visibly brighter"] },
  { name: "product", path: "/products/glow-serum", all: [PRODUCT, "1,299"] },
  { name: "collection", path: "/collections/serums", all: ["Serums", PRODUCT, "Vitamin C Booster 15ml"] },
  { name: "collections", path: "/collections", all: ["Bestsellers", "Serums", "Night routine"] },
  { name: "search", path: "/search?q=serum", all: [PRODUCT] },
  { name: "account-sign-in", path: "/account", all: ["Sign in", "Email"] },
  { name: "cms-page", path: "/policies/shipping", all: ["Shipping policy", "Orders dispatch within 24 hours"] },
];

function edgeFunctionInDev(root, route) {
  try {
    const m = JSON.parse(readFileSync(join(root, ".next", "dev", "server", "app", ...route.split("/").filter(Boolean), "middleware-manifest.json"), "utf8"));
    const fn = m.functions?.[route];
    return Boolean(fn && (fn.files || []).some((f) => f.includes("server/edge/")));
  } catch {
    return false;
  }
}

// Contrast of the element whose text is `text`, against the first ancestor
// with a solid background (WCAG 2 relative luminance).
function textContrast(page, text) {
  return page.evaluate((needle) => {
    const el = [...document.querySelectorAll("body *")].find((e) => e.children.length === 0 && e.textContent.trim() === needle);
    if (!el) return null;
    // Any CSS colour (Tailwind v4 uses oklch) to [r, g, b, a] through a 1px canvas.
    const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    const rgb = (s) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    let bgEl = el;
    let bg = null;
    while (bgEl) {
      const c = rgb(getComputedStyle(bgEl).backgroundColor);
      if (c[3] > 0.95) {
        bg = c;
        break;
      }
      bgEl = bgEl.parentElement;
    }
    bg ||= [255, 255, 255];
    const fg = rgb(getComputedStyle(el).color);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    // Blend a translucent text colour over the background first.
    const a = fg[3];
    const blended = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
    const [l1, l2] = [lum(blended), lum(bg)].sort((x, y) => y - x);
    return { color: getComputedStyle(el).color, background: `rgb(${bg.slice(0, 3).join(", ")})`, ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100 };
  }, text);
}

async function pageCheck(drill, page, { name, path, all = [], any = [] }, { width = 1440 } = {}) {
  const res = await drill.open(page, path, { width });
  const f = await drill.facts(page);
  drill.check(res.status === 200, `${name} (${path}): answers 200`, res.status);
  drill.check(res.headers["x-edge-runtime"] === "1", `${name}: rendered on the edge runtime (x-edge-runtime: 1)`, res.headers["x-edge-runtime"] ?? "header absent");
  drill.check(!f.errorPage, `${name}: not an error page`, f.text.slice(0, 160));
  const missing = all.filter((m) => !f.text.includes(m));
  drill.check(!missing.length, `${name}: shows real content (${all.map((m) => `"${m}"`).join(", ")})`, `missing ${missing.join(", ")}`);
  if (any.length) drill.check(any.some((m) => f.text.includes(m)), `${name}: shows one of ${any.map((m) => `"${m}"`).join(" / ")}`);
  await drill.shoot(page, `${name}-${width}`);
  return f;
}

export default async function harnessEdge(drill) {
  const root = drill.root;

  // ---- 1. no code edit: the storefront's runtime literal is untouched ----
  const layout = readFileSync(join(root, "app", "(storefront)", "layout.js"), "utf8");
  drill.check(/^export const runtime = "edge";$/m.test(layout), 'app/(storefront)/layout.js still says export const runtime = "edge"');
  const diff = spawnSync("git", ["diff", "--quiet", "HEAD", "--", "app"], { cwd: root });
  drill.check(diff.status === 0, "git diff HEAD -- app is empty (no runtime flip or other app edit in the working tree)", `git exit ${diff.status}`);

  // ---- 2. storefront pages, anonymous shopper ----
  const shopper = await drill.context();
  const page = await shopper.newPage();
  for (const p of PAGES) await pageCheck(drill, page, p);
  await pageCheck(drill, page, PAGES[0], { width: 375 });
  await pageCheck(drill, page, PAGES[1], { width: 375 });

  // ---- 3. cart (edge route handler) and checkout's first step ----
  await drill.open(page, "/products/glow-serum", { width: 1440 });
  const posted = page.waitForResponse((r) => r.url().endsWith("/api/cart") && r.request().method() === "POST", { timeout: 60_000 });
  await page.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
  const cartPost = await posted;
  drill.check(cartPost.status() === 200, "cart: adding the product, POST /api/cart answers 200", cartPost.status());
  await page.waitForTimeout(800);
  drill.check(await drawerOpen(page), "cart: the drawer opens with the item");
  await drill.shoot(page, "cart-drawer-1440");
  const cartGet = await page.request.get("/api/cart");
  const cartJson = await cartGet.json().catch(() => ({}));
  drill.check(cartGet.status() === 200 && (cartJson.items || []).some((i) => i.title?.includes(PRODUCT)), "cart: GET /api/cart answers 200 and holds the product", cartGet.status());
  drill.check(edgeFunctionInDev(root, "/api/cart/route"), "cart: Next compiled /api/cart as an edge function (.next/dev/server/app/api/cart/route/middleware-manifest.json)");
  await pageCheck(drill, page, { name: "checkout", path: "/checkout", all: ["Contact & shipping address", PRODUCT] });
  await shopper.close();

  // ---- 4. the console's Designer and its draft preview ----
  const merchant = await drill.context();
  const consolePage = await drill.signIn(merchant);
  drill.check(new URL(consolePage.url()).pathname === "/admin/dashboard", "console: signed in with the .design-env setup password, landed on the dashboard");
  const previewDocs = [];
  const previewExposures = [];
  consolePage.on("response", (r) => {
    if (r.request().resourceType() === "document" && r.frame() !== consolePage.mainFrame()) previewDocs.push({ url: r.url(), status: r.status(), edge: r.headers()["x-edge-runtime"] });
  });
  consolePage.on("response", async (r) => {
    if (new URL(r.url()).pathname === "/api/exp" && r.frame() !== consolePage.mainFrame()) {
      previewExposures.push({ status: r.status(), body: await r.text().catch(() => "") });
    }
  });
  await drill.open(consolePage, "/admin/storefront/designer", { width: 1440 });
  const ready = await consolePage
    .getByText("Preview shows your last save")
    .waitFor({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  drill.check(ready, 'Designer: the preview connects ("Preview shows your last save")');
  const frame = consolePage.frames().find((fr) => fr !== consolePage.mainFrame() && new URL(fr.url()).pathname === "/");
  const frameText = frame ? await frame.evaluate(() => document.body?.innerText || "").catch(() => "") : "";
  // The seeded draft hero's button is "Shop night routine"; the live one's is
  // "Shop bestsellers". The running hero experiment can swap the title (not
  // the button) for some visitors, the founder's preview included, so the
  // button is what tells draft from live.
  drill.check(frameText.includes("Shop night routine") && !frameText.includes("Shop bestsellers"), 'Designer: the preview shows the saved draft hero, not the live one (button "Shop night routine")', frameText.slice(0, 200));
  drill.check(frameText.includes("Draft preview"), 'Designer: the preview is marked "Draft preview"');
  drill.check(!/Something went wrong/.test(frameText), "Designer: the preview is not an error page");
  const heroTitle = frame ? await frame.evaluate(() => document.querySelector('[data-sec="hero"] h1')?.innerText || "").catch(() => "") : "";
  drill.note(`Designer preview hero title: "${heroTitle.replace(/\s+/g, " ").trim()}" (draft title is "Winter repair, started."; the running hero-promise experiment's variant b is "Visibly brighter in 14 days")`);
  await consolePage.waitForTimeout(1500);
  drill.note(`Experiment exposures sent from inside the Designer preview (POST /api/exp): ${previewExposures.length ? previewExposures.map((x) => `${x.status} ${x.body}`).join("; ") : "none"}`);
  const homeDoc = previewDocs.find((d) => new URL(d.url).pathname === "/");
  drill.check(homeDoc?.status === 200 && homeDoc?.edge === "1", "Designer: the preview's page came from the edge runtime (200, x-edge-runtime: 1)", homeDoc || "no preview document seen");
  await drill.shoot(consolePage, "designer-1440");

  // The product and collection page designers preview a real product page and
  // collection page through the same storefront.
  const SURFACES = [
    { name: "designer-product", path: "/admin/storefront/designer/product", choose: "Choose a product…", pick: PRODUCT, page: /^\/products\//, any: [PRODUCT] },
    { name: "designer-collection", path: "/admin/storefront/designer/collection", choose: "Choose a collection…", pick: "Serums", page: /^\/collections\//, any: ["Serums"] },
  ];
  for (const s of SURFACES) {
    previewDocs.length = 0;
    await drill.open(consolePage, s.path, { width: 1440 });
    // A fresh tab has no product or collection chosen yet: pick one through the real picker.
    const choose = consolePage.getByRole("button", { name: s.choose });
    if (await choose.count()) {
      await choose.click();
      const dialog = consolePage.getByRole("dialog");
      await dialog.getByRole("button", { name: new RegExp(s.pick) }).first().click({ timeout: 30_000 });
    }
    const up = await consolePage
      .getByText("Preview shows your last save")
      .first()
      .waitFor({ timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    drill.check(up, `${s.name}: the preview connects ("Preview shows your last save")`);
    const fr = consolePage.frames().find((x) => x !== consolePage.mainFrame() && s.page.test(new URL(x.url()).pathname));
    // The page streams in: wait for the content, not just the header.
    if (fr) await fr.waitForFunction((marks) => marks.some((m) => document.body?.innerText.includes(m) && document.querySelector("h1")?.innerText.includes(m)), s.any, { timeout: 30_000 }).catch(() => {});
    const text = fr ? await fr.evaluate(() => document.body?.innerText || "").catch(() => "") : "";
    drill.check(Boolean(fr) && s.any.some((m) => text.includes(m)) && !/Something went wrong/.test(text), `${s.name}: the preview shows a real ${s.name.split("-")[1]} page (${fr ? new URL(fr.url()).pathname : "no preview frame"})`, text.slice(0, 160));
    const doc = previewDocs.find((d) => s.page.test(new URL(d.url).pathname));
    drill.check(doc?.status === 200 && doc?.edge === "1", `${s.name}: the preview's page came from the edge runtime (200, x-edge-runtime: 1)`, doc || "no preview document seen");
    // The preview may reload once after it connects; let it finish before the screenshot.
    await settle(consolePage);
    const again = consolePage.frames().find((x) => x !== consolePage.mainFrame() && s.page.test(new URL(x.url()).pathname));
    if (again) await again.waitForFunction((marks) => marks.some((m) => document.querySelector("h1")?.innerText.includes(m)), s.any, { timeout: 30_000 }).catch(() => {});
    await consolePage.waitForTimeout(800);
    await drill.shoot(consolePage, `${s.name}-1440`);
  }
  await merchant.close();

  // ---- 5. maintenance page while the store is closed ----
  const operator = await drill.context();
  const opPage = await drill.signInOperator(operator);
  const setMaintenance = (on) =>
    opPage.evaluate(
      async ([enabled, message]) => {
        const r = await fetch("/api/platform/tenants/design", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maintenance: enabled ? { enabled: true, message } : { enabled: false } }),
        });
        return r.status;
      },
      [on, CLOSED_MESSAGE],
    );
  const visitor = await drill.context();
  const vPage = await visitor.newPage();
  // The storefront caches the store's settings for up to 30 seconds
  // (PLATFORM_CACHE_MS), so wait for the change to reach it.
  const waitFor = async (path, test, seconds = 45) => {
    for (let i = 0; i < seconds; i++) {
      const res = await drill.open(vPage, path, { width: 1440 });
      const f = await drill.facts(vPage);
      if (test(f)) return { res, f };
      await vPage.waitForTimeout(1000);
    }
    return null;
  };
  try {
    const on = await setMaintenance(true);
    drill.check(on === 200, "maintenance: the operator console switches it on (PATCH answers 200)", on);
    const closed = await waitFor("/", (f) => f.text.includes(CLOSED_MESSAGE));
    drill.check(Boolean(closed), "maintenance: a signed-out shopper gets the maintenance page with the founder's message");
    if (closed) {
      drill.check(closed.res.headers["x-edge-runtime"] === "1", "maintenance: the closed page is rendered on the edge runtime", closed.res.headers["x-edge-runtime"] ?? "header absent");
      drill.check(!closed.f.text.includes("Festive sale"), "maintenance: no store content behind it (no announcement bar)");
      await drill.shoot(vPage, "maintenance-1440");
      const contrast = await textContrast(vPage, CLOSED_MESSAGE);
      if (contrast) drill.note(`maintenance: the founder's message is ${contrast.color} on ${contrast.background}, contrast ${contrast.ratio}:1 (WCAG asks 4.5:1 for body text)`);
      // Each page caches the store's settings on its own, so the product page
      // can take up to the same 30 seconds to notice.
      const pdp = await waitFor("/products/glow-serum", (f) => f.text.includes(CLOSED_MESSAGE));
      drill.check(Boolean(pdp) && !pdp.f.text.includes(PRODUCT), "maintenance: a product page shows the maintenance page too, not the product", pdp ? pdp.res.status : "still the product after 45 seconds");
    }
  } finally {
    const off = await setMaintenance(false).catch(() => 0);
    drill.check(off === 200, "maintenance: switched off again", off);
    const open = await waitFor("/", (f) => f.text.includes("Festive sale"));
    drill.check(Boolean(open), "maintenance: the store is open again afterwards");
    await visitor.close();
    await operator.close();
  }
}
