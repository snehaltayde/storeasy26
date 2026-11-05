// P6-DRILLS stage F (plan section 0.4: legacy stores keep working): a legacy
// store is unchanged by phase 6. One legacy p6 store (seed --p6 --stage f,
// a fresh store provisioned on the old editor, with the perf catalog synced) is
// seeded once on this tree and its harness data copied aside. A throwaway,
// read-only git worktree at b063753 (cms/phase-1 with P5-FIX2 and P5-DRILLS
// merged, before any phase 6 merge: phase 6's base), outside
// .claude/worktrees, gets its own pnpm install and that copy, runs its own
// harness, and the founder's and a shopper's views are captured:
//   /admin/setup        the checklist as GET /api/admin/setup answers it
//                       (every step's label, hint, kind, href, done, actions)
//                       and the page's own text
//   the storefront      the header's and footer's words, links and logo
//                       pictures, and their HTML after the P4 comparison's mask
//   /admin/start        what the address does there (it doesn't exist yet)
// Then the same copy is served by THIS tree's harness and the same views
// compared: the checklist and the header and footer must be the same, and
// /admin/start must redirect to /admin/setup. The worktree is removed after.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_NAME, ENV_FILE_NAME, ROOT } from "../../design-harness.js";
import { connectHarness } from "../../drill.js";
import { LOGO_FACTS, OUT, P6_STORE, loginP6, noThanks, p6Context, p6Url, reseedP6, settle, sleep, startOwned, stopOwned, watchErrors } from "./lib.mjs";

export const BASE_SHA = "b063753";
const BASE_DIR = join(OUT, "legacy-f");

function scratchRoot() {
  const root = process.env.P6_DRILL_SCRATCH;
  if (!root) return mkdtempSync(join(tmpdir(), "p6-drills-"));
  mkdirSync(root, { recursive: true });
  return root;
}
const git = (args, cwd = ROOT) => spawnSync("git", args, { cwd, encoding: "utf8" });
function copyData(fromRoot, toRoot) {
  rmSync(join(toRoot, DATA_DIR_NAME), { recursive: true, force: true });
  cpSync(join(fromRoot, DATA_DIR_NAME), join(toRoot, DATA_DIR_NAME), { recursive: true });
  cpSync(join(fromRoot, ENV_FILE_NAME), join(toRoot, ENV_FILE_NAME));
  rmSync(join(toRoot, DATA_DIR_NAME, "harness.pid.json"), { force: true });
}

// What the founder and a shopper see on the legacy store at `drill`'s port.
async function captureViews(drill, tag) {
  const { normalize } = await import("../../../lib/migrate/render-compare.js");
  const ctx = await p6Context(drill);
  const errors = watchErrors(ctx);
  const page = await loginP6(drill, ctx);
  await page.goto(p6Url(drill, "/admin/setup"), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator("ol").first().waitFor({ timeout: 60_000 });
  const api = await page.evaluate(async () => {
    const r = await fetch("/api/admin/setup", { headers: { Accept: "application/json" } });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  const steps = (api.body?.items || []).map(({ id, label, hint, kind, href, done, gated, actions }) => ({ id, label, hint, kind, href, done: Boolean(done), gated: Boolean(gated), actions: actions ?? null }));
  const setupText = (await page.locator("main").innerText()).replace(/\s+/g, " ").trim();
  const setupButtons = (await page.locator("main ol button").allInnerTexts()).map((t) => t.trim());
  await drill.screenshot(page, `f-${tag}-setup-1440`);
  const start = await page.goto(p6Url(drill, "/admin/start"), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const startView = { status: start?.status() ?? null, landed: new URL(page.url()).pathname, text: (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200) };
  await drill.screenshot(page, `f-${tag}-admin-start-1440`);
  await ctx.close();

  const sctx = await drill.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await sctx.addCookies([{ name: "_unit", value: "p6-legacy", url: p6Url(drill, "/") }]);
  const sp = await sctx.newPage();
  const res = await sp.goto(p6Url(drill, "/"), { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  await noThanks(sp);
  const facts = await sp.evaluate(LOGO_FACTS);
  const html = await sp.evaluate(() => ({ header: document.querySelector("header")?.outerHTML || "", footer: document.querySelector("footer")?.outerHTML || "" }));
  const origin = new URL(p6Url(drill, "/")).origin;
  const masked = { header: normalize(html.header, { origin }), footer: normalize(html.footer, { origin }) };
  await drill.screenshot(sp, `f-${tag}-storefront-1440`);
  await sctx.close();
  return { steps, apiStatus: api.status, doneCount: api.body?.doneCount ?? null, total: api.body?.total ?? null, setupText, setupButtons, startView, storefront: { status: res?.status() ?? null, ...facts, masked }, errors };
}

export async function legacyStage(drill) {
  const scratch = scratchRoot();
  // the legacy store, seeded once on this tree, then copied aside
  const seed = await reseedP6(drill, "f", { start: false });
  drill.check(seed.state.mode === "legacy" && seed.state.documents === 0 && seed.state.products === 24 && seed.state.latestSync.status === "complete", "the stage seed: a fresh LEGACY p6 store (provisioned on the old editor) with 24 products, complete sync", seed.state);
  const snapshot = join(scratch, "legacy-f-snapshot");
  rmSync(snapshot, { recursive: true, force: true });
  mkdirSync(snapshot, { recursive: true });
  copyData(ROOT, snapshot);

  // phase 6's base, in a throwaway worktree
  const anc = git(["merge-base", "--is-ancestor", BASE_SHA, "HEAD"]);
  const fixtureMerge = git(["merge-base", "--is-ancestor", "536935f", BASE_SHA]);
  drill.check(anc.status === 0 && fixtureMerge.status !== 0, `${BASE_SHA} is an ancestor of this tree and holds no phase 6 merge (P6-FIXTURE's merge 536935f is not in it)`, { ancestor: anc.status === 0, hasP6Fixture: fixtureMerge.status === 0 });
  const wt = join(scratch, "baseline-b063753");
  if (existsSync(wt)) {
    git(["worktree", "remove", "--force", wt]);
    rmSync(wt, { recursive: true, force: true });
  }
  if (wt.includes(join(".claude", "worktrees"))) throw new Error("the baseline worktree must be outside .claude/worktrees");
  const add = git(["worktree", "add", "--detach", wt, BASE_SHA]);
  drill.check(add.status === 0, `a throwaway detached worktree at ${BASE_SHA}`, add.stderr.trim().split("\n").pop());
  let base = null;
  let harness = null;
  try {
    const inst = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: wt, encoding: "utf8", timeout: 600_000 });
    drill.check(inst.status === 0, "its own pnpm install --frozen-lockfile --prefer-offline (no symlinked node_modules)", `${inst.stdout || ""}${inst.stderr || ""}`.trim().split("\n").slice(-1).join(" "));
    copyData(snapshot, wt);
    harness = await connectHarness({ start: true, root: wt, log: () => {} });
    await fetch(p6Url(drill, "/")).catch(() => {});
    base = await captureViews(drill, "b063753");
  } finally {
    if (harness?.started) await harness.stop();
    await sleep(500);
    const rm = git(["worktree", "remove", "--force", wt]);
    git(["worktree", "prune"]);
    drill.check(rm.status === 0 && !existsSync(wt), "the throwaway worktree is removed", rm.stderr.trim());
  }

  // this tree, the same data
  copyData(snapshot, ROOT);
  await startOwned();
  await fetch(p6Url(drill, "/")).catch(() => {});
  const now = await captureViews(drill, "phase6");
  await stopOwned();
  mkdirSync(BASE_DIR, { recursive: true });
  writeFileSync(join(BASE_DIR, "b063753.json"), `${JSON.stringify(base, null, 2)}\n`);
  writeFileSync(join(BASE_DIR, "phase6.json"), `${JSON.stringify(now, null, 2)}\n`);
  drill.check(base.apiStatus === 200 && now.apiStatus === 200 && base.steps.length > 0, "both trees answer the checklist (GET /api/admin/setup 200)", { base: base.apiStatus, now: now.apiStatus, steps: base.steps.length });
  drill.check(JSON.stringify(now.steps) === JSON.stringify(base.steps) && now.doneCount === base.doneCount && now.total === base.total, "/admin/setup on the legacy store: every step's label, hint, kind, link, state and actions are the same as at b063753", { base: base.steps.map((s) => [s.id, s.label]), now: now.steps.map((s) => [s.id, s.label]), diff: now.steps.filter((s, i) => JSON.stringify(s) !== JSON.stringify(base.steps[i])) });
  drill.check(now.setupText === base.setupText && JSON.stringify(now.setupButtons) === JSON.stringify(base.setupButtons), "the setup page's words and buttons are the same", { same: now.setupText === base.setupText, base: base.setupText.slice(0, 200), now: now.setupText.slice(0, 200) });
  drill.check(!now.steps.some((s) => /Start your store|Add your legal pages/i.test(`${s.label} ${s.hint}`)) && !now.steps.some((s) => Array.isArray(s.actions) && s.actions.length), "no phase 6 step or button on the legacy checklist (no 'Start your store', no policy starters)", now.steps.map((s) => s.label));
  const sf = (v) => ({ status: v.storefront.status, headerText: v.storefront.headerText, footerText: v.storefront.footerText, headerLinks: v.storefront.headerLinks, footerLinks: v.storefront.footerLinks, logos: [v.storefront.header.length, v.storefront.footer.length] });
  drill.check(JSON.stringify(sf(now)) === JSON.stringify(sf(base)) && now.storefront.header.length === 0 && now.storefront.footer.length === 0, "the storefront's header and footer: the same words, links and text wordmark (no logo picture) as at b063753", { base: sf(base), now: sf(now) });
  drill.check(now.storefront.masked.header === base.storefront.masked.header && now.storefront.masked.footer === base.storefront.masked.footer, "the header's and footer's HTML is the same as at b063753 after the P4 comparison's mask", { header: now.storefront.masked.header === base.storefront.masked.header, footer: now.storefront.masked.footer === base.storefront.masked.footer });
  drill.check(now.startView.landed === "/admin/setup", "/admin/start on the legacy store redirects to /admin/setup", { now: now.startView, atBase: base.startView });
  drill.note(`at b063753 /admin/start answered ${base.startView.status} and stayed at ${base.startView.landed} (the page didn't exist yet)`);
  drill.check(now.errors.length === 0, "no page errors on this tree", now.errors);
  drill.note(`store: ${P6_STORE.host}; captures in docs/cms-reviews/drills/P6-DRILLS/legacy-f/`);
}
