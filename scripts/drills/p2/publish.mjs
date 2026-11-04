// P2-DRILLS parts on a published documents store (v4): the hero image
// (DOC-07), a policy fix published while the home draft is dirty (PUB-01,
// DOC-05), the error page's neutral chrome on a corrupted live list (PUB-01),
// and the edge runtime header on the v4 storefront routes (PERF-01's routes).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DrillError } from "../../drill.js";
import { reseed, getDoc, saveDraft, publishDoc, docsApi, uploadPhoto, noThanks, bodyText, tenantSql, sleep } from "./run.mjs";

export const parts = {};

const SCRATCH = process.env.DRILL_SCRATCH || join(process.cwd(), ".design-data", "p2-drills");
const HTTPS_PORT = Number(process.env.DRILL_HTTPS_PORT || 4806);

const firstDiff = (a, b) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i >= a.length && i >= b.length ? null : { at: i, before: a.slice(Math.max(0, i - 40), i + 60), after: b.slice(Math.max(0, i - 40), i + 60) };
};
const heroOf = (body) => body.sections.find((s) => s.kind === "hero");

async function jpeg(w, h, label) {
  const sharp = (await import("sharp")).default;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#7c3aed"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 3}" fill="#fde68a"/><text x="50%" y="92%" font-family="Helvetica" font-size="${Math.round(h / 12)}" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 75 }).toBuffer();
}

// A local https server with a self-signed certificate: a hero photo from a host
// that isn't the Shopify CDN, without reaching the internet.
async function httpsPhotoServer() {
  mkdirSync(SCRATCH, { recursive: true });
  const key = join(SCRATCH, "https-key.pem");
  const cert = join(SCRATCH, "https-cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost"], { stdio: "ignore" });
    if (r.status !== 0) throw new DrillError("openssl couldn't make a local test certificate");
  }
  const https = await import("node:https");
  const bytes = await jpeg(1200, 900, "https photo");
  const hits = [];
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    hits.push(req.url);
    if (req.url === "/hero.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": bytes.length });
      res.end(bytes);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r, j) => server.once("error", j).listen(HTTPS_PORT, "127.0.0.1", r));
  return { url: `https://localhost:${HTTPS_PORT}/hero.jpg`, hits, close: () => new Promise((r) => server.close(r)) };
}

// Publish a hero image (media + alt) through the API, then look at it signed out.
async function heroImageCase(drill, admin, { media, alt, label, expectLibrary, shopperOpts = {} }) {
  const doc = await getDoc(admin, "doc_home");
  const body = structuredClone(doc.body);
  const hero = heroOf(body);
  hero.settings.image = { media, alt };
  const save = await saveDraft(admin, doc, body);
  const pub = save.status === 200 ? await publishDoc(admin, save.body.document) : null;
  drill.check(save.status === 200 && pub?.status === 200, `${label}: the hero image is saved and published through PUT /api/admin/documents`, { save: save.status, publish: pub?.status, issues: (pub?.body?.issues || save.body?.issues || []).filter((i) => i.severity === "error").slice(0, 3) });
  const sctx = await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width: 1440, height: 900 }, ...shopperOpts });
  const page = await sctx.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  for (const width of [1440, 375]) {
    const res = await drill.open(page, "/", { width });
    await noThanks(page);
    await page.waitForTimeout(500);
    const img = await page.evaluate(() => {
      const root = document.querySelector('[data-section-kind="hero"]');
      const i = root?.querySelector("img");
      return i ? { src: i.getAttribute("src"), currentSrc: i.currentSrc, alt: i.getAttribute("alt"), complete: i.complete, naturalWidth: i.naturalWidth, srcset: i.getAttribute("srcset") } : null;
    });
    drill.check(res.status === 200 && res.headers["x-edge-runtime"] === "1", `${label} at ${width}: home answers 200 on the edge runtime`, { status: res.status });
    drill.check(img && img.alt === alt, `${label} at ${width}: the hero renders the image with its alt text`, img);
    drill.check(img && img.complete && img.naturalWidth > 0, `${label} at ${width}: the image loaded (not broken)`, img && { naturalWidth: img.naturalWidth, currentSrc: img.currentSrc });
    if (expectLibrary) drill.check(img?.src === media, `${label} at ${width}: a library photo is served from its own /api/media url`, img?.src);
    else {
      drill.check(img?.src === media && !String(img?.currentSrc).includes("/_next/image"), `${label} at ${width}: a photo off the Shopify CDN loads from its own url, not /_next/image`, { src: img?.src, currentSrc: img?.currentSrc });
    }
    await drill.shoot(page, `hero-image-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${width}`);
  }
  drill.check(!requests.some((u) => u.includes("/_next/image") && u.includes(encodeURIComponent(media))), `${label}: no /_next/image request for the hero photo`, requests.filter((u) => u.includes("/_next/image")).slice(0, 3));
  await sctx.close();
}

parts["hero-image"] = async (drill) => {
  await reseed(drill);
  const ctx = await drill.context({ width: 1440 });
  const admin = await drill.signIn(ctx);
  // 1. a library photo uploaded through the console's media route
  const bytes = await jpeg(1600, 1200, "hero photo");
  const up = await uploadPhoto(admin, { bytesBase64: bytes.toString("base64"), filename: "p2-drill-hero.jpg", mime: "image/jpeg", alt: "A jar on linen in morning light", width: 1600, height: 1200 });
  const url = up.body?.media?.url || up.body?.url || (up.body?.media?.id ? `/api/media/${up.body.media.id}` : null) || (up.body?.id ? `/api/media/${up.body.id}` : null);
  drill.check(up.status === 200 && typeof url === "string" && url.startsWith("/api/media/"), "a hero photo is uploaded to the media library (POST /api/admin/media)", { status: up.status, url });
  if (url) await heroImageCase(drill, admin, { media: url, alt: "A jar on linen in morning light", label: "library photo", expectLibrary: true });
  // 2. a "/" path that isn't the library (a file the store serves itself)
  await heroImageCase(drill, admin, { media: "/icons/icon-512.png", alt: "The store's own icon, as a hero photo", label: "own path photo", expectLibrary: false });
  // 3. an https photo from another host (a local server with a test certificate)
  const srv = await httpsPhotoServer();
  try {
    await heroImageCase(drill, admin, { media: srv.url, alt: "A photo from another https host", label: "https photo off the Shopify CDN", expectLibrary: false, shopperOpts: { ignoreHTTPSErrors: true } });
    drill.check(srv.hits.includes("/hero.jpg"), "the browser fetched the https photo straight from its host", srv.hits.slice(0, 5));
  } finally {
    await srv.close();
  }
  await ctx.close();
};

parts["policy-typo"] = async (drill) => {
  await reseed(drill);
  const ctx = await drill.context({ width: 1440 });
  const admin = await drill.signIn(ctx);
  const list = await docsApi(admin, { listDocuments: { type: "page" } });
  const ship = (list.body?.documents || []).find((d) => d.slug === "shipping");
  if (!ship) throw new DrillError("the fixture has no shipping page document");
  const TYPO = "Orders dispach within 24 hours on business days.";
  const FIXED = "Orders dispatch within 24 hours on business days.";
  // the typo goes live first (setup)
  {
    const doc = await getDoc(admin, ship.id);
    const body = structuredClone(doc.body);
    body.sections[0].settings.body = [TYPO];
    const s = await saveDraft(admin, doc, body);
    const p = await publishDoc(admin, s.body.document);
    drill.check(s.status === 200 && p.status === 200, "setup: a shipping page with a typo is live", { save: s.status, publish: p.status });
  }
  const shopper = await (await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width: 1440, height: 900 } })).newPage();
  await drill.open(shopper, "/");
  await noThanks(shopper);
  const homeBefore = await shopper.evaluate(() => ({ text: (document.querySelector("main")?.textContent || "").replace(/\s+/g, " ").trim(), sections: [...document.querySelectorAll("[data-section-id]")].map((e) => e.getAttribute("data-section-id")) }));
  const shipBefore = await drill.open(shopper, "/policies/shipping").then(() => bodyText(shopper));
  drill.check(shipBefore.includes(TYPO), "a shopper sees the typo on /policies/shipping before the fix", TYPO);

  // the home draft: dirty (a new hero title) and incomplete (an empty banner)
  const home = await getDoc(admin, "doc_home");
  const hb = structuredClone(home.body);
  heroOf(hb).settings.title = "DRAFT ONLY: a hero title nobody published";
  hb.sections.push({ id: "sec_drillbanner", kind: "banner", v: 1, enabled: true, settings: { title: "", text: "", button: null } });
  const hs = await saveDraft(admin, home, hb);
  const incomplete = (hs.body?.issues || []).some((i) => i.sectionId === "sec_drillbanner" && (i.severity === "incomplete" || i.cls === "incomplete" || /REQUIRED|EMPTY|INCOMPLETE/.test(i.code || "")));
  drill.check(hs.status === 200, "the home draft is saved dirty and incomplete (an empty banner)", { status: hs.status, issues: (hs.body?.issues || []).map((i) => `${i.sectionId}:${i.field}:${i.code}:${i.severity}`).slice(0, 6) });
  drill.note(`home draft issues reported at save: ${JSON.stringify((hs.body?.issues || []).map((i) => `${i.sectionId}:${i.field}:${i.code}:${i.severity}`))} (empty banner flagged: ${incomplete})`);

  // the policy fix, published alone
  const doc = await getDoc(admin, ship.id);
  const body = structuredClone(doc.body);
  body.sections[0].settings.body = [FIXED];
  const s = await saveDraft(admin, doc, body);
  const p = await publishDoc(admin, s.body.document);
  drill.check(p.status === 200 && p.body.published?.length === 1 && p.body.published.every((x) => (x.id || x.documentId || x) === ship.id || JSON.stringify(x).includes(ship.id)), "the policy fix publishes on its own (200, one document)", { status: p.status, published: p.body?.published, code: p.body?.code });

  const shipAfter = await drill.open(shopper, "/policies/shipping").then(() => bodyText(shopper));
  drill.check(shipAfter.includes(FIXED) && !shipAfter.includes(TYPO), "a shopper sees the fixed text on /policies/shipping", FIXED);
  await drill.shoot(shopper, "policy-typo-fixed-1440");
  await drill.open(shopper, "/");
  const homeAfter = await shopper.evaluate(() => ({ text: (document.querySelector("main")?.textContent || "").replace(/\s+/g, " ").trim(), sections: [...document.querySelectorAll("[data-section-id]")].map((e) => e.getAttribute("data-section-id")) }));
  drill.check(homeAfter.text === homeBefore.text && JSON.stringify(homeAfter.sections) === JSON.stringify(homeBefore.sections), "home is live exactly as before (same text, same sections)", { before: homeBefore.sections.length, after: homeAfter.sections.length, firstDifference: firstDiff(homeBefore.text, homeAfter.text) });
  drill.check(!homeAfter.text.includes("DRAFT ONLY") && !homeAfter.text.includes("not finished yet"), "home shows neither the draft title nor an unfinished note", null);
  await drill.shoot(shopper, "policy-typo-home-1440");
  const h = await getDoc(admin, "doc_home");
  drill.check(h.draftHash !== h.publishedHash && h.body.sections.some((x) => x.id === "sec_drillbanner"), "the home draft is still there, dirty, with its unfinished banner", { draftHash: h.draftHash?.slice(0, 12), publishedHash: h.publishedHash?.slice(0, 12) });
  await shopper.context().close();
  await ctx.close();
};

// The store's own chrome on the page: header, footer and any nav, as links and text.
const chromeOf = (page) =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll("header, footer, nav")];
    return { links: [...new Set(els.flatMap((e) => [...e.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))))], text: els.map((e) => e.innerText).join(" ") };
  });
const STORE_LINK = /^\/(collections\/|policies\/|journal|campaigns\/|products\/)/;

parts["error-chrome"] = async (drill) => {
  await reseed(drill);
  const [live] = await tenantSql(["SELECT r.id, r.content FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1"]);
  const { id, content } = live.rows[0];
  const list = JSON.parse(content);
  drill.check(list.v === 4 && list.documents?.doc_header && list.documents?.doc_home, "the live release is a v4 list that names doc_header and doc_home", { v: list.v });
  const shopper = await (await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width: 1440, height: 900 } })).newPage();
  await drill.open(shopper, "/");
  await noThanks(shopper);
  const healthy = await chromeOf(shopper);
  drill.check((await bodyText(shopper)).includes("Festive sale") && healthy.links.some((h) => STORE_LINK.test(h)), "before: the live store shows its announcement and its own menus", { menuLinks: healthy.links.filter((h) => STORE_LINK.test(h)).length });
  const corrupt = async (ids) => {
    const bad = structuredClone(list);
    for (const d of ids) bad.documents[d] = { ...bad.documents[d], version: "ver_0000000000000000" };
    await tenantSql([{ sql: "UPDATE releases SET content = ? WHERE id = ?", args: [JSON.stringify(bad), id] }]);
  };
  try {
    // 1. the home page's own version and the header's are missing: the error page, neutral chrome
    await corrupt(["doc_home", "doc_header"]);
    for (const width of [1440, 375]) {
      const res = await drill.open(shopper, "/", { width });
      const f = await drill.facts(shopper);
      const chrome = await chromeOf(shopper);
      drill.check(f.errorPage, `/ at ${width} (doc_home and doc_header versions missing): the error page shows`, { status: res.status, h1: f.h1 });
      drill.check(!f.text.includes("Festive sale"), `/ at ${width}: no announcement`, null);
      drill.check(!chrome.links.some((h) => STORE_LINK.test(h)) && !/Protein|Skincare|Vitamins|Snacks/.test(chrome.text), `/ at ${width}: neutral chrome, no default nav (no collection list, no store menus)`, { links: chrome.links });
      drill.check(!/Design Demo Co/.test(chrome.text), `/ at ${width}: the chrome doesn't carry the store's brand name`, chrome.text.slice(0, 120));
      drill.note(`/ at ${width} corrupted: status ${res.status}, chrome links ${JSON.stringify(chrome.links)}`);
      await drill.shoot(shopper, `error-chrome-home-${width}`);
    }
    // 2. only a chrome document's version missing: what a shopper gets on other pages (recorded)
    await corrupt(["doc_header"]);
    for (const path of ["/policies/shipping", "/"]) {
      const res = await drill.open(shopper, path, { width: 1440 });
      const f = await drill.facts(shopper);
      const chrome = await chromeOf(shopper);
      drill.check(!chrome.links.some((h) => STORE_LINK.test(h)) && !f.text.includes("Festive sale"), `${path} (only doc_header's version missing): the chrome is neutral, no announcement, no store menus`, { links: chrome.links });
      drill.note(`${path} with only doc_header's version missing: status ${res.status}, error page ${f.errorPage}, h1 ${JSON.stringify(f.h1)}`);
      await drill.shoot(shopper, `error-chrome-header-only${path === "/" ? "-home" : path.replace(/\//g, "-")}-1440`);
    }
  } finally {
    await tenantSql([{ sql: "UPDATE releases SET content = ? WHERE id = ?", args: [content, id] }]);
  }
  await drill.open(shopper, "/");
  drill.check((await bodyText(shopper)).includes("Festive sale"), "after putting the list back, the store shows again", null);
  await shopper.context().close();
};

parts.edge = async (drill) => {
  await reseed(drill);
  const [st] = await tenantSql(["SELECT json_extract(r.content, '$.v') AS v, json_extract(r.content, '$.pages') AS pages FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1"]);
  drill.check(Number(st.rows[0]?.v) === 4, "the harness store's live release is v4", st.rows[0]?.v);
  const [docs] = await tenantSql(["SELECT type, slug FROM documents WHERE slug IS NOT NULL ORDER BY type, slug"]);
  const first = (t) => docs.rows.find((r) => r.type === t)?.slug;
  const [prod] = await tenantSql(["SELECT p.handle FROM products p WHERE p.available = 1 AND p.handle NOT LIKE 'worst-case-%' ORDER BY p.handle LIMIT 1"]);
  const [coll] = await tenantSql(["SELECT c.handle FROM collections c JOIN collection_products cp ON cp.collection_id = c.id WHERE c.handle NOT LIKE 'worst-case-%' GROUP BY c.handle ORDER BY c.handle LIMIT 1"]);
  const routes = [
    ["home", "/"],
    ["policy page", "/policies/shipping"],
    ["page", `/policies/${first("page")}`],
    ["campaign", `/campaigns/${first("campaign")}`],
    ["journal", "/journal"],
    ["journal post", `/journal/${first("journal")}`],
    ["collections", "/collections"],
    ["collection", `/collections/${coll.rows[0].handle}`],
    ["product", `/products/${prod.rows[0].handle}`],
    ["search", "/search?q=protein"],
    ["contact", "/contact"],
    ["unknown page (404)", "/policies/no-such-page-here"],
  ];
  const ctx = await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  for (const [name, path] of routes) {
    const res = await drill.open(page, path);
    const f = await drill.facts(page);
    const want = name.includes("404") ? 404 : 200;
    drill.check(res.headers["x-edge-runtime"] === "1", `${name} ${path}: x-edge-runtime: 1`, { status: res.status, header: res.headers["x-edge-runtime"] ?? null });
    drill.check(res.status === want && !f.errorPage, `${name} ${path}: ${want}, not the error page`, { status: res.status, h1: f.h1 });
  }
  await ctx.close();
  await sleep(0);
};

