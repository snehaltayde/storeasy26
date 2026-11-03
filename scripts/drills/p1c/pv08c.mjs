// P1-DRILLS-C · PV-08 drills still needed (docs/cms-reviews/P1-PV-08.md, 3 and 4).
//   DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs pv08c c-signout
//   DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs pv08c c-real-lapse     (waits just over an hour)
// Parts
//   c-real-lapse  signed in, the browser's _unit in variant b, the Designer
//                 open with the hero test running, left alone until the
//                 browser itself has dropped the preview cookie (its token's
//                 hour). Then type a hero title, Save, Refresh preview: the
//                 frame shows the live hero and never variant b, no
//                 POST /api/exp, no exposure row, the Designer reads
//                 "Connecting…" (PV-04).
//   c-signout     the Designer open, sign out through the console's button,
//                 open / (preview cookie still alive: draft, not counted),
//                 press "Exit preview", open / again with the same variant-b
//                 unit: variant b's title and one POST /api/exp, recorded.
// Screenshots and results go to docs/cms-reviews/drills/PV-08/ named c-*.
import { rows } from "../p1/db.mjs";
import { seen, sleep } from "../p1/util.mjs";

export const id = "PV-08";
export const title = "P1-DRILLS-C: PV-08 drills still needed";

const LAPSE_EXTRA_MS = Number(process.env.LAPSE_EXTRA_MS || 90_000);

// The pure bucketing hash of lib/experiments.js (as in scripts/drills/p1/pv08.mjs).
function hashUnit(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 10000;
}
function assign(exp, unit) {
  const bucket = hashUnit(`${exp.salt || ""}|${exp.slug}|${unit}`);
  const total = exp.variants.reduce((s, v) => s + Number(v.weight), 0);
  let acc = 0;
  for (const v of exp.variants) {
    acc += (Number(v.weight) / total) * 10000;
    if (bucket < acc) return v.key;
  }
  return exp.variants[exp.variants.length - 1]?.key || "control";
}
async function heroTest() {
  const [r] = await rows("tenant", "SELECT id, slug, name, salt, status, variants FROM experiments WHERE slug='hero-promise'");
  return { ...r, variants: JSON.parse(r.variants) };
}
function unitIn(exp, key, tag) {
  const stamp = Date.now().toString(36);
  for (let i = 0; ; i++) {
    const u = `p1c-${tag}-${stamp}-${i}`;
    if (assign(exp, u) === key) return u;
  }
}
async function setUnit(ctx, url, unit) {
  await ctx.addCookies([{ name: "_unit", value: unit, url }]);
  const got = (await ctx.cookies()).find((c) => c.name === "_unit")?.value;
  if (got !== unit) throw new Error(`the browser's _unit is ${got}, not ${unit}`);
}
const exposures = async (unit) => rows("tenant", "SELECT variant FROM experiment_exposures WHERE unit_id = ?", [unit]);
const allExposures = async () => Number((await rows("tenant", "SELECT count(*) n FROM experiment_exposures"))[0].n);
async function liveTitle() {
  const [live] = await rows("tenant", "SELECT json_extract(content, '$.blocks.hero.title') title FROM releases WHERE id = (SELECT live_release_id FROM release_state WHERE id = 1)").catch(() => [null]);
  if (live?.title) return live.title;
  const [saved] = await rows("tenant", "SELECT value FROM cms_blocks WHERE key='hero'");
  return JSON.parse(saved.value).title;
}
function expPings(ctx) {
  const out = [];
  ctx.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/exp") out.push({ at: new Date().toISOString(), method: r.method(), frame: r.frame()?.url?.() ?? null });
  });
  ctx.on("response", async (r) => {
    if (new URL(r.url()).pathname !== "/api/exp") return;
    const body = await r.json().catch(() => null);
    const hit = out.find((x) => x.body === undefined);
    if (hit) Object.assign(hit, { status: r.status(), body });
  });
  return out;
}
const previewFrame = (page) => page.frames().find((fr) => fr !== page.mainFrame() && new URL(fr.url()).pathname === "/");
async function frameHero(page) {
  const fr = previewFrame(page);
  if (!fr) return null;
  return fr
    .evaluate(() => {
      const sec = document.querySelector('[data-sec="hero"]');
      return {
        h1: sec?.querySelector("h1")?.innerText.replace(/\s+/g, " ").trim() ?? null,
        note: sec?.querySelector("[data-preview-note]") ? true : false,
        draftBar: document.body.innerText.includes("Draft preview"),
      };
    })
    .catch(() => null);
}
async function waitHero(page, pred, ms = 20_000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await frameHero(page);
    if (last && pred(last)) return { ms: Date.now() - t0, hero: last };
    await sleep(250);
  }
  return { ms: null, hero: last };
}
async function saveHero(page, title) {
  await page.getByRole("button", { name: "Hero", exact: true }).first().click();
  await page.locator("#ins-hero-title").waitFor({ timeout: 15_000 });
  await page.locator("#ins-hero-title").fill(title);
  const put = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/storefront" && r.request().method() === "PUT", { timeout: 30_000 });
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  return (await put).status();
}
async function heroOn(page) {
  return page.evaluate(() => ({
    h1: document.querySelector('[data-sec="hero"] h1')?.innerText.replace(/\s+/g, " ").trim() ?? null,
    draftBar: document.body.innerText.includes("Draft preview"),
    note: !!document.querySelector("[data-preview-note]"),
  }));
}

export const parts = {
  async "c-real-lapse"(drill) {
    const exp = await heroTest();
    drill.check(exp.status === "running", "setup: the seeded hero test is running", exp.status);
    const variantTitle = exp.variants.find((v) => v.key === "b").payload.title;
    const unit = unitIn(exp, "b", "lapse");
    const ctx = await drill.context({ width: 1440 });
    const pings = expPings(ctx);
    const page = await drill.signIn(ctx);
    await setUnit(ctx, drill.baseUrl, unit);
    page.on("dialog", (d) => d.accept().catch(() => {}));
    const [saved] = await rows("tenant", "SELECT value FROM cms_blocks WHERE key='hero'");
    const draft = JSON.parse(saved.value);
    drill.note(`setup: unit ${unit} in variant ${assign(exp, unit)}; saved title "${draft.title}"; variant b "${variantTitle}"`);

    await drill.open(page, "/admin/storefront/designer", { width: 1440 });
    drill.check(await seen(page, "Preview shows your last save", 60_000), 'the preview connects ("Preview shows your last save")');
    const first = await waitHero(page, (h) => h.h1 === draft.title, 10_000);
    drill.check(first.hero?.h1 === draft.title, "at the start: the frame shows the founder's saved title", first.hero?.h1);
    await drill.shoot(page, "c-lapse-0-start");
    const pc = (await ctx.cookies()).find((c) => c.name === "_preview");
    drill.check(Boolean(pc), "at the start: the browser holds a preview cookie", pc ? { expires: pc.expires } : null);
    const expiresMs = (pc?.expires || Date.now() / 1000) * 1000;
    const startedAt = new Date().toISOString();
    drill.note(`started ${startedAt}; the preview cookie expires ${new Date(expiresMs).toISOString()} (in ${Math.round((expiresMs - Date.now()) / 1000)} s)`);
    const pingsBefore = pings.length;
    const exposuresBefore = await allExposures();

    // Leave the Designer open, untouched, until just past the cookie's expiry.
    const until = expiresMs + LAPSE_EXTRA_MS;
    while (Date.now() < until) {
      const left = Math.round((until - Date.now()) / 1000);
      console.log(`… waiting for the real lapse, ${left} s left`);
      await sleep(Math.min(60_000, Math.max(1000, until - Date.now())));
    }
    const jar = await ctx.cookies();
    drill.note(`after the wait (${new Date().toISOString()}): cookies ${JSON.stringify(jar.map((c) => c.name))}`);
    drill.check(!jar.some((c) => c.name === "_preview"), "after just over an hour: the browser itself has dropped the preview cookie", jar.map((c) => c.name));
    drill.check(jar.some((c) => c.name === "_admin" && c.value), "after just over an hour: still signed in to the console");
    const statusIdle = (await page.locator('[data-editor-pane="preview"] [role="status"]').first().innerText().catch(() => "")).trim();
    drill.note(`the Designer's status before touching anything: "${statusIdle}"`);
    await drill.shoot(page, "c-lapse-1-after-hour-untouched");

    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, ".");
    const TITLE = `Lapse drill ${stamp}`;
    const st = await saveHero(page, TITLE);
    drill.check(st === 200, "after the lapse: Save answers 200", st);
    await sleep(1500);
    const live = await liveTitle();
    const views = [];
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "Refresh preview" }).click();
      await sleep(1500);
      views.push((await waitHero(page, (h) => !!h.h1, 15_000)).hero);
    }
    const status = (await page.locator('[data-editor-pane="preview"] [role="status"]').first().innerText().catch(() => "")).trim();
    drill.note(`after Save and Refresh preview: frame ${JSON.stringify(views)}; live title "${live}"; status "${status}"`);
    drill.check(views.every((v) => v?.h1 && v.h1 !== variantTitle), "after the lapse: the frame never shows variant b", views.map((v) => v?.h1));
    drill.check(views.every((v) => v?.h1 === live), `after the lapse: the frame shows the live hero ("${live}")`, views.map((v) => v?.h1));
    drill.check(/Connecting/.test(status), 'after the lapse: the Designer reads "Connecting…" (PV-04)', status);
    await drill.shoot(page, "c-lapse-2-saved-refreshed");
    await sleep(1000);
    drill.note(`/api/exp requests during the whole session: ${JSON.stringify(pings)}`);
    drill.check(pings.length === 0 && pingsBefore === 0, "no POST /api/exp from the browser, before or after the lapse", pings);
    drill.check((await exposures(unit)).length === 0, "no exposure row for this unit", await exposures(unit));
    drill.note(`exposures in all: ${exposuresBefore} before the wait, ${await allExposures()} after (other drills may add shopper rows meanwhile)`);
    // put the hero title back
    await drill.open(page, "/admin/storefront/designer", { width: 1440 });
    drill.note(`hero title put back: ${await saveHero(page, draft.title)}`);
    await ctx.close();
  },

  async "c-signout"(drill) {
    const exp = await heroTest();
    drill.check(exp.status === "running", "setup: the seeded hero test is running", exp.status);
    const variantTitle = exp.variants.find((v) => v.key === "b").payload.title;
    const unit = unitIn(exp, "b", "signout");
    const ctx = await drill.context({ width: 1440 });
    const pings = expPings(ctx);
    // a sign-in of its own, so signing out revokes no other part's session
    const page = await ctx.newPage();
    await page.goto("/admin/login");
    await page.locator("#login-password").fill(drill.harness.creds.DESIGN_ADMIN_PASSWORD || "");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 });
    await setUnit(ctx, drill.baseUrl, unit);
    const [saved] = await rows("tenant", "SELECT value FROM cms_blocks WHERE key='hero'");
    const draft = JSON.parse(saved.value);
    drill.note(`setup: unit ${unit} in variant ${assign(exp, unit)}; saved title "${draft.title}"; live "${await liveTitle()}"; variant b "${variantTitle}"`);
    await drill.open(page, "/admin/storefront/designer", { width: 1440 });
    drill.check(await seen(page, "Preview shows your last save", 60_000), "the Designer's preview connects");
    drill.check((await ctx.cookies()).some((c) => c.name === "_preview"), "the Designer gave the browser a preview cookie");

    // Sign out through the console's own button.
    // the Designer is an editor screen: its console menu holds Sign out
    const signOut = page.getByRole("button", { name: /Sign out/ }).filter({ visible: true });
    if (!(await signOut.count())) await page.getByRole("button", { name: /Open menu/ }).first().click();
    await signOut.first().waitFor({ timeout: 10_000 });
    const out = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/logout", { timeout: 30_000 }).catch(() => null);
    await signOut.first().click();
    const lo = await out;
    if (!lo) throw new Error("Sign out sent no /api/admin/logout");
    await page.waitForLoadState("load").catch(() => {});
    await sleep(1000);
    const jar = await ctx.cookies();
    drill.check(lo.status() === 200 && !jar.some((c) => c.name === "_admin" && c.value), "Sign out answers 200 and the console cookie is gone", { status: lo.status(), cookies: jar.map((c) => c.name) });
    drill.check(jar.some((c) => c.name === "_preview"), "the preview cookie outlives sign-out (known limit)", jar.map((c) => c.name));

    // Before Exit preview: the same visit shows the draft and isn't counted.
    const n0 = pings.length;
    await drill.open(page, "/", { width: 1440 });
    await sleep(1500);
    const pre = await heroOn(page);
    drill.note(`before Exit preview: ${JSON.stringify(pre)}; pings ${JSON.stringify(pings.slice(n0))}`);
    drill.check(pre.draftBar && pre.h1 === draft.title, "before Exit preview: / shows the draft (the Draft preview bar and the saved title)", pre);
    drill.check(pings.length === n0, "before Exit preview: no POST /api/exp", pings.slice(n0));
    drill.check((await exposures(unit)).length === 0, "before Exit preview: no exposure row");
    await drill.shoot(page, "c-signout-1-before-exit-preview");

    // Exit preview (it lands back on the live store), then / again.
    const nExit = pings.length;
    await page.getByRole("link", { name: "Exit preview" }).first().click();
    await page.waitForLoadState("load").catch(() => {});
    await sleep(800);
    drill.check(!(await ctx.cookies()).some((c) => c.name === "_preview"), "Exit preview clears the preview cookie", (await ctx.cookies()).map((c) => c.name));
    await sleep(1500);
    const landed = { path: new URL(page.url()).pathname, ...(await heroOn(page).catch(() => ({}))) };
    const n1 = pings.length;
    await drill.open(page, "/", { width: 1440 });
    await sleep(2000);
    const post = await heroOn(page);
    const sent = pings.slice(nExit);
    drill.note(`after Exit preview: landed on ${JSON.stringify(landed)}; then / again: ${JSON.stringify(post)}; pings since Exit preview ${JSON.stringify(sent)} (${pings.length - n1} from the second visit)`);
    drill.check(post.h1 === variantTitle && !post.draftBar, `after Exit preview: variant b's title ("${variantTitle}")`, post);
    drill.check(sent.length === 1 && sent[0].body?.recorded === true, "after Exit preview: one POST /api/exp in all, answered recorded:true", sent);
    const ex = await exposures(unit);
    drill.check(ex.length === 1 && ex[0].variant === "b", "one exposure row, variant b", ex);
    await drill.shoot(page, "c-signout-2-after-exit-preview");
    await ctx.close();
  },
};
