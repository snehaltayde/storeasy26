// P2-DRILLS parts on the founder's preview of a documents store (PV-03,
// DOC-05): the overlay before and after the first publish, the colours
// toggle, an old-format token, signing out; the "not finished yet" note and
// its click target; and the preview switch's redirect with hostile values.

import { reseed, getDoc, saveDraft, noThanks, bodyText, tenantSql, settle } from "./run.mjs";

export const parts = {};

const DRAFT_TITLE = "Preview only: a draft hero nobody published";
const DRAFT_ACCENT = "#7c3aed";

// The seeded store runs a hero test (variant b replaces the hero title). It is
// paused for these parts, so the hero a page shows is the document's own; the
// preview's handling of a running test is PV-08's and is not drilled here.
async function withTestsPaused(drill, fn) {
  const [running] = await tenantSql(["SELECT slug FROM experiments WHERE status = 'running'"]);
  const slugs = running.rows.map((r) => r.slug);
  await tenantSql(slugs.map((slug) => ({ sql: "UPDATE experiments SET status = 'paused' WHERE slug = ?", args: [slug] })));
  if (slugs.length) drill.note(`hero tests paused for this part: ${slugs.join(", ")} (running again afterwards)`);
  try {
    return await fn();
  } finally {
    await tenantSql(slugs.map((slug) => ({ sql: "UPDATE experiments SET status = 'running' WHERE slug = ?", args: [slug] })));
  }
}

// Start a preview session through the console route and open its link.
async function startSession(page) {
  const r = await page.evaluate(async () => {
    const res = await fetch("/api/admin/preview-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ create: true }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  if (r.status !== 200 || !r.body?.previewUrl) return r;
  await page.goto(r.body.previewUrl, { waitUntil: "load" });
  await settle(page);
  return r;
}

const heroTitle = (page) => page.evaluate(() => document.querySelector('[data-section-kind="hero"] h1, h1')?.innerText?.replace(/\s+/g, " ").trim() || "");
const previewBar = (page) => page.evaluate(() => /preview/i.test([...document.querySelectorAll("body > *, header, div")].slice(0, 40).map((e) => e.innerText || "").join(" ").slice(0, 2000)) && !!document.querySelector('form[action="/api/preview"], a[href*="/api/preview?exit"]'));
const pageHtml = (page) => page.evaluate(() => document.documentElement.outerHTML);

async function shopperPage(drill) {
  const ctx = await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width: 1440, height: 900 } });
  return ctx.newPage();
}

parts.preview = async (drill) => {
  // ---- 1. before the first publish ----
  await reseed(drill, ["--drafts-only"]);
  await withTestsPaused(drill, async () => {
    const ctx = await drill.context({ width: 1440 });
    const admin = await drill.signIn(ctx);
    const shopper = await shopperPage(drill);
    const sres = await drill.open(shopper, "/");
    const stext = await bodyText(shopper);
    drill.note(`before the first publish a shopper gets ${sres.status} at /: ${JSON.stringify(stext.slice(0, 160))}`);
    drill.check(!stext.includes("Skin first") && !stext.includes("Festive sale"), "before the first publish: a shopper sees none of the drafts", stext.slice(0, 120));
    const s = await startSession(admin);
    drill.check(s.status === 200, "a preview session starts (POST /api/admin/preview-session)", { status: s.status, code: s.body?.code });
    await noThanks(admin);
    const t = await bodyText(admin);
    drill.check((await heroTitle(admin)).startsWith("Skin first") && t.includes("Festive sale"), "before the first publish: the founder's preview shows the drafts (hero, announcement) over the empty list", { hero: await heroTitle(admin) });
    drill.check(await previewBar(admin), "before the first publish: the preview bar shows", null);
    await drill.shoot(admin, "preview-before-first-publish-1440");
    await drill.shoot(shopper, "preview-before-first-publish-shopper-1440");
    await shopper.context().close();
    await ctx.close();
  });

  // ---- 2. after the first publish: a home draft, the colours, an old token, sign out ----
  await reseed(drill);
  await withTestsPaused(drill, async () => {
    const ctx = await drill.context({ width: 1440 });
    const admin = await drill.signIn(ctx);
    const home = await getDoc(admin, "doc_home");
    const hb = structuredClone(home.body);
    hb.sections.find((x) => x.kind === "hero").settings.title = DRAFT_TITLE;
    const hs = await saveDraft(admin, home, hb);
    const design = await getDoc(admin, "doc_design");
    const db = structuredClone(design.body);
    db.settings.brand = { ...(db.settings.brand || {}), accent: DRAFT_ACCENT };
    const ds = await saveDraft(admin, design, db);
    drill.check(hs.status === 200 && ds.status === 200, "drafts saved: a new home hero title and a new accent colour in doc_design", { home: hs.status, design: ds.status });

    const shopper = await shopperPage(drill);
    await drill.open(shopper, "/");
    await noThanks(shopper);
    drill.check((await heroTitle(shopper)).startsWith("Skin first"), "after the first publish: a shopper sees the live hero", await heroTitle(shopper));
    drill.check(!(await pageHtml(shopper)).toLowerCase().includes(DRAFT_ACCENT), "a shopper's page has none of the draft colours", null);

    const s = await startSession(admin);
    drill.check(s.status === 200, "a preview session starts", { status: s.status });
    await noThanks(admin);
    drill.check((await heroTitle(admin)) === DRAFT_TITLE, "after the first publish: the founder's preview shows the home draft over the live store", await heroTitle(admin));
    const t = await bodyText(admin);
    drill.check(t.includes("Your new colours are not shown here.") && !(await pageHtml(admin)).toLowerCase().includes(DRAFT_ACCENT), "the preview says the new colours are not shown, and doesn't apply them", null);
    await drill.shoot(admin, "preview-colours-not-shown-1440");
    await admin.getByRole("button", { name: "Show them" }).click();
    await admin.waitForLoadState("load");
    await settle(admin);
    drill.check((await pageHtml(admin)).toLowerCase().includes(DRAFT_ACCENT) && (await bodyText(admin)).includes("Your new colours are shown here."), "\"Show them\" applies doc_design's draft colours in the preview", null);
    drill.check((await heroTitle(admin)) === DRAFT_TITLE, "the home draft is still shown with the colours on", null);
    await drill.shoot(admin, "preview-colours-shown-1440");
    await drill.open(shopper, "/");
    drill.check(!(await pageHtml(shopper)).toLowerCase().includes(DRAFT_ACCENT) && (await heroTitle(shopper)).startsWith("Skin first"), "the shopper still sees the live hero and live colours", null);
    await admin.getByRole("button", { name: "Hide them" }).click();
    await admin.waitForLoadState("load");
    await settle(admin);
    drill.check(!(await pageHtml(admin)).toLowerCase().includes(DRAFT_ACCENT), "\"Hide them\" takes the draft colours off again", null);

    // an old-format token: minted by the legacy preview while the store was
    // still legacy (a tab from before the move), then used on the documents store
    const legacyRefused = await admin.evaluate(async () => {
      const r = await fetch("/api/admin/releases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", to: "/" }) });
      return r.status;
    });
    drill.check(legacyRefused === 409, "the legacy preview button is refused on a documents store (409)", legacyRefused);
    await tenantSql(["UPDATE cms_state SET mode = 'legacy' WHERE id = 1"]);
    let oldUrl = null;
    try {
      oldUrl = await admin.evaluate(async () => {
        const r = await fetch("/api/admin/releases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", to: "/" }) });
        const j = await r.json().catch(() => null);
        return r.ok ? j?.url : null;
      });
    } finally {
      await tenantSql(["UPDATE cms_state SET mode = 'documents' WHERE id = 1"]);
    }
    const oldToken = oldUrl ? new URL(oldUrl, drill.baseUrl).searchParams.get("token") : null;
    drill.check(oldToken && oldToken.split(".").length === 3, "an old-format token (p.<exp>.<hmac>) was minted while the store was legacy", oldToken ? `${oldToken.split(".").length} parts` : null);
    if (oldToken) {
      const octx = await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width: 1440, height: 900 } });
      const op = await octx.newPage();
      await op.goto(`/api/preview?token=${encodeURIComponent(oldToken)}&to=/`);
      await settle(op);
      await noThanks(op);
      const cookies = await octx.cookies();
      drill.check(cookies.some((c) => c.name === "_preview"), "the old token still sets the preview cookie (it verifies)", null);
      drill.check((await heroTitle(op)).startsWith("Skin first") && !(await bodyText(op)).includes(DRAFT_TITLE), "an old-format token on a documents store shows live content only, no drafts", await heroTitle(op));
      await drill.shoot(op, "preview-old-token-live-1440");
      await octx.close();
    }

    // signing out of the console
    await drill.open(admin, "/");
    drill.check((await heroTitle(admin)) === DRAFT_TITLE, "before signing out: the founder's tab shows the draft", null);
    const out = await admin.evaluate(async () => (await fetch("/api/admin/logout", { method: "POST" })).status);
    drill.forgetSignIn();
    const consoleGone = await admin.goto("/admin/dashboard").then(() => new URL(admin.url()).pathname);
    drill.check(out === 200 && consoleGone.startsWith("/admin/login"), "signing out of the console works (the dashboard asks to sign in again)", { logout: out, landed: consoleGone });
    await drill.open(admin, "/");
    const after = await heroTitle(admin);
    drill.check(after.startsWith("Skin first") && !(await bodyText(admin)).includes(DRAFT_TITLE), "after signing out of the console, the same browser no longer sees the draft overlay", { hero: after, previewCookie: (await ctx.cookies()).some((c) => c.name === "_preview") }, { known: "finding 1" });
    await drill.shoot(admin, "preview-after-sign-out-1440");
    await shopper.context().close();
    await ctx.close();
  });
};

parts.unfinished = async (drill) => {
  await reseed(drill);
  await withTestsPaused(drill, async () => {
    const ctx = await drill.context({ width: 1440 });
    const admin = await drill.signIn(ctx);
    const home = await getDoc(admin, "doc_home");
    const hb = structuredClone(home.body);
    const at = hb.sections.findIndex((x) => x.kind === "hero") + 1;
    hb.sections.splice(at, 0, { id: "sec_drillbnr", kind: "banner", v: 1, enabled: true, settings: { title: "", text: "", button: null } }, { id: "sec_drillrail", kind: "product_rail", v: 1, enabled: true, settings: { title: "Picks for you", collection: null, limit: 8 } });
    const hs = await saveDraft(admin, home, hb);
    drill.check(hs.status === 200, "a home draft with an empty banner and a rail with no collection is saved", { status: hs.status, issues: (hs.body?.issues || []).filter((i) => i.sectionId?.startsWith("sec_drill")).map((i) => `${i.sectionId}:${i.field}:${i.code}:${i.severity}`) });

    const s = await startSession(admin);
    drill.check(s.status === 200, "a preview session starts", { status: s.status });
    await noThanks(admin);
    const notes = await admin.evaluate(() =>
      [...document.querySelectorAll("[data-unfinished]")].map((e) => ({ id: e.getAttribute("data-section-id"), sec: e.getAttribute("data-sec"), kind: e.getAttribute("data-section-kind"), text: e.innerText.replace(/\s+/g, " ").trim().slice(0, 200) })),
    );
    const bn = notes.find((n) => n.id === "sec_drillbnr");
    const rl = notes.find((n) => n.id === "sec_drillrail");
    drill.check(bn && /not finished yet/.test(bn.text) && /Only you can see this/.test(bn.text), "preview: the unfinished banner shows the 'not finished yet' note", bn);
    drill.check(rl && /not finished yet/.test(rl.text) && /Only you can see this/.test(rl.text), "preview: the unfinished rail shows the 'not finished yet' note", rl);
    await admin.locator('[data-section-id="sec_drillbnr"]').scrollIntoViewIfNeeded().catch(() => {});
    await drill.shoot(admin, "unfinished-preview-1440");

    // the shopper: neither the notes nor the draft sections
    const shopper = await shopperPage(drill);
    await drill.open(shopper, "/");
    await noThanks(shopper);
    const live = await shopper.evaluate(() => ({ unfinished: document.querySelectorAll("[data-unfinished]").length, ids: [...document.querySelectorAll("[data-section-id]")].map((e) => e.getAttribute("data-section-id")), text: document.body.innerText }));
    drill.check(live.unfinished === 0 && !/not finished yet/.test(live.text) && !live.ids.some((i) => i.startsWith("sec_drill")), "live: a shopper sees neither the notes nor the unfinished sections", { unfinished: live.unfinished });
    await drill.shoot(shopper, "unfinished-live-1440");

    // the click target: the preview in a frame on the store's own origin,
    // spoken to with the Designer's protocol (components/preview/PreviewBridge.js)
    await admin.goto("/robots.txt");
    await admin.evaluate(() => {
      window.__msgs = [];
      window.addEventListener("message", (e) => e.origin === location.origin && window.__msgs.push(e.data));
      document.body.innerHTML = '<iframe id="pv" src="/" style="width:1280px;height:800px;border:0"></iframe>';
      document.getElementById("pv").addEventListener("load", () => document.getElementById("pv").contentWindow.postMessage("storeasy:designer:hello", location.origin));
    });
    const ready = await admin.waitForFunction(() => window.__msgs.some((m) => m?.type === "storeasy:ready"), null, { timeout: 30_000 }).then(() => true).catch(() => false);
    await admin.evaluate(() => document.getElementById("pv").contentWindow.postMessage("storeasy:designer:hello", location.origin));
    drill.check(ready, "the preview's bridge answers the Designer's hello", null);
    const frame = admin.frameLocator("#pv");
    await frame.locator('[data-section-id="sec_drillbnr"]').click();
    const clicked = await admin.waitForFunction(() => window.__msgs.find((m) => m?.type === "storeasy:sec:click")?.id || null, null, { timeout: 10_000 }).then((h) => h.jsonValue()).catch(() => null);
    drill.check(clicked === "sec_drillbnr", "clicking the banner's note in the preview sends the Designer that section's id (storeasy:sec:click)", clicked);
    const selected = await frame.locator('[data-section-id="sec_drillbnr"]').evaluate((e) => e.classList.contains("storeasy-selected")).catch(() => false);
    drill.check(selected, "the note is outlined as selected in the preview", null);

    // the real Designer on a documents store
    await admin.goto("/admin/storefront/designer");
    await settle(admin);
    await admin.waitForTimeout(3000);
    const designer = await admin.evaluate(() => ({ text: document.body.innerText.slice(0, 3000), frames: document.querySelectorAll("iframe").length }));
    const opens = designer.frames > 0 && !/Preview couldn.t start/i.test(designer.text);
    drill.note(`the Designer on a documents store: ${designer.frames} preview frame(s); ${JSON.stringify((designer.text.match(/Preview couldn.t start[^\n]*\n?[^\n]*/) || [""])[0])}`);
    drill.check(opens, "the real Designer previews a documents store, so a click on the note selects the section there", { frames: designer.frames }, { known: "finding 2" });
    await drill.shoot(admin, "unfinished-designer-1440");
    await shopper.context().close();
    await ctx.close();
  });
};

// Every hostile value from the P2-FIX4 table, plus its raw links and the
// review's dot-segment values. Each must land on the store's own origin.
const HOSTILE = ["/\\evil.com", "/%5Cevil.com", "/%5cevil.com", "//evil.com", "/%2F%2Fevil.com", "/%2f/evil.com", "/%252F%252Fevil.com", "/\t/evil.com", "/\n/evil.com", "/\r\n/evil.com", "/\\/evil.com", "\\\\evil.com", "https://evil.com", "https:evil.com", "javascript:alert(1)", " //evil.com", ""];
const RAW = ["to=/%5Cevil.com", "to=/%5cevil.com", "to=/%09/evil.com", "to=/%0A/evil.com", "token=bad&to=/%5Cevil.com", "to=/a/..//evil.com", "to=/..//evil.com", "to=/%2e%2e/%2e%2e//evil.com", "exit=1&to=//evil.com", "to=%2F%2Fevil.com"];

parts.redirect = async (drill) => {
  await reseed(drill); // a documents store to send the hostile links to
  const ctx = await drill.browser.newContext({ baseURL: drill.baseUrl, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const base = new URL(drill.baseUrl);
  const offsite = [];
  // never let the browser actually leave: any other host is recorded and stopped
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== base.hostname) {
      offsite.push(u.href);
      return route.abort();
    }
    return route.continue();
  });
  const tryOne = async (label, query) => {
    const before = offsite.length;
    await page.goto(`/api/preview?${query}`, { waitUntil: "load" }).catch(() => {});
    const u = new URL(page.url());
    const ok = u.origin === base.origin && offsite.length === before;
    drill.check(ok, `${label}: lands on the store's own origin`, { landed: page.url(), offsite: offsite.slice(before) });
    return u;
  };
  for (const v of HOSTILE) {
    for (const [how, q] of [
      ["no token", `to=${encodeURIComponent(v)}`],
      ["bad token", `token=p.1.bad&to=${encodeURIComponent(v)}`],
      ["exit", `exit=1&to=${encodeURIComponent(v)}`],
    ]) {
      const u = await tryOne(`to=${JSON.stringify(v)} (${how})`, q);
      if (u.origin === base.origin) drill.check(u.pathname === "/", `to=${JSON.stringify(v)} (${how}): sent to the home page`, page.url());
    }
  }
  for (const q of RAW) await tryOne(`raw ?${q}`, q);
  // a good path is kept
  const good = await tryOne("to=/collections (control)", "to=%2Fcollections");
  drill.check(good.pathname === "/collections", "a plain store path is kept (/collections)", page.url());
  drill.check(offsite.length === 0, "the browser never requested another host", offsite.slice(0, 5));
  await ctx.close();
};

