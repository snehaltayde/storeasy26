// P2-DRILLS part "sections" (DOC-03): every registered section kind, against
// its worstCase(kind) fixture from lib/registry/fixtures.js, at 375, 768 and
// 1440 wide, through the real storefront on the design harness.
//
// Each kind's cases (a 120-character title and long names, no image, a tall
// image, one item, the maximum, sold out: whichever the kind can have) are
// saved into doc_home through the documents API and published. The catalog
// they bind to is the worst-case catalog seed-design-documents.js adds
// (--worst-case). Each case's section gets its own id. The sold-out cases are
// published on their own, with every product in the store marked sold out for
// that look (put back afterwards). Text, rich text, image with text and FAQ
// also run on a content page (their page look), and product_main, which the
// product route still renders itself, is checked on the worst-case product
// pages.
//
// At each width: the page doesn't scroll sideways (scrollWidth <= innerWidth),
// every case's section is on the page, no text runs past the window outside a
// scroller, and no text is cut off by a box that hides its overflow. Text cut
// with an ellipsis or a line clamp is truncation by design: it is counted and
// listed in the notes, not failed.
import { WIDTHS } from "../../drill.js";
import { reseed, getDoc, saveDraft, publishDoc, docsApi, noThanks, tenantSql, settle } from "./run.mjs";

export const parts = {};

const TAG = { hero: "hr", collections: "co", new: "nw", banner: "bn", rich_text: "rt", image_with_text: "iw", product_rail: "pr", text: "tx", faq: "fq" };
const PAGE_KINDS = ["text", "rich_text", "image_with_text", "faq"];

// Inside the page: facts about each section and the page.
function measure(ids) {
  const vw = window.innerWidth;
  const out = { vw, scrollWidth: document.documentElement.scrollWidth, sections: {} };
  const scrollerOf = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (["auto", "scroll"].includes(s.overflowX)) return a;
    }
    return null;
  };
  for (const id of ids) {
    const root = document.querySelector(`[data-section-id="${CSS.escape(id)}"]`);
    if (!root) {
      out.sections[id] = { present: false };
      continue;
    }
    const r = root.getBoundingClientRect();
    const f = { present: true, kind: root.getAttribute("data-section-kind"), width: Math.round(r.width), height: Math.round(r.height), offscreen: [], clipped: [], truncated: [], brokenImages: [], images: 0 };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const txt = n.textContent.trim();
      if (!txt) continue;
      const el = n.parentElement;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
      if (!rects.length) continue;
      const label = `${el.tagName.toLowerCase()}: ${txt.slice(0, 40)}`;
      // past the window, and not inside a sideways scroller (where it is reachable)
      if (!scrollerOf(el) && rects.some((t) => t.right > vw + 1 || t.left < -1)) f.offscreen.push(label);
      // cut by an ancestor that hides its overflow
      let ellipsis = false;
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        if ((s.webkitLineClamp && s.webkitLineClamp !== "none") || s.textOverflow === "ellipsis") ellipsis = true;
        if (["auto", "scroll"].includes(s.overflowX) || ["auto", "scroll"].includes(s.overflowY)) break;
        const cx = ["hidden", "clip"].includes(s.overflowX);
        const cy = ["hidden", "clip"].includes(s.overflowY);
        if (!cx && !cy) continue;
        const b = a.getBoundingClientRect();
        if (b.width <= 2 || b.height <= 2) break; // a visually hidden (sr-only) label
        const cut = rects.some((t) => (cx && (t.right > b.right + 1 || t.left < b.left - 1)) || (cy && (t.bottom > b.bottom + 1 || t.top < b.top - 1)));
        const own = a === el && ((cx && a.scrollWidth > a.clientWidth + 1) || (cy && a.scrollHeight > a.clientHeight + 1));
        if (cut || own) {
          (ellipsis ? f.truncated : f.clipped).push(label);
          break;
        }
      }
    }
    for (const img of root.querySelectorAll("img")) {
      f.images++;
      if (img.complete && img.naturalWidth === 0) f.brokenImages.push(img.currentSrc || img.src);
    }
    f.text = root.innerText.slice(0, 200);
    out.sections[id] = f;
  }
  return out;
}

// Wait until every image on the page has loaded (lazy ones are scrolled to).
async function loadAll(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, window.innerHeight - 100);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => ((i.onload = i.onerror = r), setTimeout(r, 8000)))));
  });
  await page.waitForTimeout(300);
}

function checkAt(drill, name, width, facts, cases) {
  drill.check(facts.scrollWidth <= facts.vw, `${name} at ${width}: no sideways scroll (scrollWidth ${facts.scrollWidth} <= innerWidth ${facts.vw})`, { scrollWidth: facts.scrollWidth, innerWidth: facts.vw });
  for (const c of cases) {
    const f = facts.sections[c.id];
    if (!f?.present) {
      drill.check(false, `${name} at ${width}: ${c.name} (${c.id}) is on the page`, f);
      continue;
    }
    drill.check(f.offscreen.length === 0, `${name} at ${width}: ${c.name}: no text past the window`, f.offscreen.slice(0, 5));
    drill.check(f.clipped.length === 0, `${name} at ${width}: ${c.name}: no clipped text`, f.clipped.slice(0, 5));
    drill.check(f.brokenImages.length === 0, `${name} at ${width}: ${c.name}: no broken image`, f.brokenImages);
    if (f.truncated.length) drill.note(`${name} at ${width}: ${c.name}: ${f.truncated.length} text(s) cut with an ellipsis or a line clamp by design, e.g. ${JSON.stringify(f.truncated.slice(0, 2))}`);
  }
}

// One kind's cases as sections with their own ids, the fixture photos swapped
// for the seeded ones.
async function casesFor(kind, F, media) {
  const { cases } = F.worstCase(kind);
  return cases.map((c, i) => ({ name: c.name, id: `sec_${TAG[kind] || "pm"}${i}${c.name.replace(/_/g, "").slice(0, 8)}`.slice(0, 20), section: media({ ...c.section, id: `sec_${TAG[kind] || "pm"}${i}${c.name.replace(/_/g, "").slice(0, 8)}`.slice(0, 20) }) }));
}

async function publishHome(drill, page, sections, label) {
  const doc = await getDoc(page, "doc_home");
  const body = structuredClone(doc.body);
  body.sections = sections;
  const save = await saveDraft(page, doc, body);
  if (save.status !== 200) {
    drill.check(false, `${label}: the home draft saves`, { status: save.status, body: JSON.stringify(save.body).slice(0, 600) });
    return false;
  }
  const pub = await publishDoc(page, save.body.document);
  drill.check(pub.status === 200 && pub.body?.published?.length === 1, `${label}: published through the documents API`, pub.status === 200 ? { release: pub.body.release?.id } : { status: pub.status, body: JSON.stringify(pub.body).slice(0, 600) });
  return pub.status === 200;
}

async function lookAt(drill, page, path, name, cases, { shoot = true } = {}) {
  for (const width of WIDTHS) {
    const res = await drill.open(page, path, { width });
    await noThanks(page);
    await loadAll(page);
    const facts = await page.evaluate(measure, cases.map((c) => c.id));
    drill.check(res.status === 200 && res.headers["x-edge-runtime"] === "1", `${name} at ${width}: 200 on the edge runtime`, { status: res.status, edge: res.headers["x-edge-runtime"] });
    checkAt(drill, name, width, facts, cases);
    if (shoot) {
      // the first case's section at the top of the window (full pages scale down too far to read)
      await page.evaluate((id) => document.querySelector(`[data-section-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" }), cases[0].id);
      await page.waitForTimeout(250);
      await drill.shoot(page, `sections-${name}-${width}`);
    }
  }
}

// Every product in the store sold out, for the sold-out look; returns a restore function.
async function allSoldOut() {
  const [p] = await tenantSql(["SELECT id FROM products WHERE available = 1"]);
  const ids = p.rows.map((r) => r.id);
  await tenantSql(["UPDATE products SET available = 0", "UPDATE variants SET available = 0"]);
  return async () => {
    const stmts = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const q = chunk.map(() => "?").join(",");
      stmts.push({ sql: `UPDATE products SET available = 1 WHERE id IN (${q})`, args: chunk }, { sql: `UPDATE variants SET available = 1 WHERE product_id IN (${q})`, args: chunk });
    }
    await tenantSql(stmts);
  };
}

parts.sections = async (drill) => {
  await reseed(drill, ["--worst-case"]);
  const F = await import("../../../lib/registry/fixtures.js");
  const R = await import("../../../lib/registry/index.js");
  const { withSeededMedia } = await import("../../seed-design-documents.js");
  const media = (v) => withSeededMedia(v);
  const kinds = R.sectionKinds();
  drill.note(`registered section kinds: ${kinds.join(", ")}`);
  const ctx = await drill.context({ width: 1440 });
  const admin = await drill.signIn(ctx);
  const shopper = await (await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width: 1440, height: 900 } })).newPage();
  const covered = new Set();

  for (const kind of kinds) {
    if (kind === "product_main") continue;
    const cases = await casesFor(kind, F, media);
    if (kind === "hero") {
      // One hero per home page: each case on its own. The seeded store runs a
      // hero test whose variant b replaces the title, so it is paused while
      // the hero cases are looked at (and running again afterwards).
      const [running] = await tenantSql(["SELECT slug FROM experiments WHERE status = 'running'"]);
      const slugs = running.rows.map((r) => r.slug);
      await tenantSql(slugs.map((slug) => ({ sql: "UPDATE experiments SET status = 'paused' WHERE slug = ?", args: [slug] })));
      try {
        for (const c of cases) {
          if (!(await publishHome(drill, admin, [c.section], `hero ${c.name}`))) continue;
          await lookAt(drill, shopper, "/", `hero-${c.name}`, [c]);
          const h1 = await shopper.evaluate(() => document.querySelector("h1")?.innerText || "");
          drill.check(h1.replace(/\s+/g, " ").trim() === c.section.settings.title, `hero ${c.name}: the shopper sees the case's own ${c.section.settings.title.length}-character title`, h1.slice(0, 130));
        }
      } finally {
        await tenantSql(slugs.map((slug) => ({ sql: "UPDATE experiments SET status = 'running' WHERE slug = ?", args: [slug] })));
      }
      covered.add(kind);
      continue;
    }
    // A required image left empty can't be published (the registry refuses
    // it), so shoppers can't meet it on a documents store: check the refusal.
    const refused = cases.filter((c) => c.name === "no_image" && R.sectionType(kind).settings.some((s) => s.kind === "image" && s.required));
    for (const c of refused) {
      const doc = await getDoc(admin, "doc_home");
      const save = await saveDraft(admin, doc, { ...doc.body, sections: [c.section] });
      const pub = save.status === 200 ? await publishDoc(admin, save.body.document) : null;
      const req = (pub?.body?.issues || []).some((i) => i.sectionId === c.id && i.field === "image" && i.code === "REQUIRED" && i.severity === "error");
      drill.check(save.status === 200 && pub?.status === 422 && req, `${kind} no_image: the draft saves, and publishing it is refused (the image is required), so shoppers never get an empty one`, { save: save.status, publish: pub?.status, code: pub?.body?.code });
      drill.note(`${kind} no_image can't reach shoppers on a documents store (publish refuses it); its fallback look is covered by test-sections-render §4, not by this drill`);
    }
    const normal = cases.filter((c) => c.name !== "sold_out" && !refused.includes(c));
    const sold = cases.filter((c) => c.name === "sold_out");
    if (await publishHome(drill, admin, normal.map((c) => c.section), `${kind} (${normal.map((c) => c.name).join(", ")})`)) await lookAt(drill, shopper, "/", kind, normal);
    if (sold.length) {
      const restore = await allSoldOut();
      try {
        if (await publishHome(drill, admin, sold.map((c) => c.section), `${kind} sold_out`)) await lookAt(drill, shopper, "/", `${kind}-sold-out`, sold);
        const t = await shopper.evaluate((id) => document.querySelector(`[data-section-id="${CSS.escape(id)}"]`)?.innerText || "", sold[0].id);
        drill.check(/sold out/i.test(t), `${kind} sold_out: the cards say "Sold out"`, t.slice(0, 160));
      } finally {
        await restore();
      }
    }
    covered.add(kind);
  }

  // The page look of the kinds a content page renders: one page, all their cases.
  {
    const sections = [];
    const cases = [];
    for (const kind of PAGE_KINDS) for (const c of await casesFor(kind, F, media)) {
      if (c.name === "no_image" && R.sectionType(kind).settings.some((s) => s.kind === "image" && s.required)) continue; // refused at publish (above)
      const id = `sec_pg${c.id.slice(4, 18)}`;
      sections.push({ ...c.section, id });
      cases.push({ ...c, id, name: `${kind} ${c.name}` });
    }
    const body = F.fixtureDocument("page", sections);
    const made = await docsApi(admin, { createDocument: { type: "page", body } });
    if (made.status !== 200) drill.check(false, "a worst-case content page is created", { status: made.status, body: JSON.stringify(made.body).slice(0, 600) });
    else {
      const pub = await publishDoc(admin, made.body.document);
      drill.check(pub.status === 200, "the worst-case content page is published", pub.status === 200 ? { release: pub.body.release?.id } : { status: pub.status, body: JSON.stringify(pub.body).slice(0, 600) });
      await lookAt(drill, shopper, `/policies/${body.meta.slug}`, "page-kinds", cases);
    }
  }

  // product_main: the product route renders the product itself (P2-SECTIONS
  // known limit), so its worst cases are the worst-case product pages.
  {
    const pages = [
      ["product-long-wide", "/products/worst-case-product-0"],
      ["product-tall", "/products/worst-case-product-1"],
      ["product-no-image", "/products/worst-case-product-2"],
      ["product-sold-out", `/products/worst-case-product-23`],
    ];
    for (const [name, path] of pages) {
      for (const width of WIDTHS) {
        const res = await drill.open(shopper, path, { width });
        await noThanks(shopper);
        await loadAll(shopper);
        const f = await drill.facts(shopper);
        const clip = await shopper.evaluate(measureMain);
        drill.check(res.status === 200 && res.headers["x-edge-runtime"] === "1" && !f.errorPage, `product_main ${name} at ${width}: 200 on the edge runtime, not an error page`, { status: res.status });
        drill.check(f.scrollWidth <= f.viewport, `product_main ${name} at ${width}: no sideways scroll`, { scrollWidth: f.scrollWidth, innerWidth: f.viewport });
        drill.check(clip.clipped.length === 0, `product_main ${name} at ${width}: no clipped text in the product area`, clip.clipped.slice(0, 5));
        drill.check(f.brokenImages.length === 0, `product_main ${name} at ${width}: no broken image`, f.brokenImages);
        if (clip.truncated.length) drill.note(`product_main ${name} at ${width}: ${clip.truncated.length} text(s) cut with an ellipsis or line clamp by design`);
        if (name === "product-sold-out") drill.check(/sold out/i.test(f.text), `product_main ${name} at ${width}: says sold out`);
        await drill.shoot(shopper, `sections-product_main-${name}-${width}`);
      }
    }
    covered.add("product_main");
  }

  drill.check(kinds.every((k) => covered.has(k)), "every registered section kind was drilled", { kinds, covered: [...covered] });
  await ctx.close();
  await shopper.context().close();
};

// Inside the page: clipped text in <main> (the product area).
function measureMain() {
  const root = document.querySelector("main") || document.body;
  const clipped = [];
  const truncated = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const txt = n.textContent.trim();
    if (!txt) continue;
    const el = n.parentElement;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
    if (!rects.length) continue;
    let ellipsis = false;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if ((s.webkitLineClamp && s.webkitLineClamp !== "none") || s.textOverflow === "ellipsis") ellipsis = true;
      if (["auto", "scroll"].includes(s.overflowX) || ["auto", "scroll"].includes(s.overflowY)) break;
      const cx = ["hidden", "clip"].includes(s.overflowX);
      const cy = ["hidden", "clip"].includes(s.overflowY);
      if (!cx && !cy) continue;
      const b = a.getBoundingClientRect();
      if (b.width <= 2 || b.height <= 2) break;
      if (rects.some((t) => (cx && (t.right > b.right + 1 || t.left < b.left - 1)) || (cy && (t.bottom > b.bottom + 1 || t.top < b.top - 1)))) {
        (ellipsis ? truncated : clipped).push(`${el.tagName.toLowerCase()}: ${txt.slice(0, 40)}`);
        break;
      }
    }
  }
  return { clipped, truncated };
}
