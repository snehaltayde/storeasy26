// P3-HARNESS: shared helpers for the phase 3 browser drills (batches 3 to 5),
// on the design harness (docs/cms-reviews/P1-HARNESS.md), in desktop Chrome
// through playwright-core (scripts/drill.js's launchChrome: the installed
// Chrome, never a download). Not a test:* suite: drills need a harness and
// Chrome, so pnpm test and CI never run them.
//
// Drills run only through pnpm drill:<name> (scripts/drills/run-isolated.mjs,
// a throwaway worktree): runDrill refuses unless DRILL_ISOLATED_ROOT is this
// checkout.
//
// What a drill gets:
//   p3Ports()                 the harness ports from DESIGN_PORT and
//                             DESIGN_SQLD_PORT. 3017 (the owner's harness) is refused.
//   runDrill(spec, fn)        launches Chrome, gives fn a P3Drill, writes the
//                             results file, closes Chrome and stops the harness
//                             it started. Refuses a harness someone else started
//                             in this checkout (a reseed would wipe it).
//   startOwned()              starts the harness and points the closed store's
//                             tenant row at this run's third server
//   reseed(drill, {start})    stops the harness this run started, seeds it fresh
//                             (node scripts/seed-design-documents.js --p3: the
//                             perf seed, the documents store and the phase 3
//                             drill content) and starts it again. Returns the
//                             seed config (readSeed()).
//   readSeed()                .design-data/p3-seed.json: stores, logins, document
//                             ids and live addresses, the publish set
//   drill.login(role, opts)   'owner' | 'staff' through the real sign-in form,
//                             by email, with the seeded passwords. opts.store
//                             'closed' signs in to the closed store (owner only,
//                             its setup password: it has no members).
//   drill.clickCounter(ctx)   counts every real click in a browser context,
//                             across navigations; a second call for the same
//                             context returns the same counter
//   drill.screenshot(page, name)  a small PNG in the drill's results folder
//   drill.writeResults()      results-<part>.json in the results folder, in the
//                             P2 drill format
//   storeUrl(drill, store, path)  an absolute address on 'live' or 'closed'
//   storeSql(store, stmts)    read a store's local database (the running harness's ports)
//   docsApi(page, body)       PUT /api/admin/documents from a signed-in page
//
// The results folder is docs/cms-reviews/drills/<id>/: screenshots and
// results-<part>.json together.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Drill, DrillError, assertIsolated, connectHarness, launchChrome, settle } from "../../drill.js";
import { DATA_DIR_NAME, ROOT, harnessPorts, harnessUrls, readCredentials, runningHarness } from "../../design-harness.js";
import { pointClosedStoreAt } from "../../seed-design-documents.js";

export { DrillError, assertIsolated, settle };
export const OWNER_PORT = 3017;
export const SEED_FILE = join(ROOT, DATA_DIR_NAME, "p3-seed.json");
const CONSOLE_HOME = /\/admin\/dashboard/;

// ---------- ports ----------

export function p3Ports(env = process.env) {
  const ports = harnessPorts(env);
  if (ports.next === OWNER_PORT || String(env.DESIGN_PORT ?? "").trim() === "") {
    throw new DrillError(`Set DESIGN_PORT (and DESIGN_SQLD_PORT) to this run's own ports, for example DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880. Port ${OWNER_PORT} is the owner's harness and a drill never uses it.`);
  }
  if (String(env.DESIGN_SQLD_PORT ?? "").trim() === "") throw new DrillError("Set DESIGN_SQLD_PORT to this run's own database ports too (three in a row from there).");
  return ports;
}

// ---------- running a node script of this checkout ----------

export function runNode(args, { env = process.env, cwd = ROOT, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const t = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

// ---------- the seed ----------

export function readSeed() {
  try {
    return JSON.parse(readFileSync(SEED_FILE, "utf8"));
  } catch {
    throw new DrillError(`There is no phase 3 seed config (${DATA_DIR_NAME}/p3-seed.json). Run the drills with pnpm drill:p5 (or drill:smoke), which seeds a throwaway worktree.`);
  }
}

// The seed's facts, read only: node scripts/seed-design-documents.js check --p3.
export async function seedState() {
  const r = await runNode([join(ROOT, "scripts", "seed-design-documents.js"), "check", "--p3"]);
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (r.code !== 0 || !line) throw new DrillError(`check --p3 failed: ${r.out.trim().split("\n").slice(-2).join(" ")}`);
  return JSON.parse(line);
}

// The harness this run started (one per process).
const owned = { harness: null, drills: new Set(), closedRepointed: null };
export const closedRepointed = () => owned.closedRepointed;
// P3-FIX2: one click counter per browser context (exposeBinding throws on a
// second call for the same name)
const counters = new WeakMap();
// Console cookies per sign-in, for this seed (the sign-in route allows 5 tries
// a minute per address, so each role signs in through the form once per seed).
let signedIn = new Map();

// TEMP DIAG (login flake): what the server said when the sign-in form didn't show.
export async function loginDiag(drill, page, res, url, tag) {
  const { spawnSync } = await import("node:child_process");
  const out = [];
  out.push(`url ${url} status ${res?.status()} headers ${JSON.stringify(res ? await res.allHeaders().catch(() => null) : null)}`);
  out.push(`page.url ${page.url()}`);
  out.push(`listener ${spawnSync("lsof", ["-nP", `-iTCP:${drill.harness.port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout}`);
  try { out.push(`pidfile ${readFileSync(join(ROOT, DATA_DIR_NAME, "harness.pid.json"), "utf8")}`); } catch (e) { out.push(`pidfile ${e.message}`); }
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { accept: "text/html" } });
      const b = await r.text();
      out.push(`refetch ${i} ${r.status} form=${b.includes("login-email")} 404page=${b.includes("This page could not be found")} hdr=${JSON.stringify(Object.fromEntries(r.headers))}`);
    } catch (e) { out.push(`refetch ${i} error ${e.message}`); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  for (const p of ["/admin/login", "/admin/dashboard", "/admin/reset", "/platform", "/signup", "/zzz-nope", "/about", "/collections", "/api/health", "/robots.txt"]) {
    try {
      const r = await fetch(new URL(p, url), { redirect: "manual", headers: { accept: "text/html" } });
      const b = await r.text();
      out.push(`route ${p} ${r.status} builtin404=${b.includes("This page could not be found")} console404=${b.includes("This console page")} len=${b.length}`);
    } catch (e) { out.push(`route ${p} error ${e.message}`); }
  }
  const { readdirSync, statSync } = await import("node:fs");
  try { out.push(`disk login page ${statSync(join(ROOT, "app/(console)/admin/(auth)/login/page.js")).mtime.toISOString()}; (console)/admin: ${readdirSync(join(ROOT, "app/(console)/admin")).join(",")}; app: ${readdirSync(join(ROOT, "app")).join(",")}`); } catch (e) { out.push(`disk ${e.message}`); }
  out.push(`overlay ${await page.evaluate(() => [...document.querySelectorAll("nextjs-portal")].map((p) => p.shadowRoot?.textContent || "").join(" | ").slice(0, 3000)).catch((e) => e.message)}`);
  out.push(`html ${(await page.content().catch(() => "")).slice(0, 6000)}`);
  out.push(`---- harness output ----\n${owned.harness?.output?.() ?? "(none)"}`);
  writeFileSync(join(drill.dir, `diag-${drill.part}-${tag}-${Date.now()}.log`), out.join("\n"));
}

export async function stopOwned() {
  if (owned.harness?.started) await owned.harness.stop();
  owned.harness = null;
}

export async function startOwned() {
  if (owned.harness) return owned.harness;
  const h = await connectHarness({ start: true, log: () => {} });
  owned.harness = h;
  for (const d of owned.drills) Object.assign(d.harness, h);
  // P3-FIX2: the closed store borrows the harness's third server; point its
  // tenant row at this run's ports before any request reaches it (the harness
  // itself re-points only the design store)
  owned.closedRepointed = await pointClosedStoreAt(harnessUrls(harnessPorts()));
  // the first request compiles the storefront; let it finish before anything is measured
  await fetch(`${h.baseUrl}/`).catch(() => {});
  return h;
}

// Seed fresh and (start: true) start the harness again. Returns { seed, out }.
export async function reseed(drill, { start = true, flags = [] } = {}) {
  await stopOwned();
  const r = await runNode([join(ROOT, "scripts", "seed-design-documents.js"), "--p3", ...flags]);
  const line = r.out.split("\n").filter((l) => /^[✓✗]/.test(l)).pop() || r.out.trim().split("\n").pop();
  if (r.code !== 0) throw new DrillError(`seeding the phase 3 store failed: ${line}`);
  signedIn = new Map();
  if (start) await startOwned();
  drill?.note(`re-seeded fresh${flags.length ? ` (${flags.join(" ")})` : ""}: ${line.replace(/^✓ /, "")}`);
  return { seed: readSeed(), out: r.out };
}

// ---------- addresses and databases ----------

export function storeUrl(drill, store, path = "/") {
  const host = store === "closed" ? readSeed().stores.closed.host : "localhost";
  return `http://${host}:${drill.harness.port}${path}`;
}

// A store's local database, through the running harness's pid file. The
// closed store lives on the harness's third server (see the seed).
export async function storeSql(store, statements) {
  const pid = JSON.parse(readFileSync(join(ROOT, DATA_DIR_NAME, "harness.pid.json"), "utf8"));
  const port = pid?.ports?.sqld?.[store === "closed" ? "default" : store === "platform" ? "platform" : "tenant"];
  if (!port) throw new DrillError("The running harness's pid file names no database port for that store.");
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: `http://127.0.0.1:${port}` });
  try {
    const out = [];
    for (const s of statements) out.push(await c.execute(typeof s === "string" ? { sql: s, args: [] } : s));
    return out;
  } finally {
    c.close();
  }
}

// The documents console API, from a signed-in page (same origin, real cookies).
export function docsApi(page, body) {
  return page.evaluate(async (b) => {
    const r = await fetch("/api/admin/documents", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, body);
}

export const bodyText = (page) => page.evaluate(() => document.body?.innerText || "");

// Answer the cookie banner the privacy-preserving way, if it shows.
export async function noThanks(page) {
  const b = page.getByRole("button", { name: "No thanks", exact: true });
  if (await b.count().catch(() => 0)) await b.first().click({ timeout: 3000 }).catch(() => {});
}

// ---------- the drill ----------

export class P3Drill extends Drill {
  constructor({ part, ...rest }) {
    super(rest);
    this.part = part || "main";
  }

  // 'owner' | 'staff', through the real form. A context reused for the same
  // sign-in gets the cookies again instead of a second sign-in.
  async login(role, { context, store = "live" } = {}) {
    if (!["owner", "staff"].includes(role)) throw new DrillError(`login() takes 'owner' or 'staff', not "${role}".`);
    if (store === "closed" && role !== "owner") throw new DrillError("The closed store has no staff login: it has no members, only its setup password.");
    const ctx = context || (await this.context());
    const key = `${store}:${role}`;
    const home = storeUrl(this, store, "/admin/dashboard");
    if (signedIn.has(key)) {
      await ctx.addCookies(signedIn.get(key));
      const page = await ctx.newPage();
      await page.goto(home);
      if (CONSOLE_HOME.test(new URL(page.url()).pathname)) return page;
      await page.close();
      signedIn.delete(key);
    }
    const seed = readSeed();
    const page = await ctx.newPage();
    const res = await page.goto(storeUrl(this, store, "/admin/login"));
    if (!(await page.locator("#login-password").waitFor({ timeout: 30_000 }).then(() => true, () => false))) {
      await this.shoot(page, `login-not-shown-${role}`).catch(() => {});
      await loginDiag(this, page, res, storeUrl(this, store, "/admin/login"), role).catch((e) => console.error("diag failed", e));
      const text = (await bodyText(page).catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      throw new DrillError(`The sign-in form didn't show for ${role}: ${res?.status() ?? "no answer"} at ${page.url()}: "${text}"`);
    }
    if (store === "live") await page.locator("#login-email").fill(seed.logins[role].email);
    await page.locator("#login-password").fill(store === "live" ? seed.logins[role].password : readCredentials(ROOT).DESIGN_ADMIN_PASSWORD || "");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    try {
      await page.waitForURL(CONSOLE_HOME, { timeout: 30_000 });
    } catch {
      throw new DrillError(`Signing in as ${role}${store === "closed" ? " on the closed store" : ""} didn't reach the dashboard. Reseed (the logins are made fresh by every seed).`);
    }
    const host = new URL(home).hostname;
    signedIn.set(
      key,
      (await ctx.cookies()).filter((c) => c.name !== "_preview" && c.domain.replace(/^\./, "") === host),
    );
    return page;
  }

  // Counts every real (trusted) click in this context, on every page and
  // across navigations. { count, clicks: [{ n, path, tag, text }], reset(), mark() }
  async clickCounter(context) {
    if (counters.has(context)) return counters.get(context);
    const counter = {
      clicks: [],
      get count() {
        return this.clicks.length;
      },
      reset() {
        this.clicks.length = 0;
      },
      // the clicks since an earlier count: const m = c.mark(); …; c.since(m)
      mark() {
        return this.clicks.length;
      },
      since(mark) {
        return this.clicks.length - mark;
      },
    };
    counters.set(context, counter);
    await context.exposeBinding("__p3Click", (_src, info) => {
      counter.clicks.push({ n: counter.clicks.length + 1, ...info });
    });
    await context.addInitScript(() => {
      document.addEventListener(
        "click",
        (e) => {
          if (!e.isTrusted || typeof window.__p3Click !== "function") return;
          const t = e.target instanceof Element ? e.target.closest("a,button,[role=button],input,label,summary,[data-section-id]") || e.target : null;
          window.__p3Click({ path: location.pathname, tag: t?.tagName?.toLowerCase() ?? null, text: (t?.innerText || t?.getAttribute?.("aria-label") || "").trim().slice(0, 60) });
        },
        true,
      );
    });
    return counter;
  }

  screenshot(page, name, opts) {
    return this.shoot(page, name, opts);
  }

  // results-<part>.json in the results folder, in the P2 drill format.
  writeResults({ error } = {}) {
    const results = {
      id: this.id,
      part: this.part,
      title: this.title,
      ranAt: new Date().toISOString(),
      harness: this.baseUrl,
      chrome: this.browser?.version?.() ?? null,
      passed: this.checks.filter((c) => c.ok).length,
      failed: this.failures.length + (error ? 1 : 0),
      knownFailures: this.checks.filter((c) => !c.ok && c.known).length,
      ...(error ? { aborted: String(error.stack || error.message || error).slice(0, 2000) } : {}),
      checks: this.checks,
      notes: this.notes,
      screenshots: this.shots,
    };
    writeFileSync(join(this.dir, `results-${this.part}.json`), `${JSON.stringify(results, null, 2)}\n`);
    return results;
  }
}

// Run one drill part: Chrome up, fn(drill), results written, everything this
// run started stopped. Exit code: 0 when nothing failed (known failures aside).
export async function runDrill({ id, part, title, headed = process.argv.includes("--headed") }, fn) {
  assertIsolated(process.env, ROOT);
  const ports = p3Ports();
  const ours = runningHarness(join(ROOT, DATA_DIR_NAME));
  if (ours) throw new DrillError(`A design harness is already running in this checkout (pid ${ours.launcher.pid}). Phase 3 drills seed the store fresh and start their own: stop it first.`);
  const harness = { baseUrl: `http://localhost:${ports.next}`, port: ports.next, creds: {} };
  const browser = await launchChrome({ headed });
  const drill = new P3Drill({ id, part, title: title || `${id} — ${part}`, harness, browser });
  owned.drills.add(drill);
  console.log(`== ${drill.title} (harness ${harness.baseUrl}, Chrome ${browser.version()})`);
  let error = null;
  try {
    await fn(drill);
  } catch (e) {
    error = e;
    console.error(`✗ ${part} stopped: ${e instanceof DrillError ? e.message : e.stack || e}`);
  }
  let r;
  try {
    r = drill.writeResults({ error });
  } finally {
    owned.drills.delete(drill);
    await browser.close().catch(() => {});
    await stopOwned();
  }
  console.log(`-- ${part}: ${r.passed} passed, ${r.failed} failed${r.knownFailures ? `, ${r.knownFailures} known` : ""}. Results in docs/cms-reviews/drills/${id}/results-${drill.part}.json`);
  return r.failed ? 1 : 0;
}
