// Browser drills on the design harness (P1-HARNESS, spec 8.15).
//
// Drives the desktop Chrome that is already installed, through playwright-core.
// It never downloads a browser. A drill is not a test:* suite: it needs a
// running harness and Chrome, so `pnpm test` never runs it.
//
//   pnpm drill:smoke                     product page at 375/768/1440, add to cart, drawer
//
// Drills run only in a throwaway worktree made by scripts/drills/run-isolated.mjs
// (pnpm drill:<name>), which sets DRILL_ISOLATED_ROOT to that worktree. The
// CLI refuses anywhere else, so a drill never seeds or drives the owner's
// harness and its .design-data/. Inside the worktree the runner calls
//   node scripts/drill.js <journey> [--start] [--headed]
//     --start   start the harness for this run and stop it after (when none is running)
//     --headed  show the browser window
//
// Journeys live in scripts/drills/<journey>.js. Each exports `id` (the folder
// under docs/cms-reviews/drills/ that gets its screenshots and results.json),
// `title`, and a default async function that receives a Drill.
//
// Env: DESIGN_PORT (default 3017) picks the harness, CHROME_BIN overrides the
// Chrome path. Screenshots are small PNGs (at most 300KB each).
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATA_DIR_NAME, bootBuilt, harnessPorts, readCredentials, ROOT, HarnessError, runningHarness } from "./design-harness.js";

export const WIDTHS = [375, 768, 1440];
const HEIGHTS = { 375: 812, 768: 1024, 1440: 900 };
export const MAX_SHOT_BYTES = 300 * 1024;
const SHOT_WIDTH = 720; // screenshots wider than this are scaled down to it
const MAX_SHOT_HEIGHT = 6000; // css px; taller full-page captures are cut here

// A problem the person running the drill can fix. Printed as one plain line.
export class DrillError extends Error {
  constructor(message) {
    super(message);
    this.name = "DrillError";
  }
}

// Drills run only in the throwaway worktree the isolated runner made: it sets
// DRILL_ISOLATED_ROOT to that worktree, and this checkout must be it.
export function assertIsolated(env = process.env, root = ROOT) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const want = String(env.DRILL_ISOLATED_ROOT ?? "").trim();
  if (!want || real(want) !== real(root)) {
    throw new DrillError(`Drills run only in a throwaway worktree, never in this checkout (${root}): use pnpm drill:<name> (p5, p6, smoke, agency-gone or all), which runs scripts/drills/run-isolated.mjs.`);
  }
  return root;
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

// CHROME_BIN first, then the usual install places. Never a download.
export function chromePath({ env = process.env, exists = isFile } = {}) {
  if (env.CHROME_BIN) {
    if (exists(env.CHROME_BIN)) return env.CHROME_BIN;
    throw new DrillError(`CHROME_BIN is set to ${env.CHROME_BIN}, but there is no file there. Fix the path, or unset CHROME_BIN.`);
  }
  const found = CHROME_PATHS.find((p) => exists(p));
  if (found) return found;
  throw new DrillError("Drills need desktop Google Chrome, and it isn't installed where the drill looks. Install Chrome, or set CHROME_BIN to its path. The drill never downloads a browser.");
}

export async function launchChrome({ env = process.env, headed = false } = {}) {
  const { chromium } = await import("playwright-core");
  return chromium.launch({ executablePath: chromePath({ env }), headless: !headed });
}

const isUp = async (baseUrl) => {
  try {
    const r = await fetch(`${baseUrl}/robots.txt`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
};

// Attach to a running harness, or (start: true) start one for this run. A
// drill only attaches to this checkout's own harness: one recorded as running
// in its .design-data/ on that port. Anything else on the port (another
// checkout's harness, another app) is refused, so a drill never switches
// maintenance on in someone else's store.
export async function connectHarness({ start = false, env = process.env, root = ROOT, log = console.log } = {}) {
  const { next } = harnessPorts(env);
  const baseUrl = `http://localhost:${next}`;
  if (await isUp(baseUrl)) {
    const ours = runningHarness(join(root, DATA_DIR_NAME));
    if (ours?.ports?.next !== next) {
      throw new DrillError(
        `Something is answering at ${baseUrl}, but it isn't this checkout's design harness (${root}). It may be another checkout's harness or another app. Stop it, or start this checkout's harness on free ports, for example DESIGN_PORT=3027 DESIGN_SQLD_PORT=18080 pnpm dev:design, and run the drill with the same DESIGN_PORT.`,
      );
    }
    return { baseUrl, port: next, creds: readCredentials(root), started: false, stop: async () => {} };
  }
  if (!start) {
    throw new DrillError(
      `The design harness isn't running at ${baseUrl}. Start it with ${next === 3017 ? "" : `DESIGN_PORT=${next} `}pnpm dev:design, wait for "Ready", then run the drill again. Or add --start to have the drill start and stop it.`,
    );
  }
  log(`• starting the design harness on ${baseUrl}`);
  const boot = async () => {
    const child = spawn(process.execPath, [join(root, "scripts/dev-design.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c) => (output = (output + c).slice(-20_000)));
    child.stderr.on("data", (c) => (output = (output + c).slice(-20_000)));
    const stop = () =>
      new Promise((done) => {
        if (child.exitCode !== null) return done();
        child.once("exit", done);
        child.kill("SIGTERM");
      });
    for (let i = 0; i < 360; i++) {
      if (child.exitCode !== null) throw new DrillError(`The harness stopped while starting:\n${output.trim().split("\n").slice(-8).join("\n")}`);
      if (await isUp(baseUrl)) return { output: () => output, stop };
      await new Promise((r) => setTimeout(r, 500));
    }
    await stop();
    throw new DrillError(`The harness didn't come up at ${baseUrl} within 3 minutes.`);
  };
  // the storefront and the console sign-in: compiled before the drill's
  // browser asks for them
  const h = await bootBuilt({ boot, baseUrl, paths: BOOT_PATHS });
  return { baseUrl, port: next, creds: readCredentials(root), started: true, stop: h.stop };
}
export const BOOT_PATHS = ["/", "/admin/login"];

// Scale a screenshot down until it fits MAX_SHOT_BYTES.
export async function compressShot(buf, { maxBytes = MAX_SHOT_BYTES } = {}) {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(buf).metadata();
  const widths = [...new Set([Math.min(meta.width, SHOT_WIDTH), 600, 480, 360].filter((w) => w <= meta.width))];
  let out = null;
  for (const width of widths) {
    for (const colours of [256, 128, 64, 32]) {
      out = await sharp(buf).resize({ width, withoutEnlargement: true }).png({ palette: true, colours, compressionLevel: 9, effort: 8 }).toBuffer();
      if (out.length <= maxBytes) return out;
    }
  }
  throw new DrillError(`A screenshot stayed over ${Math.round(maxBytes / 1024)}KB even at its smallest (${Math.round(out.length / 1024)}KB). Take a smaller one (no fullPage).`);
}

// DOM facts, computed inside the page (Drill.facts passes it to
// page.evaluate, so it may only use the page's own globals). Exported so the
// unit test can run it against a stand-in DOM.
export function pageFacts() {
  const text = document.body?.innerText || "";
  return {
    path: location.pathname + location.search,
    title: document.title,
    h1: [...document.querySelectorAll("h1")].map((h) => h.innerText.trim()).filter(Boolean),
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    images: document.images.length,
    brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src).slice(0, 5),
    errorPage: /Something went wrong|This page couldn.t load|Application error/i.test(text),
    text,
  };
}

export class Drill {
  constructor({ id, title, harness, browser, root = ROOT, log = console.log }) {
    if (!/^[A-Za-z0-9][\w.-]*$/.test(id || "")) throw new DrillError(`Drill id "${id}" can only hold letters, numbers, dots, dashes and underscores.`);
    this.id = id;
    this.title = title || id;
    this.harness = harness;
    this.browser = browser;
    this.root = root;
    this.log = log;
    this.dir = join(root, "docs", "cms-reviews", "drills", id);
    this.checks = [];
    this.shots = [];
    this.notes = [];
    mkdirSync(this.dir, { recursive: true });
  }

  get baseUrl() {
    return this.harness.baseUrl;
  }

  // A fresh browser context: its own cookies, nobody signed in.
  context({ width = 1440 } = {}) {
    return this.browser.newContext({ baseURL: this.baseUrl, viewport: { width, height: HEIGHTS[width] || 900 }, deviceScaleFactor: 1 });
  }

  // The merchant console, through the real sign-in form (empty email + the
  // harness's setup password from .design-env). Returns the signed-in page.
  async signIn(context) {
    const page = await context.newPage();
    await page.goto("/admin/login");
    await page.locator("#login-password").fill(this.harness.creds.DESIGN_ADMIN_PASSWORD || "");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    try {
      await page.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 });
    } catch {
      throw new DrillError("Signing in to the console didn't reach the dashboard. Check .design-env matches the seeded store (run pnpm seed:design if unsure).");
    }
    return page;
  }

  // The operator console, through its real sign-in form (bootstrap password).
  async signInOperator(context) {
    const page = await context.newPage();
    await page.goto("/platform");
    await page.locator("#pl-password").fill(this.harness.creds.PLATFORM_ADMIN_PASSWORD || "");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForResponse((r) => r.url().includes("/api/platform/login"), { timeout: 30_000 });
    await page.waitForLoadState("load");
    return page;
  }

  // Open a path (optionally at a width) and wait for it to settle.
  async open(page, path, { width } = {}) {
    if (width) await page.setViewportSize({ width, height: HEIGHTS[width] || 900 });
    const res = await page.goto(path, { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    return { status: res?.status() ?? 0, headers: res?.headers() ?? {} };
  }

  // DOM facts about the open page.
  facts(page) {
    return page.evaluate(pageFacts);
  }

  // Screenshot into docs/cms-reviews/drills/<id>/<name>.png, small.
  async shoot(page, name, { fullPage = false } = {}) {
    if (!/^[\w.-]+$/.test(name)) throw new DrillError(`Screenshot name "${name}" can only hold letters, numbers, dots, dashes and underscores.`);
    let clip;
    if (fullPage) {
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      if (h > MAX_SHOT_HEIGHT) clip = { x: 0, y: 0, width: page.viewportSize().width, height: MAX_SHOT_HEIGHT };
    }
    // caret "initial": hiding it makes Playwright inject caret-color on inputs, and a shot taken while a page
    // hydrates then trips React's hydration-mismatch warning (Phase 6 studio drill); these shots are not compared
    const raw = await page.screenshot({ fullPage, clip, animations: "disabled", caret: "initial" });
    const png = await compressShot(raw);
    const file = join(this.dir, `${name}.png`);
    writeFileSync(file, png);
    const sharp = (await import("sharp")).default;
    const meta = await sharp(png).metadata();
    const shot = { name, file: relative(this.root, file), bytes: png.length, width: meta.width, height: meta.height, viewport: page.viewportSize()?.width, path: new URL(page.url()).pathname };
    this.shots.push(shot);
    return shot;
  }

  // Open a path at each width, shoot it, return the facts per width.
  async atWidths(page, path, name, { widths = WIDTHS, fullPage = false } = {}) {
    const out = [];
    for (const width of widths) {
      const res = await this.open(page, path, { width });
      const facts = await this.facts(page);
      const shot = await this.shoot(page, `${name}-${width}`, { fullPage });
      out.push({ width, res, facts, shot });
    }
    return out;
  }

  // known: a check that is expected to fail until a named issue is fixed
  // elsewhere (for example "finding 5"). Its failure is recorded and printed as
  // KNOWN, and doesn't fail the drill; when it starts passing, the drill says
  // so, so the marker can be removed.
  check(ok, label, detail, { known } = {}) {
    const entry = { ok: Boolean(ok), label, ...(detail !== undefined ? { detail } : {}), ...(known ? { known } : {}) };
    this.checks.push(entry);
    const mark = entry.ok ? "ok  " : known ? "KNOWN" : "FAIL";
    this.log(`${mark} ${label}${!entry.ok && detail !== undefined ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}${!entry.ok && known ? ` [${known}]` : ""}`);
    if (entry.ok && known) this.note(`"${label}" passes now, so ${known} looks fixed: remove its known marker in the drill`);
    return entry.ok;
  }

  // Failed checks that aren't known issues.
  get failures() {
    return this.checks.filter((c) => !c.ok && !c.known);
  }

  note(text) {
    this.notes.push(text);
    this.log(`  · ${text}`);
  }

  // results.json next to the screenshots. A screenshot an earlier run of this
  // drill took and this run didn't is removed, so the folder matches the
  // results. Files the drill didn't make are left alone.
  finish({ error } = {}) {
    const keep = new Set(this.shots.map((s) => s.name));
    let earlier = [];
    try {
      earlier = JSON.parse(readFileSync(join(this.dir, "results.json"), "utf8")).screenshots || [];
    } catch {}
    for (const s of earlier) {
      if (s?.name && /^[\w.-]+$/.test(s.name) && !keep.has(s.name)) rmSync(join(this.dir, `${s.name}.png`), { force: true });
    }
    const failed = this.failures.length + (error ? 1 : 0);
    const results = {
      id: this.id,
      title: this.title,
      ranAt: new Date().toISOString(),
      harness: this.baseUrl,
      chrome: this.browser?.version?.() ?? null,
      passed: this.checks.filter((c) => c.ok).length,
      failed,
      knownFailures: this.checks.filter((c) => !c.ok && c.known).length,
      ...(error ? { aborted: String(error.message || error) } : {}),
      checks: this.checks,
      notes: this.notes,
      screenshots: this.shots,
    };
    writeFileSync(join(this.dir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    return results;
  }
}

// Let the page finish: network quiet (bounded), fonts and images loaded.
export async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page
    .evaluate(async () => {
      await document.fonts?.ready;
      await Promise.all(
        [...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => ((i.onload = i.onerror = r), setTimeout(r, 5000)))),
      );
    })
    .catch(() => {});
  await page.waitForTimeout(300);
}

// The drawer is always in the DOM and slides in from the right; "open" means
// its left edge is inside the window.
export async function drawerOpen(page) {
  return page.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label="Shopping cart"]');
    if (!d) return false;
    return d.getBoundingClientRect().left < window.innerWidth - 10;
  });
}

// ---------- CLI ----------

export async function main(argv = process.argv.slice(2)) {
  const [journey, ...flags] = argv;
  const unknown = flags.filter((f) => !["--start", "--headed"].includes(f));
  const journeys = readdirSync(join(ROOT, "scripts", "drills"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.slice(0, -3));
  if (!journey || unknown.length || !journeys.includes(journey)) {
    console.error(`Usage: node scripts/drill.js <journey> [--start] [--headed]\nJourneys: ${journeys.join(", ")}`);
    return 2;
  }
  try {
    assertIsolated();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return 2;
  }
  const mod = await import(pathToFileURL(join(ROOT, "scripts", "drills", `${journey}.js`)).href);
  let harness = null;
  let browser = null;
  let drill = null;
  let error = null;
  try {
    harness = await connectHarness({ start: flags.includes("--start") });
    browser = await launchChrome({ headed: flags.includes("--headed") });
    drill = new Drill({ id: mod.id, title: mod.title, harness, browser });
    console.log(`${mod.title}\nharness ${harness.baseUrl}, Chrome ${browser.version()}\n`);
    await mod.default(drill);
  } catch (e) {
    error = e;
    if (e instanceof DrillError || e instanceof HarnessError) console.error(`✗ ${e.message}`);
    else console.error(`✗ drill stopped: ${e.stack || e}`);
  } finally {
    const results = drill?.finish({ error });
    if (browser) await browser.close().catch(() => {});
    if (harness?.started) await harness.stop();
    if (results) {
      const known = results.knownFailures ? `, ${results.knownFailures} known failure${results.knownFailures === 1 ? "" : "s"} (expected until the issue named next to each is fixed)` : "";
      console.log(`\n${results.passed} passed, ${results.failed} failed${known}. Screenshots and results.json in ${relative(ROOT, drill.dir)}/`);
    }
  }
  if (!drill) return 1;
  return error || drill.failures.length ? 1 : 0;
}

// Not a top-level await: journeys import this module, so it must finish
// loading before main() imports them.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code));
}
