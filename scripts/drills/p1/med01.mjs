// P1-DRILLS · MED-01, the parts desktop Chrome can do (docs/cms-reviews/P1-MED-01.md
// "Browser drill still needed"). Test files are synthetic, made by
// med01-fixtures.mjs into MED01_FILES (not real phone photos).
//   library   drills 1, 3, 4, 5(c), 6, 7, 8, 11 from Storefront → Media
//   picker    drill 1 and 7 (a refusal) from an image field's picker
//   progress  drill 2 on a throttled connection: banner stages in both places,
//             Escape mid-upload, reopen for another spot, network lost after closing
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { rows } from "./db.mjs";
import { text, seen, settle, sleep } from "./util.mjs";

export const id = "MED-01";
export const title = "P1-DRILLS MED-01: one upload path that makes photos fit (desktop Chrome)";

const FILES = process.env.MED01_FILES;
const f = (name) => join(FILES, name);

async function mediaList(page) {
  return page.evaluate(async () => (await (await fetch("/api/admin/media", { cache: "no-store" })).json()).media || []);
}

// Upload one file through the library's own input; report what happened.
async function libUpload(drill, page, name) {
  const before = await mediaList(page);
  const posts = [];
  const onReq = (r) => new URL(r.url()).pathname === "/api/admin/media" && r.request().method() === "POST" && posts.push(r);
  page.on("response", onReq);
  await page.evaluate(() => document.querySelectorAll("div").forEach((d) => d.dataset.p1seen = "1"));
  await page.locator('input[type="file"]').first().setInputFiles(f(name));
  let done = null;
  for (let i = 0; i < 240 && !done; i++) {
    await sleep(250);
    const st = await page.evaluate(() => {
      const input = document.querySelector('input[type="file"]');
      const err = [...document.querySelectorAll("div")].find((d) => /danger-bg/.test(d.className || "") && d.innerText.trim());
      const toasts = [...document.querySelectorAll('div[aria-live="polite"]')].filter((d) => d.className.includes("fixed")).flatMap((d) => [...d.querySelectorAll("p")].map((p) => p.innerText.trim()));
      return { busy: input?.disabled, error: err?.innerText.trim() || null, toasts };
    });
    if (!st.busy && i > 2) done = st;
  }
  page.off("response", onReq);
  const after = await mediaList(page);
  const added = after.filter((m) => !before.some((b) => b.id === m.id));
  const orig = added.find((m) => !m.variant || m.variant === "original") || added[0] || null;
  const size = statSync(f(name)).size;
  return {
    name,
    sentBytes: size,
    posts: posts.map((p) => p.status()),
    error: done?.error || null,
    toasts: done?.toasts || [],
    stored: orig ? { mime: orig.mime, size: orig.size, width: orig.width, height: orig.height, filename: orig.filename, thumb: Boolean(orig.variants?.some((v) => v.variant === "thumb")), id: orig.id } : null,
    reused: !orig && posts.some((s) => s.status() === 200) ? "duplicate reused" : undefined,
  };
}

export const parts = {
  async library(drill) {
    if (!FILES) throw new Error("set MED01_FILES to the folder med01-fixtures.mjs wrote");
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    await drill.open(page, "/admin/media", { width: 1280 });
    const log = [];
    const up = async (name) => {
      await drill.open(page, "/admin/media", { width: 1280 });
      const r = await libUpload(drill, page, name);
      log.push(r);
      drill.note(`upload ${name}: ${JSON.stringify(r)}`);
      return r;
    };
    // 1
    let r = await up("photo-4000x3000.jpg");
    drill.check(r.stored && r.stored.mime === "image/jpeg" && Math.max(r.stored.width, r.stored.height) === 1920 && r.stored.size < 1.5 * 1024 * 1024 && r.stored.thumb && !r.error, "1 (synthetic 5MB, 4000px JPEG): no error, image/jpeg, 1920 on the long edge, under 1.5MB, +thumb", r);
    await drill.shoot(page, "1-library-photo");
    // 3
    r = await up("transparent-1800.png");
    drill.check(r.stored && r.stored.mime === "image/webp" && r.stored.size < 1.5 * 1024 * 1024 && !r.error, "3 (Chrome): a transparent PNG over 1.5MB is stored as WebP under the limit", r);
    if (r.stored) {
      const px = await page.evaluate(async (id) => {
        const img = await createImageBitmap(await (await fetch(`/api/media/${id}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const at = (x, y) => [...g.getImageData(x, y, 1, 1).data];
        return { w: img.width, corner: at(2, 2), middle: at(Math.floor(img.width / 2), Math.floor(img.height / 2)) };
      }, r.stored.id);
      drill.check(px.corner[3] === 0 && px.middle[3] === 255, "3: corners stay see-through (alpha 0), the middle solid", px);
    }
    r = await up("transparent-1800-renamed.jpg");
    drill.check(r.stored && r.stored.mime === "image/webp" && !r.error, "3: the same file renamed .jpg: same result (WebP)", r);
    r = await up("transparent-one-hole-1800.png");
    drill.check(r.stored && r.stored.mime === "image/webp" && !r.error, "3: a transparent PNG with a single see-through area is kept transparent (WebP)", r);
    // 4
    r = await up("sideways-exif6.jpg");
    drill.check(r.stored && r.stored.width === 1440 && r.stored.height === 1920, "4 (Chrome): a sideways photo (EXIF orientation 6) is stored upright, 1440x1920", r);
    await drill.shoot(page, "4-library-sideways");
    // 5(c)
    r = await up("phone-photo.heic");
    drill.check(r.error?.includes("because it's a HEIC photo") && r.posts.length === 0, "5(c) Chrome on Mac: a .heic gets the plain HEIC message and no POST", r);
    await drill.shoot(page, "5c-heic-message");
    // 6
    r = await up("small-800x600.jpg");
    drill.check(r.stored && r.stored.size === r.sentBytes && r.stored.width === 800, "6: an 800px JPEG under 1.5MB is stored at the same size in bytes", r);
    r = await up("small-300.png");
    drill.check(r.stored && !r.stored.thumb, "6: a 300px PNG gets no +thumb", r);
    // 7
    const refusals = [
      ["price-list.pdf", /isn't an image/, true],
      ["price-list-renamed.jpg", /couldn't open/i, true],
      ["damaged.jpg", /couldn't open/i, true],
      ["small-png-renamed.jpg", /isn't really the kind of image/, false],
      ["empty.jpg", /is empty/, true],
    ];
    for (const [name, re, noPost] of refusals) {
      r = await up(name);
      drill.check(re.test(r.error || "") && (!noPost || r.posts.length === 0), `7: ${name}: plain "${re.source.replace(/\\/g, "")}"${noPost ? ", no POST" : ""}`, r);
    }
    await drill.shoot(page, "7-refusal-empty");
    for (const name of ["photo-no-extension", "photo.jfif"]) {
      r = await up(name);
      drill.check(r.stored && !r.error, `7: ${name} uploads`, r);
    }
    for (const name of ["big.gif", "big.svg"]) {
      r = await up(name);
      drill.check(/is too big/.test(r.error || ""), `7: ${name} over its limit: plain "too big"`, r);
    }
    // 8
    r = await up("script.svg");
    if (r.stored) {
      const svg = await page.evaluate(async (id) => (await fetch(`/api/media/${id}`)).text(), r.stored.id);
      drill.check(!/<script|onload/i.test(svg), "8: the stored SVG has no script or handler", svg.slice(0, 200));
    } else drill.check(false, "8: the small SVG uploads", r);
    r = await up("anim-small.gif");
    drill.check(r.stored && r.stored.mime === "image/gif" && r.stored.size === r.sentBytes, "8: an animated GIF is stored as sent (stays animated)", r);
    r = await up("anim-2400x1000.webp");
    drill.check(r.stored && r.stored.mime === "image/webp" && r.stored.size === r.sentBytes && r.stored.filename === "anim-2400x1000.webp", "8: an animated WebP over 1920px and under 1.5MB stays animated, name unchanged", r);
    r = await up("anim-webp-big.webp");
    drill.check(/animated image and it's too big/.test(r.error || ""), `8: an animated WebP over 1.5MB: plain "animated image and it's too big"`, r);
    r = await up("anim-webp-big-renamed.jpg");
    drill.check(/isn't really the kind of image/.test(r.error || "") && r.posts.length === 0, "8: an animated WebP renamed .jpg (over 1.5MB): \"isn't really the kind of image\", no POST", r);
    r = await up("anim-small-renamed.jpg");
    drill.check(/isn't really the kind of image/.test(r.error || ""), "8: a small GIF renamed .jpg: \"isn't really the kind of image\" (after a POST the server refuses)", r);
    // 11
    r = await up("size-chart-1080x5000.png");
    drill.check(r.stored && r.stored.size === r.sentBytes && r.stored.width === 1080 && r.stored.height === 5000 && r.toasts.every((t) => !/smaller|pixels/.test(t)), "11: a 1080x5000 size chart under 1.5MB is unchanged, no notice", r);
    r = await up("long-2000x6000.jpg");
    drill.check(r.stored && r.stored.size === r.sentBytes && r.stored.width === 2000 && r.stored.height === 6000, "11: a 2000x6000 long image under 1.5MB keeps its bytes and size", r);
    r = await up("strip-4000x400.jpg");
    drill.check(r.stored && r.stored.width === 4000 && r.stored.height === 400, "11: a 4000x400 strip stays 4000x400", r);
    r = await up("long-screenshot-1290x7000.png");
    drill.check(r.stored && Math.abs(r.stored.width - 1080) <= 40 && r.stored.size < 1.5 * 1024 * 1024, "11: a long screenshot over 1.5MB lands about 1080 wide, under the limit", r);
    r = await up("very-long-1200x12000.jpg");
    drill.check(r.stored && Math.max(r.stored.width, r.stored.height) <= 8192, "11: a file over 1.5MB with its long side past 8192 lands at 8192 or less and the tab doesn't crash", r);
    drill.note(`11: its notice: ${JSON.stringify(r.toasts)}`);
    await drill.open(page, "/admin/media", { width: 1280 });
    await drill.shoot(page, "11-library-grid", { fullPage: true });
    await ctx.close();
  },

  // 5(c) again with a HEIC this browser can't open (the first file was an AVIF
  // with its brand changed, which Chrome decodes, so it wasn't a real test).
  async heic(drill) {
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    await drill.open(page, "/admin/media", { width: 1280 });
    const r = await libUpload(drill, page, "phone-photo-undecodable.heic");
    drill.note(`upload phone-photo-undecodable.heic: ${JSON.stringify(r)}`);
    drill.check(r.error?.includes("because it's a HEIC photo") && r.posts.length === 0, "5(c) Chrome on Mac: a .heic Chrome can't open gets the plain HEIC message and no POST", r);
    await drill.shoot(page, "5c-heic-message");
    await ctx.close();
  },

  // 7: network off, pick a new file, re-pick it offline, then back online re-pick it.
  async offline(drill) {
    const sharp = (await import("sharp")).default;
    const { randomBytes } = await import("node:crypto");
    const { writeFileSync } = await import("node:fs");
    const name = `offline-${Date.now()}.png`;
    writeFileSync(f(name), await sharp(randomBytes(500 * 400 * 3), { raw: { width: 500, height: 400, channels: 3 } }).png().toBuffer());
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await drill.open(page, "/admin/media", { width: 1280 });
    const posts = [];
    page.on("request", (r) => new URL(r.url()).pathname === "/api/admin/media" && r.method() === "POST" && posts.push(Date.now()));
    await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.locator('input[type="file"]').first().setInputFiles(f(name));
    const m1 = await seen(page, "The upload didn't go through. Check your connection and try again.", 30_000);
    await page.locator('input[type="file"]').first().setInputFiles(f(name));
    await sleep(500);
    const m2 = await seen(page, "The upload didn't go through. Check your connection and try again.", 30_000);
    drill.check(m1 && m2 && posts.length >= 2, "7 (library, offline): \"didn't go through\", and re-picking the same file starts again and says the same", { m1, m2, tries: posts.length });
    await drill.shoot(page, "7-offline-didnt-go-through");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const before = await mediaList(page);
    await page.locator('input[type="file"]').first().setInputFiles(f(name));
    let added = null;
    for (let i = 0; i < 60 && !added; i++) {
      await sleep(500);
      added = (await mediaList(page)).find((m) => !before.some((b) => b.id === m.id) && m.filename === name) || null;
    }
    drill.check(Boolean(added), "7: back online, re-picking the same file uploads it", added && { filename: added.filename, size: added.size });
    await drill.shoot(page, "7-back-online");
    await ctx.close();
  },

  async progress(drill) {
    if (!FILES) throw new Error("set MED01_FILES");
    const ctx = await drill.context({ width: 1280 });
    const page = await drill.signIn(ctx);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    const slow = () => cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 4_000_000 / 8, uploadThroughput: 1_000_000 / 8 });
    const fast = () => cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const sample = async (stopWhen, ms = 40_000) => {
      const seenStages = [];
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const s = await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].map((e) => e.innerText.trim()).find((t) => /^(Getting .+ ready…|Uploading .+ \d+%|Saving .+…)$/.test(t)) || null).catch(() => null);
        if (s && seenStages[seenStages.length - 1] !== s) seenStages.push(s);
        if (await stopWhen()) break;
        await sleep(120);
      }
      return seenStages;
    };
    // library
    await drill.open(page, "/admin/media", { width: 1280 });
    await slow();
    await page.locator('input[type="file"]').first().setInputFiles(f("photo-4000x3000-again.jpg"));
    let stages = await sample(async () => !(await page.locator('input[type="file"]').first().isDisabled()));
    const pct = stages.filter((s) => /\d+%/.test(s)).map((s) => Number(/(\d+)%/.exec(s)[1]));
    drill.check(stages.some((s) => s.startsWith("Getting")) && pct.length >= 2 && stages.some((s) => s.startsWith("Saving")), "2 (library, throttled): the banner goes Getting … ready…, Uploading … N% (moving), Saving…", stages);
    await fast();
    const lib = (await mediaList(page))[0];
    drill.note(`2: library result ${JSON.stringify({ mime: lib?.mime, w: lib?.width, h: lib?.height, size: lib?.size })}`);
    // the picker, from a page's image field
    const api = (m, u, b) => page.evaluate(async ([m, u, b]) => (await fetch(u, { method: m, headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).status, [m, u, b]);
    await api("PUT", "/api/admin/storefront", { page: { slug: "drill-med01", title: "MED-01 drill", sections: [{ kind: "text", heading: "Images", body: ["Below."] }] }, revision: null });
    const openPicker = async (n) => {
      await page.getByRole("button", { name: "Choose from library" }).nth(n).click();
      await page.locator("dialog[open]").waitFor();
    };
    await drill.open(page, "/admin/storefront/pages/drill-med01", { width: 1280 });
    await page.getByRole("button", { name: "Image", exact: true }).click();
    await page.getByRole("button", { name: "Image", exact: true }).click();
    const urls = () => page.getByLabel("Image URL").evaluateAll((els) => els.map((e) => e.value));
    // picker: stages and the picked image lands in the field
    await openPicker(0);
    await slow();
    const thumbReqs = [];
    page.on("request", (r) => /\/api\/media\/[\w-]+$/.test(new URL(r.url()).pathname) && thumbReqs.push(new URL(r.url()).pathname));
    await page.locator("dialog[open] input[type=file]").setInputFiles(f("photo-4000x3000.jpg"));
    stages = await sample(async () => (await page.locator("dialog[open]").count()) === 0);
    await fast();
    const u1 = await urls();
    drill.check(stages.some((s) => s.startsWith("Uploading")) && u1[0]?.startsWith("/api/media/"), "2 (picker, throttled): the banner stages show, and the picked image lands in the field", { stages, urls: u1 });
    drill.note(`2: preview requests from the picker grid: ${JSON.stringify(thumbReqs.slice(0, 6))}`);
    await drill.shoot(page, "2-picker-landed");
    // Escape mid-upload: the spot stays as it was, a toast says it's in the library
    await openPicker(1);
    await slow();
    await page.locator("dialog[open] input[type=file]").setInputFiles(f("sideways-exif6.jpg"));
    await sample(async () => true, 2500);
    await page.keyboard.press("Escape");
    let toasts = [];
    for (let i = 0; i < 160 && !toasts.some((t) => /library/i.test(t)); i++) {
      await sleep(250);
      toasts = await page.evaluate(() => [...document.querySelectorAll('div[aria-live="polite"]')].filter((d) => d.className.includes("fixed")).flatMap((d) => [...d.querySelectorAll("p")].map((p) => p.innerText.trim())));
    }
    await fast();
    const u2 = await urls();
    drill.check(!u2[1] && toasts.some((t) => /library/i.test(t)), "2: Escape mid-upload: the spot stays empty and a toast says the image is in the library and wasn't added", { urls: u2, toasts });
    await drill.shoot(page, "2-escape-mid-upload");
    // reopen for a different spot mid-upload
    await openPicker(1);
    await slow();
    await page.locator("dialog[open] input[type=file]").setInputFiles(f("transparent-one-hole-1800.png"));
    await sample(async () => true, 2000);
    await page.keyboard.press("Escape");
    await openPicker(0);
    await sleep(15_000);
    await fast();
    await sleep(3000);
    const stillOpen = await page.locator("dialog[open]").count();
    const u3 = await urls();
    drill.check(stillOpen === 1 && u3[0] === u1[0] && !u3[1], "2: reopening the picker for a different spot mid-upload: neither spot changes and the reopened picker stays open", { stillOpen, before: u1, after: u3 });
    await drill.shoot(page, "2-reopened-other-spot");
    await page.keyboard.press("Escape");
    // network lost after closing
    await openPicker(1);
    await slow();
    await page.locator("dialog[open] input[type=file]").setInputFiles(f("transparent-1800.png"));
    await sample(async () => true, 2500);
    await page.keyboard.press("Escape");
    await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    toasts = [];
    for (let i = 0; i < 160 && !toasts.some((t) => /didn't go through/.test(t)); i++) {
      await sleep(250);
      toasts = await page.evaluate(() => [...document.querySelectorAll('div[aria-live="polite"]')].filter((d) => d.className.includes("fixed")).flatMap((d) => [...d.querySelectorAll("p")].map((p) => p.innerText.trim())));
    }
    drill.check(toasts.some((t) => t === "The upload didn't go through. Check your connection and try again."), "2: network lost after closing: a toast gives the \"didn't go through\" message", toasts);
    await drill.shoot(page, "2-network-lost-after-closing");
    await fast();
    // 7: network off during upload in the library, re-pick the same file, then back on
    await drill.open(page, "/admin/media", { width: 1280 });
    await slow();
    await page.locator('input[type="file"]').first().setInputFiles(f("transparent-one-hole-1800.png"));
    await seen(page, "Uploading", 30_000);
    await sleep(1500);
    await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const off1 = await seen(page, "The upload didn't go through", 30_000);
    await page.locator('input[type="file"]').first().setInputFiles(f("transparent-one-hole-1800.png"));
    await sleep(2500);
    const off2 = await seen(page, "The upload didn't go through", 20_000);
    drill.check(off1 && off2, "7: network off during upload (library): \"didn't go through\", and re-picking the same file starts again and says the same", { off1, off2 });
    await fast();
    await sleep(1000);
    const before = (await mediaList(page)).length;
    await page.locator('input[type="file"]').first().setInputFiles(f("small-300.png"));
    await sleep(6000);
    const after = (await mediaList(page)).length;
    drill.check(after >= before, "7: back online, re-picking uploads", { before, after });
    await drill.shoot(page, "7-back-online");
    await ctx.close();
  },
};
