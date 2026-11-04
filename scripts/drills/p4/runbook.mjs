// P4-DRILLS 'runbook' stage (MIG-02, MIG-03, MIG-04): docs/cms-reviews/
// P4-CUTOVER-RUNBOOK.md followed literally, step by step, on a fresh --p4
// harness store (the store "design"), in desktop Chrome where the runbook
// sends the owner to a screen. Every command is the runbook's own, run with
// the harness's environment instead of .env.local and without --hosted
// --confirm (both are refused on local databases, and builders never pass
// them); each such translation, and every step that needed developer
// knowledge, is recorded (results-runbook.json's notes, and
// docs/cms-reviews/drills/P4-DRILLS/runbook-steps.json) and answered in the
// runbook (P4-DRILLS owns it in batch 7 for those fixes only).
//
//   section 0   the database updates and their check (tenant-migrate --all,
//               --check --include-env) on the harness's own databases
//   sections 3-5  the restore-drill copy (restore-drill.js --keep), served by
//               a local sqld with the store's row pointed at it, the route
//               list, the dry run (Not ready: an agency has access; removed in
//               Settings, Agency access, in Chrome), the dry run again
//               (Ready to move, the digest), the rehearsal (Result: passed)
//   section 8   a deliberate stop in 'migrating': the move stops after its
//               backfill (the process is killed, as a power cut would);
//               --status says the store is being updated and what to run;
//               an old editor's save is refused in plain words; shoppers
//               still get the store; --abort puts it back on the old editor
//   section 6   the move, with the digest and the rehearsal; --status
//   section 7   post-checks: the shopper canaries in Chrome, the editor
//               opens, the old screens lead to it, the look is recorded
//   section 9   a product renamed in the new editor; the reversal's dry run,
//               the reversal, its --status and its post-checks
//   again       sections 3 to 6 once more: the move after the reversal, the
//               dry run listing the edit that comes back
//
// Also, when run as `node runbook.mjs --crash-after <step> -- <migrate-documents
// args>`: the move, killed right after <step> (the stop in 'migrating').
// That mode is only for this drill, on the harness's local databases.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT } from "../../design-harness.js";
import { DrillError, assertLocal, heroOnlyFailure, copyDatabase, copyServer, digestOf, drillScratch, harnessContext, noThanks, pointStoreAt, publishHere, readP4Seed, reseedP4, rowsOf, runNode, searchFor, settle, shopperContext, sleep, sqlAt, waitFor, waitSaved, consoleUrl } from "./lib.mjs";

const readReport = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const STEPS_FILE = join(ROOT, "docs", "cms-reviews", "drills", "P4-DRILLS", "runbook-steps.json");
const NEW_NAME = "Runbook Drill Renamed";

// runbook 3.2 as the owner runs it: serve-copy in its own process, ready when
// it prints its address; stop() is the owner's Ctrl-C.
async function serveCopyChild(ctx, file) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve-copy", "--copy", file, "--tenant", ctx.store], { cwd: ROOT, env: { ...process.env, ...ctx.env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  const ready = await waitFor(async () => /is served at (http:\/\/127\.0\.0\.1:\d+)/.exec(out) || (child.exitCode != null ? ["", null] : null), 120_000, 200);
  if (!ready?.[1]) {
    child.kill("SIGKILL");
    throw new DrillError(`serve-copy didn't start: ${out.trim().split("\n").slice(-2).join(" | ")}`);
  }
  let stopped = null;
  return {
    url: ready[1],
    line: out.trim().split("\n").pop(),
    async stop() {
      if (stopped) return stopped;
      child.kill("SIGINT");
      const code = await Promise.race([exited, sleep(30_000).then(() => "timeout")]);
      if (code === "timeout") child.kill("SIGKILL");
      await sleep(Number(ctx.env.PLATFORM_CACHE_MS || 1000) + 1500);
      const row = rowsOf((await sqlAt(ctx.urls.platform, [{ sql: "SELECT db_url FROM tenants WHERE id = ?", args: [ctx.store] }]))[0])[0];
      stopped = { pointedBack: row?.db_url === ctx.urls.tenant && code === 0, tail: out.trim().split("\n").slice(-1)[0], code };
      return stopped;
    },
  };
}

// Runbook steps 3 to 5, as written: the restore-drill copy, served by the
// harness (serve-copy), the route list, the dry run (with the founder: an
// agency's access is removed in Chrome when it says so), the rehearsal on the
// copy, Ctrl-C on serve-copy, the copy deleted. Returns { digest, report, dry }.
async function copyRehearseDry(drill, { ctx, scratch, X, file, record, label, node, plainOf, noCodes }) {
  const tag = label.replace(/[^a-z0-9]+/gi, "-");
  const rd = await node("scripts/restore-drill.js", ["--tenant", X, "--keep"]);
  drill.check(rd.code === 0 && existsSync(file), `${label} 3.1: restore-drill.js --tenant ${X} --keep writes restore-drill-${X}.db and its checks pass`, rd.out.trim().split("\n").slice(-3));
  let served = await serveCopyChild(ctx, file);
  let digest = null;
  let report = null;
  let dry = null;
  try {
    drill.check(Boolean(served.url), `${label} 3.2: serve-copy loads the copy into a local database server and points the store's local row at it`, served.line);
    const routesFile = join(scratch, `routes-${tag}.json`);
    const mk = await node("scripts/migrate-render.mjs", ["--make-routes", routesFile, "--tenant", X]);
    drill.check(mk.code === 0 && /hero/i.test(mk.out), `${label} 3.3: the route list (it says a hero test is running and keeps its name)`, mk.out.trim().split("\n").slice(-3));

    // ---- section 4: the dry run, with the founder ----
    dry = await ctx.migrate(["--tenant", X, "--dry-run"]);
    if (/^Not ready/.test(dry.out.split("\n")[0])) {
      const words = plainOf(dry.out);
      drill.check(/agency/i.test(words) && /Settings/.test(words) && noCodes(words), `${label} 4: the dry run says Not ready, in plain words: an agency has access, and where to remove it`, words.slice(0, 600));
      // the founder removes it where the report says: Settings, Agency access
      const actx = await drill.context({ width: 1440 });
      const apage = await drill.login("owner", { context: actx });
      await apage.goto(consoleUrl(ctx.base, `/admin/settings`), { waitUntil: "load", timeout: 120_000 });
      await settle(apage);
      const panel = apage.locator("#agency-access");
      await panel.waitFor({ timeout: 60_000 });
      await panel.scrollIntoViewIfNeeded();
      await panel.getByRole("button", { name: "Revoke" }).first().click();
      await apage.locator("dialog[open]").getByRole("button", { name: "Revoke" }).click();
      const gone = await waitFor(async () => (await panel.getByRole("button", { name: "Revoke" }).count()) === 0, 20_000);
      drill.check(Boolean(gone), `${label} 4: the founder removes the agency's access on the Settings page (Agency access, Revoke)`, null);
      await drill.screenshot(apage, "runbook-agency-removed-1440");
      await actx.close();
      record({ section: "4", what: "the dry run said Not ready (an agency has access); the agency's access removed on the Settings page (Agency access, Revoke), in Chrome", as: "Settings > Team: remove the agency's access", dev: "the report says 'Settings > Team', but the agency's access is its own panel, 'Agency access', further down the Settings page", fix: "section 4 says where: Settings, the 'Agency access' panel, Revoke (the report's own words are finding F3 for its owner)" });
      dry = await ctx.migrate(["--tenant", X, "--dry-run"]);
    }
    digest = digestOf(dry.out);
    drill.check(dry.code === 0 && /^Ready to move/.test(dry.out) && Boolean(digest) && noCodes(plainOf(dry.out)), `${label} 4: the dry run says Ready to move, in plain words, and ends with its digest`, plainOf(dry.out).slice(0, 800));

    // ---- section 5: the rehearsal, on the copy ----
    const out = join(scratch, `rehearsal-${tag}`);
    let reh = await ctx.migrate(["--tenant", X, "--rehearsal-run", "--db", served.url, "--base", ctx.base, "--routes", routesFile, "--out", out]);
    report = join(out, "rehearsal.json");
    if (!/Result: passed/.test(reh.out) && heroOnlyFailure(readReport(report))) {
      drill.note(`${label} 5: the rehearsal said: ${reh.out.trim().split("\n").slice(-2).join(" | ")}; rehearsing again on a fresh copy (finding F2 when only the hero differs)`);
      await served.stop();
      served = await serveCopyChild(ctx, file);
      reh = await ctx.migrate(["--tenant", X, "--rehearsal-run", "--db", served.url, "--base", ctx.base, "--routes", routesFile, "--out", `${out}-again`]);
      report = join(`${out}-again`, "rehearsal.json");
    }
    drill.check(reh.code === 0 && /Result: passed/.test(reh.out), `${label} 5: the rehearsal on the copy ends with Result: passed`, reh.out.trim().split("\n").slice(-3));
  } finally {
    const stopped = await served.stop();
    drill.check(stopped.pointedBack, `${label} 3.2: Ctrl-C on serve-copy points the store's row back at its own database and stops the copy's server`, stopped.tail);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  }
  drill.check(!existsSync(file), `${label} 3.1: the restore-drill copy (and its -wal and -shm files) deleted when the rehearsal is done`, null);
  return { digest, report, dry };
}

// ---------------------------------------------------------------- the stage

export async function runbookStage(drill) {
  const steps = [];
  // section: the runbook's section; as: the command as the runbook writes it;
  // ran: what ran on the harness; dev: what a non-developer could not have
  // known (null when the step was literal); fix: the runbook change made
  const record = (s) => {
    steps.push(s);
    drill.note(`runbook ${s.section}: ${s.what}${s.dev ? ` [developer knowledge: ${s.dev}]` : ""}`);
  };
  const { seed } = await reseedP4(drill, { start: true });
  const ctx = await harnessContext();
  const scratch = drillScratch("runbook");
  const X = ctx.store;
  const file = join(ROOT, `restore-drill-${X}.db`);
  try {
    await runbookSteps(drill, { seed, ctx, scratch, X, file, steps, record });
  } finally {
    // the copy holds the store's customer data: never left behind
    for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
    writeFileSync(STEPS_FILE, `${JSON.stringify({ ranAt: new Date().toISOString(), runbook: "docs/cms-reviews/P4-CUTOVER-RUNBOOK.md", steps }, null, 2)}\n`);
  }
}

async function runbookSteps(drill, { seed, ctx, scratch, X, file, steps, record }) {
  const node = (file, args) => runNode([join(ROOT, file), ...args], { env: ctx.env, timeoutMs: 600_000 });
  const plainOf = (out) => out.split("\nDetails")[0];
  const noCodes = (text) => !/\b(cms_|document_refs|product_content_live|search_outbox|rel_[0-9a-f]|doc_[a-z]|ver_[0-9a-f]|gid:\/\/)/.test(text);

  // ---- section 0: the database updates ----
  // the code block first, exactly as written: --all, then the check
  const all = await node("scripts/tenant-migrate.js", ["--all"]);
  let chk = await node("scripts/tenant-migrate.js", ["--check", "--include-env"]);
  if (chk.code !== 0 && /env store \(_default\): behind/.test(chk.out)) {
    drill.note(`runbook 0.1: the code block's two commands leave the env store behind: "${chk.out.trim().split("\n").find((l) => l.includes("_default"))?.slice(0, 160)}". The sentence above the block says to run pnpm migrate for it; running it, then the check again.`);
    const envm = await node("scripts/migrate.js", []);
    drill.check(envm.code === 0, "runbook 0.1: the env store's updates (pnpm migrate, the sentence above the code block)", envm.out.trim().split("\n").slice(-2));
    record({ section: "0.1", what: "the env store's updates: pnpm migrate", as: "in the sentence only ('the env store with pnpm migrate'); the code block lists --all and --check", ran: "node scripts/migrate.js (harness env)", dev: "the code block alone leaves the env store behind and the check then fails; pnpm migrate was only in the sentence", fix: "section 0.1's code block now lists pnpm migrate between --all and the check" });
    chk = await node("scripts/tenant-migrate.js", ["--check", "--include-env"]);
  }
  drill.check(all.code === 0 && chk.code === 0, "runbook 0.1: the database updates, then the check with the env store (--check --include-env) says every store is current", { all: all.out.trim().split("\n").slice(-2), check: chk.out.trim().split("\n").slice(-3) });
  record({ section: "0.1", what: "pnpm tenant:migrate -- --all, then --check --include-env", as: "pnpm tenant:migrate -- --all; pnpm tenant:migrate -- --check --include-env", ran: "node scripts/tenant-migrate.js --all; … --check --include-env (harness env)", dev: "the package scripts load .env.local (the hosted control plane); on the harness the same files run with the harness's own env", fix: "a 'Practising on the local harness' section says how each command runs locally" });
  record({ section: "0.2-0.4, 1, 2", what: "deploy order, staging atomicity, PITR, the quiet window, the founder warning, the backup time: owner steps with no harness equivalent (the backup time is only passed with --hosted)", dev: null });

  // ---- sections 3 to 5: the copy, the dry run, the rehearsal ----
  const H = { ctx, scratch, X, file, record, node, plainOf, noCodes };
  const pass1 = await copyRehearseDry(drill, { ...H, label: "runbook" });
  const digest = pass1.digest;
  const rehearsalReport = pass1.report;
  record({ section: "3.1", what: "the restore-drill copy (restore-drill.js --tenant X --keep)", as: "node --env-file=.env.local scripts/restore-drill.js --tenant X --keep", ran: "node scripts/restore-drill.js --tenant design --keep (harness env)", dev: null });
  record({ section: "3.2", what: "serve the copy with the local harness", as: "start the harness, load the copy into a local sqld database, and point a local control-plane row for store X at that sqld", ran: "node scripts/drills/p4/runbook.mjs serve-copy --copy restore-drill-design.db --tenant design (then Ctrl-C)", dev: "the runbook named no command for loading the file into sqld or for pointing the row; a developer had to write both", fix: "section 3.2 now gives the command (runbook.mjs serve-copy) and what to do when it is done (Ctrl-C: the row points back, the copy's server stops)" });
  record({ section: "3.3", what: "the route list (migrate-render --make-routes)", as: "node scripts/migrate-render.mjs --make-routes routes.json --tenant X", ran: "the same, harness env", dev: null });
  record({ section: "4", what: "the dry run (Ready to move, the digest kept)", as: "node --env-file=.env.local scripts/migrate-documents.js --tenant X --dry-run --hosted --confirm X", ran: "node scripts/migrate-documents.js --tenant design --dry-run (harness env, no --hosted --confirm)", dev: "--hosted --confirm X is refused on a local store ('Run it without --hosted'); the owner's real run needs it", fix: "the new 'Practising on the local harness' section lists what to leave out locally" });
  record({ section: "5", what: "the rehearsal on the copy (Result: passed)", as: "node --env-file=.env.local scripts/migrate-documents.js --tenant X --rehearsal-run --db <the copy's local address> --base http://localhost:<harness port> --routes routes.json --out rehearsal-X", ran: "the same with the harness env; --db is the address serve-copy printed", dev: null });

  // ---- section 8: a deliberate stop in 'migrating' ----
  const crash = await runNode([fileURLToPath(import.meta.url), "--crash-after", "backfilled", "--", "--tenant", X, "--dry-run-digest", digest, "--rehearsal", rehearsalReport], { env: ctx.env, timeoutMs: 600_000 });
  const mid = rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT mode FROM cms_state WHERE id = 1", "SELECT step, outcome, finished_at FROM cms_migration_runs ORDER BY started_at DESC LIMIT 1"].slice(0, 1)))[0])[0];
  const run = rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT step, outcome, finished_at FROM cms_migration_runs ORDER BY started_at DESC LIMIT 1"]))[0])[0];
  drill.check(crash.code !== 0 && mid.mode === "migrating" && run?.step === "backfilled" && run.finished_at == null, "runbook 8: the move stops midway (killed after its backfill): the store is left 'being updated', its run open at the backfill", { exit: crash.code, mode: mid.mode, run, tail: crash.out.trim().split("\n").slice(-2) });
  const st1 = await ctx.migrate(["--tenant", X, "--status"]);
  drill.check(st1.code === 0 && /being updated/i.test(st1.out) && /--resume/.test(st1.out) && /--abort/.test(st1.out) && noCodes(st1.out), "runbook 8: --status says, in plain words, that the store is being updated, which step finished, and to run --resume or --abort", st1.out.trim());
  record({ section: "8", what: "--status during the stop", as: "node --env-file=.env.local scripts/migrate-documents.js --tenant X --status --hosted --confirm X", ran: "node scripts/migrate-documents.js --tenant design --status (harness env)", dev: /--env-file=\.env\.local/.test(st1.out) ? "--status prints its next commands with --env-file=.env.local even on a local store: on the harness they must run with the harness env" : null, fix: "the harness section says the printed commands are for the real store; on the harness run them without --env-file" });
  // while it is being updated: the old editors refuse; shoppers still buy
  const bctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: bctx });
  const view = await page.evaluate(async () => (await fetch("/api/admin/storefront")).json().catch(() => null));
  const save = await page.evaluate(async (rev) => {
    const r = await fetch("/api/admin/storefront", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ block: "announcement", value: { enabled: true, text: "Saved while the store moves", href: "" }, revision: rev }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, view?.revisions?.announcement ?? null);
  const annNow = rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT value FROM cms_blocks WHERE key = 'announcement'"]))[0])[0];
  drill.check(save.status === 409 && /moving to the new editor right now, so nothing was saved/.test(String(save.body?.error || "")) && noCodes(String(save.body?.error || "")) && !String(annNow?.value || "").includes("Saved while the store moves"), "runbook 8 (and 0.3): while the store is being updated an old editor's save is refused in plain words and saves nothing", { status: save.status, words: save.body?.error });
  record({ section: "0.3 and 8", what: "an old editor's save while the store is being updated", as: "it must answer \"Your store is being updated. Try again in a few minutes.\"", ran: "the same save on the harness", dev: `the runbook quoted words the store no longer says; it answers: "${save.body?.error}"`, fix: "section 0.3 quotes the words the store says now" });
  const sctx = await shopperContext(drill, ctx.base, "p4-drills-runbook");
  const sp = await sctx.newPage();
  const home = await sp.goto(`${ctx.base}/`, { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  await noThanks(sp);
  drill.check(home?.status() === 200 && (await sp.locator("h1").count()) > 0, "runbook 8: shoppers still get the store while it is being updated", { status: home?.status() });
  await drill.screenshot(sp, "runbook-shopper-while-migrating-1440");
  const ab = await ctx.migrate(["--tenant", X, "--abort"]);
  const afterAbort = rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT mode FROM cms_state WHERE id = 1"]))[0])[0];
  const st2 = await ctx.migrate(["--tenant", X, "--status"]);
  drill.check(ab.code === 0 && afterAbort.mode === "legacy" && /old editor/i.test(st2.out) && noCodes(ab.out), "runbook 8: --abort puts the store back on the old editor in one step; --status says so", { abort: ab.out.trim().split("\n").slice(0, 4), status: st2.out.trim().split("\n")[0] });
  record({ section: "8", what: "--abort before the switch, back on the old editor", as: "--abort", ran: "node scripts/migrate-documents.js --tenant design --abort (harness env)", dev: null });
  const oldScreen = await page.goto(consoleUrl(ctx.base, `/admin/storefront`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  drill.check(oldScreen?.status() === 200 && new URL(page.url()).pathname === "/admin/storefront", "runbook 8: after --abort the old Storefront screen opens again", page.url());

  // ---- section 6: the move ----
  // the rehearsal made before the stop no longer matches: the stopped move
  // left its copied content in the new editor's tables
  const stale = await ctx.migrate(["--tenant", X, "--dry-run-digest", String(digestOf((await ctx.migrate(["--tenant", X, "--dry-run"])).out)), "--rehearsal", rehearsalReport]);
  drill.check(stale.code !== 0 && /changed since that rehearsal/.test(stale.out) && /rehearse again/i.test(stale.out), "runbook 8 → 6: after --abort the move refuses the rehearsal made before the stop, in plain words ('Make a fresh copy, rehearse again')", stale.out.trim().split("\n")[0]);
  record({ section: "8 → 6", what: "after --abort, the earlier rehearsal is refused ('The store changed since that rehearsal…')", as: "section 8 said only that the next move takes the old editor's content again", ran: "a fresh copy, rehearsal and dry run (sections 3 to 5 again), then the move", dev: "the runbook didn't say that after --abort the move needs a fresh copy, rehearsal and dry run", fix: "section 8 now says: after --abort, start again from section 3 (a fresh copy, the dry run, the rehearsal), then the move" });
  const pass2 = await copyRehearseDry(drill, { ...H, label: "after the abort" });
  const mv = await ctx.migrate(["--tenant", X, "--dry-run-digest", String(pass2.digest), "--rehearsal", pass2.report]);
  drill.check(mv.code === 0 && /Your store now uses the new editor\./.test(mv.out), "runbook 6: the move, with the digest and the fresh rehearsal, finishes", plainOf(mv.out).slice(-900));
  drill.check(/The store's look[\s\S]{0,200}Recorded\./.test(mv.out), "runbook 7.3: the move's report says 'Recorded.' under 'The store's look'", (mv.out.match(/The store's look[\s\S]{0,200}/) || [""])[0]);
  const pin = rowsOf((await sqlAt(ctx.urls.platform, [{ sql: "SELECT config FROM tenants WHERE id = ?", args: [X] }]))[0])[0];
  drill.check(/"theme_pin"/.test(String(pin?.config || "")), "runbook 7.3: the store's look is pinned in its control-plane row (theme_pin)", null);
  const st3 = await ctx.migrate(["--tenant", X, "--status"]);
  drill.check(/Your store uses the new editor\. No update is under way\./.test(st3.out), "runbook 8: --status after the move says the store uses the new editor", st3.out.trim().split("\n")[0]);
  record({ section: "6", what: "the move with the digest and the rehearsal report", as: "… --dry-run-digest <digest> --rehearsal rehearsal-X/rehearsal.json --hosted --confirm X --backup-ref <time>", ran: "node scripts/migrate-documents.js --tenant design --dry-run-digest <digest> --rehearsal <report> (harness env)", dev: null });

  // ---- section 7: post-checks ----
  const pairsProduct = seed.chosenProduct; // extra sections and goes-well-with
  const canaries = [
    { name: "home", path: "/" },
    { name: "page", path: "/policies/privacy-policy" },
    { name: "journal", path: "/journal" },
    { name: "product", path: pairsProduct.path },
    { name: "collection", path: seed.pinnedCollection.path },
  ];
  const bad = [];
  for (const c of canaries) {
    const res = await sp.goto(`${ctx.base}${c.path}`, { waitUntil: "load", timeout: 120_000 });
    await settle(sp);
    const t = await sp.locator("body").innerText();
    if (res?.status() !== 200 || /Something went wrong|Application error/i.test(t)) bad.push({ ...c, status: res?.status() });
  }
  await sp.goto(`${ctx.base}${pairsProduct.path}`, { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  await sp.locator("[data-pdp-template]").first().waitFor({ state: "visible", timeout: 90_000 });
  const pdp = await sp.evaluate(() => ({ modules: document.querySelectorAll('[data-sec="pdp-modules"] details').length, pairs: document.querySelector('[data-sec="pdp-pairs"] h2')?.innerText?.trim() }));
  await sp.getByRole("button", { name: "Add to cart", exact: true }).filter({ visible: true }).first().click();
  const drawer = sp.locator('[role="dialog"][aria-label="Shopping cart"]');
  const cartOk = await waitFor(async () => (await drawer.innerText()).includes(pairsProduct.title), 20_000);
  drill.check(bad.length === 0 && pdp.modules === 6 && pdp.pairs === pairsProduct.pairsTitle && Boolean(cartOk), "runbook 7.1: the shopper canaries load as before (home, a page, the journal, a product with extra sections and goes-well-with, a pinned collection, the cart)", { bad, pdp, cartOk: Boolean(cartOk) });
  await drill.screenshot(sp, "runbook-shopper-cart-after-move-1440");
  await page.goto(consoleUrl(ctx.base, `/admin/dashboard`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator('a[href="/admin/editor"]').filter({ visible: true }).first().click();
  await page.waitForURL(/\/admin\/editor/, { timeout: 60_000 });
  await page.locator("[data-document-editor]").first().waitFor({ timeout: 90_000 });
  const opens = [];
  for (const q of [`doc=doc_home`, `product=${encodeURIComponent(pairsProduct.id)}`, `collection=${encodeURIComponent(seed.pinnedCollection.id)}`]) {
    await page.goto(consoleUrl(ctx.base, `/admin/editor?${q}`), { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    opens.push({ q, ok: await page.locator("[data-document-editor]").first().waitFor({ timeout: 90_000 }).then(() => true).catch(() => false) });
  }
  const leads = [];
  for (const p of ["/admin/storefront", "/admin/catalog?product=" + encodeURIComponent(pairsProduct.id), "/admin/upsells"]) {
    await page.goto(`${ctx.base}${p}`, { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    await page.waitForURL((u) => u.pathname === "/admin/editor", { timeout: 30_000 }).catch(() => {});
    leads.push({ p, at: new URL(page.url()).pathname });
  }
  drill.check(opens.every((o) => o.ok) && leads.every((l) => l.at === "/admin/editor"), "runbook 7.2: signed in, the console's Editor opens the new editor; home, a product and a collection open; Storefront, Catalog and Upsells lead to it", { opens, leads });
  await drill.screenshot(page, "runbook-editor-after-move-1440");

  // ---- section 9: reversal (after a rename in the new editor) ----
  const prod = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT id, handle, title FROM products WHERE id = ?", args: [pairsProduct.id] }]))[0])[0];
  await page.goto(consoleUrl(ctx.base, `/admin/editor?product=${encodeURIComponent(prod.id)}`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator("[data-product-form]").waitFor({ timeout: 90_000 });
  await page.locator("#f-doc-title").fill(NEW_NAME);
  await waitSaved(page);
  const phase = await publishHere(page);
  drill.check(phase === "done", "runbook 9 (setup): the founder renames a product in the new editor and publishes", { phase });
  const rdry = await ctx.reverse(["--tenant", X, "--dry-run"]);
  const rdigest = /Reversal dry-run digest: ([0-9a-f]{64})/.exec(rdry.out)?.[1];
  drill.check(/^Ready to move back to the old editor/.test(rdry.out) && rdry.out.includes(`“${prod.title}”: new name (“${NEW_NAME}”)`) && Boolean(rdigest) && noCodes(plainOf(rdry.out)), "runbook 9.2: the reversal's dry run is ready and lists the product with its new name, in plain words", plainOf(rdry.out).slice(0, 900));
  const rv = await ctx.reverse(["--tenant", X, "--dry-run-digest", rdigest]);
  drill.check(rv.code === 0 && rv.out.startsWith("Your store is back on the old editor.") && /A message you can pass on/.test(rv.out) && /Set back to the old editor's look\./.test(rv.out), "runbook 9.4: the reversal finishes; the report sets the look back and ends with the message to pass on", plainOf(rv.out).slice(0, 1200));
  const rst = await ctx.reverse(["--tenant", X, "--status"]);
  drill.check(/Your store uses the old editor\. No reversal is under way\./.test(rst.out), "runbook 9: the reversal's --status says the store uses the old editor", rst.out.trim().split("\n")[0]);
  record({ section: "9", what: "the reversal's dry run, the reversal with its digest, its --status", as: "node --env-file=.env.local scripts/reverse-documents.js --tenant X --dry-run --hosted --confirm X; … --dry-run-digest <digest> --hosted --confirm X --backup-ref <time>", ran: "node scripts/reverse-documents.js --tenant design --dry-run, then --dry-run-digest <digest> (harness env)", dev: null });
  await sleep(1500);
  const pg = await sp.goto(`${ctx.base}${pairsProduct.path}`, { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  const h1 = (await sp.locator("h1").first().innerText()).trim();
  const searchText = await searchFor(sp, ctx.base, NEW_NAME.split(" ")[0]);
  await sp.goto(`${ctx.base}${seed.pinnedCollection.path}`, { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  const colText = await sp.locator("main").innerText();
  drill.check(pg?.status() === 200 && h1 === prod.title && !searchText.includes(NEW_NAME) && !colText.includes(NEW_NAME), "runbook 9.5: as a shopper the renamed product shows Shopify's name on its page, in its collection and in search", { h1 });
  const oldAgain = await page.goto(consoleUrl(ctx.base, `/admin/storefront`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  drill.check(oldAgain?.status() === 200 && new URL(page.url()).pathname === "/admin/storefront", "runbook 9.5: signed in, the old editors work again at once (Storefront opens)", page.url());
  await drill.screenshot(page, "runbook-old-editor-after-reversal-1440");

  // ---- the move again (sections 3 to 6) ----
  const pass3 = await copyRehearseDry(drill, { ...H, label: "the move again" });
  drill.check(pass3.dry.out.includes("Edits that come back at the move") && pass3.dry.out.includes(`“${prod.title}”: new name (“${NEW_NAME}”).`), "the move again: the dry run lists, by name, the edit that comes back", plainOf(pass3.dry.out).slice(-900));
  const mv2 = await ctx.migrate(["--tenant", X, "--dry-run-digest", String(pass3.digest), "--rehearsal", pass3.report]);
  drill.check(mv2.code === 0 && /Your store now uses the new editor\./.test(mv2.out), "the move again finishes", plainOf(mv2.out).slice(-600));
  await sleep(1500);
  await sp.goto(`${ctx.base}${pairsProduct.path}`, { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  const h1b = (await sp.locator("h1").first().innerText()).trim();
  drill.check(h1b === NEW_NAME, "after the move again, the shopper sees the name from the new editor", { h1: h1b });
  await sctx.close();
  await bctx.close();
  drill.note(`steps that needed developer knowledge: ${steps.filter((s) => s.dev).length} (runbook-steps.json)`);
  void readP4Seed;
  void DrillError;
  void assertLocal;
}

// ------------------------------------------------- serve-copy (runbook 3.2)
//
//   node scripts/drills/p4/runbook.mjs serve-copy --copy restore-drill-X.db --tenant X
//       (the harness running: DESIGN_PORT, DESIGN_SQLD_PORT, COPY_SQLD_PORT)
//   loads the copy into a second local database server and points the
//   harness's row for store X at it; Ctrl-C stops that server and points the
//   row back at the store's own local database. Local addresses only.
async function serveCopy(argv) {
  const val = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  const copyFile = val("copy");
  const tenant = val("tenant");
  if (!copyFile || !tenant) throw new Error("Use: node scripts/drills/p4/runbook.mjs serve-copy --copy restore-drill-X.db --tenant X");
  const ctx = await harnessContext();
  const row = rowsOf((await sqlAt(ctx.urls.platform, [{ sql: "SELECT db_url FROM tenants WHERE id = ?", args: [tenant] }]))[0])[0];
  if (!row) throw new Error(`The local harness has no store "${tenant}". Its control-plane row must be copied to the harness first (see the runbook, section 3.2).`);
  assertLocal(row.db_url);
  const own = row.db_url;
  const dir = drillScratch("serve-copy");
  const copy = await copyServer(dir);
  const loaded = await copyDatabase(pathToFileURL(resolve(copyFile)).href.replace(/^file:\/\//, "file:"), copy.url);
  await sqlAt(ctx.urls.platform, [{ sql: "UPDATE tenants SET db_url = ? WHERE id = ?", args: [copy.url, tenant] }]);
  // the harness reads a store's row through a short cache
  await sleep(Number(ctx.env.PLATFORM_CACHE_MS || 30_000) + 1500);
  console.log(`✓ the copy (${loaded.tables} tables, ${loaded.rows} rows) is served at ${copy.url}, and the harness's store "${tenant}" reads it. Use ${copy.url} as --db for the rehearsal, and http://localhost:${ctx.ports.next} as --base. Press Ctrl-C when the rehearsal is done.`);
  await new Promise((r) => process.once("SIGINT", r));
  await sqlAt(ctx.urls.platform, [{ sql: "UPDATE tenants SET db_url = ? WHERE id = ?", args: [own, tenant] }]);
  await copy.stop();
  console.log(`✓ the copy's server stopped; the store "${tenant}" reads ${own} again. Delete ${copyFile} and its -wal and -shm files now.`);
  process.exit(0);
}

// ------------------------------------------------------ --crash-after (drill)

async function crashAfter(argv) {
  const stepName = argv[0];
  const rest = argv.slice(1).filter((a, i) => !(i === 0 && a === "--"));
  for (const k of ["PLATFORM_DB_URL", "DATABASE_URL"]) assertLocal(process.env[k]);
  if (rest.includes("--hosted")) throw new Error("refusing: the crash drill never runs with --hosted");
  // the same resolution the command sets up for itself, before cutover.js loads
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
      if (/^next\/(server|headers|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
      return next(spec, ctx);
    },
  });
  const Cut = await import("../../../lib/migrate/cutover.js");
  Cut.__cutoverTestHooks.afterStep = async (name) => {
    if (name !== stepName) return;
    console.log(`(drill: the process stops here, right after "${name}", as a power cut would)`);
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  };
  process.argv = [process.argv[0], join(ROOT, "scripts", "migrate-documents.js"), ...rest];
  await import("../../migrate-documents.js");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...argv] = process.argv.slice(2);
  const go = cmd === "--crash-after" ? crashAfter(argv) : cmd === "serve-copy" ? serveCopy(argv) : Promise.reject(new Error("Use: node scripts/drills/p4/runbook.mjs serve-copy --copy restore-drill-X.db --tenant X (or run the 'runbook' stage through run.mjs)"));
  go.catch((e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  });
}
