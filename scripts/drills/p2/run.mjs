// P2-DRILLS runner: phase 2 browser drills on the design harness, in desktop
// Chrome, part by part (the style of scripts/drills/p1/run.mjs). Not a gate
// suite and not a package.json script: it needs a running harness and Chrome.
//
//   DESIGN_PORT=3800 DESIGN_SQLD_PORT=4800 node scripts/drills/p2/run.mjs [part,part…] [--headed]
//
// The runner starts and stops this checkout's design harness itself, on
// DESIGN_PORT and DESIGN_SQLD_PORT (never 3017 for agents), and re-seeds it
// before every part that changes the store: it stops the harness, seeds it
// fresh (node scripts/dev-design.js seed [--fixture perf]), adds the
// documents store (scripts/seed-design-documents.js) and starts it again. A
// harness already running in this checkout is refused, so a drill never
// wipes one somebody else started. The documents tables are only ever
// written through lib/documents (the write guards), so a fresh seed is the
// only way back to a known state.
//
// Parts (all of them when none is named):
//   on a documents store (the perf seed plus scripts/seed-design-documents.js)
//     sections      every registered section kind at 375, 768 and 1440, worst-case fixtures
//     hero-image    a hero image set and published through the documents API
//     policy-typo   a policy fix published while the home draft is dirty and incomplete
//     preview       the overlay before and after the first publish, the colours toggle,
//                   an old-format token, signing out of the console
//     unfinished    the "not finished yet" note in a preview, and its click target
//     redirect      /api/preview?to=<hostile> lands on the store's own origin
//     error-chrome  a corrupted live list: the error page with neutral chrome
//     edge          x-edge-runtime: 1 on the v4 storefront routes
//     space         the perf fixture and documents seed CLIs from a path with a space
//   on the plain legacy seed
//     legacy        pnpm drill:smoke and drill:edge, unchanged
//
// It signs in to the console through the real form once per seed (a fresh
// seed has no sessions) and reuses the cookies within it. Results go to
// scripts/drills/p2/results-<part>.json, screenshots to
// docs/cms-reviews/drills/P2-DRILLS/.
//
// P3-DRILLS: the four P2-DRILLS findings are fixed in phase 3, so their checks
// are plain checks now (FLIPPED below), without editing the part files:
//   finding 1  logout ends the preview (P3-SESSION): the preview part's known
//              check is a plain check
//   finding 2  the Designer can't preview a documents store: retired, because
//              the Designer redirects to the new editor on a documents store
//              (P3-ROUTES); replaced by the editor preview check after the
//              unfinished part (the note's click selects the section there)
//   finding 3  a missing chrome version alone gives the error page (P3-CLOSED):
//              the error-chrome part's recorded note becomes a check
//   finding 4  before its first publish a store shows "Opening soon", not the
//              error page (P3-CLOSED): the preview part's --drafts-only note
//              becomes a check
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Drill, DrillError, connectHarness, launchChrome, settle } from "../../drill.js";
import { DATA_DIR_NAME, ROOT, harnessPorts, readSeeded, runningHarness } from "../../design-harness.js";

const here = dirname(fileURLToPath(import.meta.url));

export const PART_FILES = {
  sections: "sections.mjs",
  "hero-image": "publish.mjs",
  "policy-typo": "publish.mjs",
  "error-chrome": "publish.mjs",
  edge: "publish.mjs",
  preview: "preview.mjs",
  unfinished: "preview.mjs",
  redirect: "preview.mjs",
  space: "run.mjs",
  legacy: "run.mjs",
};

// ---------- shared helpers for the parts ----------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a node script of this checkout with the harness ports; resolves { code, out }.
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

// The harness this run owns: stopped, seeded fresh, started again.
const owned = { harness: null, drills: new Set() };

async function stopOwned() {
  if (owned.harness?.started) await owned.harness.stop();
  owned.harness = null;
}

// Seed the harness fresh and start it. kind "documents": the perf seed plus
// scripts/seed-design-documents.js <flags>; kind "legacy": the plain seed.
export async function reseed(drill, flags = [], { kind = "documents" } = {}) {
  await stopOwned();
  const seed = await runNode([join(ROOT, "scripts", "dev-design.js"), "seed", ...(kind === "documents" ? ["--fixture", "perf"] : [])]);
  if (seed.code !== 0) throw new DrillError(`seeding the harness failed: ${seed.out.trim().split("\n").slice(-2).join(" ")}`);
  let line = "the plain legacy seed";
  if (kind === "documents") {
    const r = await runNode([join(ROOT, "scripts", "seed-design-documents.js"), ...flags]);
    line = r.out.split("\n").filter((l) => /^[✓✗]/.test(l)).pop() || r.out.trim().split("\n").pop();
    if (r.code !== 0) throw new DrillError(`seeding the documents store failed: ${line}`);
  }
  const h = await connectHarness({ start: true, log: () => {} });
  owned.harness = h;
  for (const d of owned.drills) Object.assign(d.harness, h);
  adminCookies = null; // a fresh seed has no console sessions
  // the first request compiles the storefront; let it settle before the part measures anything
  await fetch(`${h.baseUrl}/`).catch(() => {});
  drill.note(`re-seeded fresh${flags.length ? ` (${flags.join(" ")})` : ""}: ${line.replace(/^✓ /, "")}`);
}

// The documents console API, from a signed-in page (same origin, real cookies).
export function docsApi(page, body) {
  return page.evaluate(async (b) => {
    const r = await fetch("/api/admin/documents", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, body);
}

export async function getDoc(page, id) {
  const r = await docsApi(page, { getDocument: id });
  if (r.status !== 200) throw new DrillError(`getDocument ${id} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body.document;
}

// Save a draft body (on the revision it was read at). Returns the API answer.
export async function saveDraft(page, doc, body) {
  return docsApi(page, { saveDraft: { id: doc.id, body }, revision: doc.revision });
}

export async function publishDoc(page, doc) {
  return docsApi(page, { publish: { id: doc.id, draftHash: doc.draftHash }, revision: doc.revision });
}

// Save then publish one document's body; returns { save, publish, doc }.
export async function saveAndPublish(page, id, mutate) {
  const doc = await getDoc(page, id);
  const body = mutate(structuredClone(doc.body));
  const save = await saveDraft(page, doc, body);
  if (save.status !== 200) return { save, publish: null, doc: null };
  const saved = save.body.document;
  const publish = await publishDoc(page, saved);
  return { save, publish, doc: saved };
}

// The library photo upload, through the console's own media route.
export function uploadPhoto(page, { bytesBase64, filename, mime, alt, width, height }) {
  return page.evaluate(
    async (f) => {
      const bin = Uint8Array.from(atob(f.bytesBase64), (c) => c.charCodeAt(0));
      const fd = new FormData();
      fd.append("file", new File([bin], f.filename, { type: f.mime }));
      fd.append("alt", f.alt);
      fd.append("width", String(f.width));
      fd.append("height", String(f.height));
      const r = await fetch("/api/admin/media", { method: "POST", body: fd });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { bytesBase64, filename, mime, alt, width, height },
  );
}

// Answer the cookie banner the privacy-preserving way, if it shows.
export async function noThanks(page) {
  const b = page.getByRole("button", { name: "No thanks", exact: true });
  if (await b.count().catch(() => 0)) await b.first().click({ timeout: 3000 }).catch(() => {});
}

export const bodyText = (page) => page.evaluate(() => document.body?.innerText || "");

// The store's own local databases, through the running harness's pid file.
export async function tenantSql(statements) {
  const pid = JSON.parse(readFileSync(join(ROOT, DATA_DIR_NAME, "harness.pid.json"), "utf8"));
  const port = pid?.ports?.sqld?.tenant;
  if (!port) throw new DrillError("The running harness's pid file names no store database port.");
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

export { settle };

// ---------- the runner ----------

// The console's sign-in allows 5 tries a minute per address. Sign in through
// the real form once per run, then give later contexts the same cookies.
let adminCookies = null;

class PartDrill extends Drill {
  async signIn(context) {
    if (adminCookies) {
      await context.addCookies(adminCookies);
      const page = await context.newPage();
      await page.goto("/admin/dashboard");
      if (new URL(page.url()).pathname.startsWith("/admin/dashboard")) return page;
      await page.close();
      adminCookies = null;
    }
    const page = await super.signIn(context);
    adminCookies = (await context.cookies()).filter((c) => c.name !== "_preview");
    return page;
  }

  // A signed-in page whose cookies are dropped from the shared set (it signs out).
  forgetSignIn() {
    adminCookies = null;
  }

  // P3-DRILLS: the former known checks, flipped (see the top of this file).
  check(ok, label, detail, opts = {}) {
    // a check whose words changed in phase 3: checked again, with the new
    // words, on the page the part screenshots next (REWORDED)
    if (REWORDED[label]) {
      this.reworded = { ...REWORDED[label], label, was: Boolean(ok) };
      return true;
    }
    const flip = opts?.known ? FLIPPED[opts.known] : null;
    if (!flip) return super.check(ok, label, detail, opts);
    if (flip.retired) {
      super.note(`retired: "${label}" (${opts.known}): ${flip.retired}`);
      this.ran.add(`retired: ${opts.known}`);
      return true;
    }
    return super.check(ok, label, detail);
  }

  // P3-FIX5: what ran, for the flip guard (check labels are read from checks)
  get ran() {
    this._ran ??= new Set();
    return this._ran;
  }

  async shoot(page, name, opts) {
    const r = this.reworded;
    if (r && r.shot === name) {
      this.reworded = null;
      this.ran.add(`reworded: ${r.label}`);
      const facts = await page.evaluate(r.facts).catch((e) => ({ error: String(e) }));
      super.check(r.ok(facts), r.newLabel, { ...facts, oldCheck: r.label, oldResult: r.was });
    }
    return super.shoot(page, name, opts);
  }

  note(text) {
    super.note(text);
    for (const f of NOTE_CHECKS) {
      const m = f.match.exec(text);
      if (m) super.check(f.ok(m), f.label(m), text.slice(0, 300));
    }
  }

  finishPart(part, { error } = {}) {
    // P3-FIX5: a flipped check whose label (or note, or shot) changed in its
    // part file would silently vanish; every expected one must have run
    if (!error) {
      for (const missing of missingFlips(part, { labels: this.checks.map((c) => c.label), ran: this.ran, pendingReworded: this.reworded })) {
        super.check(false, `flip guard: "${missing}" ran in ${part}`, { why: "a flipped P2 check is missing from the results: its part's label, note or screenshot name probably changed; update FLIPPED, NOTE_CHECKS, REWORDED or EXPECTED_FLIPS in scripts/drills/p2/run.mjs" });
      }
    }
    const results = {
      id: this.id,
      part,
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
    writeFileSync(join(here, `results-${part}.json`), `${JSON.stringify(results, null, 2)}\n`);
    return results;
  }
}

// ---------- P3-DRILLS: the former known checks ----------

// A known marker whose issue is fixed: its check is plain now, or retired.
export const FLIPPED = {
  "finding 1": { fixedBy: "P3-SESSION (logout ends the preview)" },
  "finding 2": { fixedBy: "P3-ROUTES", retired: "the Designer redirects to the new editor on a documents store, so it is never reached; the editor preview check after this part replaces it" },
};

// The preview part's --drafts-only bar check looked for the word "preview"
// and the old Exit link. P3-FRAME's documents preview bar says "You're seeing
// your unpublished changes." with "See the live store" (/api/preview?exit=1&to=…),
// so the same check is made with those words.
export const REWORDED = {
  "before the first publish: the preview bar shows": {
    shot: "preview-before-first-publish-1440",
    newLabel: "before the first publish (--drafts-only): the preview bar shows, in the documents preview's words (\"You're seeing your unpublished changes.\", See the live store)",
    facts: () => {
      const a = [...document.querySelectorAll('a[href*="/api/preview?exit=1"]')].find((x) => /See the live store/.test(x.textContent));
      const bar = a ? a.parentElement : null;
      return { words: bar ? bar.innerText.replace(/\s+/g, " ").slice(0, 200) : null, href: a ? a.getAttribute("href") : null };
    },
    ok: (f) => Boolean(f.words && /You.re seeing your unpublished changes/.test(f.words) && /^\/api\/preview\?exit=1&to=/.test(f.href || "")),
  },
};

// Recorded notes that are checks now (finding 3 and the --drafts-only line).
export const NOTE_CHECKS = [
  {
    // preview.mjs: `before the first publish a shopper gets ${status} at /: ${text}`
    match: /^before the first publish a shopper gets (\d+) at \/: (.*)$/s,
    ok: (m) => m[1] === "200" && /Opening soon/.test(m[2]) && !/Something went wrong/.test(m[2]),
    label: () => "before the first publish (--drafts-only): a shopper gets 200 'Opening soon', not the error page (finding 4, P3-CLOSED)",
  },
  {
    // publish.mjs: `${path} with only doc_header's version missing: status ${s}, error page ${e}, h1 …`
    match: /^(\S+) with only doc_header's version missing: status (\d+), error page (true|false)/,
    ok: (m) => m[3] === "true" && Number(m[2]) >= 500,
    label: (m) => `${m[1]} with only doc_header's version missing gives the error page (finding 3, P3-CLOSED)`,
  },
];

// P3-FIX5: the flipped checks each part must produce. A check label, or a
// marker: "retired: <known>" (a retired known check was met) and
// "reworded: <old label>" (a reworded check was met and its screenshot taken).
// If one is missing after a part that ran to the end, the part fails.
export const EXPECTED_FLIPS = {
  preview: [
    "after signing out of the console, the same browser no longer sees the draft overlay", // finding 1, FLIPPED
    NOTE_CHECKS[0].label(),
    "reworded: before the first publish: the preview bar shows",
    REWORDED["before the first publish: the preview bar shows"].newLabel,
  ],
  unfinished: [
    "retired: finding 2",
    "the editor previews a documents store (the Designer's address leads to it), and a click on the unfinished note selects that section there (replaces finding 2)",
  ],
  "error-chrome": [NOTE_CHECKS[1].label(["", "/policies/shipping"]), NOTE_CHECKS[1].label(["", "/"])],
};

// The expected flips missing from one part's results. Pure, so it is tested
// on its own (P3-FIX5): labels are the part's check labels, ran the markers.
export function missingFlips(part, { labels = [], ran = new Set(), pendingReworded = null } = {}) {
  const have = new Set([...labels, ...ran]);
  const missing = (EXPECTED_FLIPS[part] || []).filter((x) => !have.has(x));
  // a reworded check met, whose screenshot never came: its new check never ran
  if (pendingReworded) missing.push(`reworded: ${pendingReworded.label} (shot ${pendingReworded.shot})`);
  return missing;
}

// Steps that run after a part, while its harness and state are still there.
export const AFTER = {
  // finding 2's replacement: the unfinished banner's note, clicked in the new
  // editor's preview (the Designer's address leads there), selects that section
  async unfinished(drill) {
    const ctx = await drill.context({ width: 1440 });
    try {
      const page = await drill.signIn(ctx);
      await page.goto("/admin/storefront/designer", { waitUntil: "load", timeout: 120_000 });
      await settle(page);
      const at = new URL(page.url());
      await page.waitForSelector("[data-inspector], [data-writing-view]", { timeout: 90_000 });
      const label = () => page.locator("[data-preview-pane]").first().getAttribute("data-preview-label").catch(() => null);
      const end = Date.now() + 90_000;
      while (Date.now() < end && (await label()) !== "Up to date") await sleep(200);
      const fr = page.frameLocator("[data-preview-frame]");
      await fr.locator('[data-section-id="sec_drillbnr"]').first().click({ timeout: 15_000 });
      let selected = 0;
      for (let i = 0; i < 40 && !selected; i++) {
        selected = await page.locator('[data-section-row="sec_drillbnr"][data-selected]').count();
        if (!selected) await sleep(200);
      }
      drill.check(
        at.pathname + at.search === "/admin/editor?doc=doc_home" && (await label()) === "Up to date" && selected === 1,
        "the editor previews a documents store (the Designer's address leads to it), and a click on the unfinished note selects that section there (replaces finding 2)",
        { at: at.pathname + at.search, label: await label(), selected },
      );
      await drill.shoot(page, "unfinished-editor-1440");
    } finally {
      await ctx.close();
    }
  },
};

// ---------- parts that live here ----------

export const parts = {
  // pnpm drill:smoke and drill:edge, unchanged, on the legacy seed. They write
  // their own results.json and screenshots under docs/cms-reviews/drills/
  // (smoke/ and P1-HARNESS/); this part records their counts.
  async legacy(drill) {
    await reseed(drill, [], { kind: "legacy" });
    const seeded = readSeeded(join(ROOT, DATA_DIR_NAME));
    drill.check(!seeded?.fixture, "the harness holds the plain legacy seed", seeded?.fixture ?? null);
    const [mode] = await tenantSql(["SELECT mode FROM cms_state WHERE id = 1"]);
    drill.check(mode.rows[0]?.mode === "legacy", "the harness store is in legacy mode", mode.rows[0]?.mode);
    for (const [journey, dir] of [
      ["smoke", "smoke"],
      ["harness-edge", "P1-HARNESS"],
    ]) {
      const r = await runNode([join(ROOT, "scripts", "drill.js"), journey]);
      let res = null;
      try {
        res = JSON.parse(readFileSync(join(ROOT, "docs", "cms-reviews", "drills", dir, "results.json"), "utf8"));
      } catch {}
      const tail = r.out.trim().split("\n").slice(-1)[0];
      // a copy of their results next to this drill's (the journeys rewrite their own
      // folders on every run; drop those changes with git checkout if they aren't wanted)
      if (res) writeFileSync(join(drill.dir, `legacy-${journey}-results.json`), `${JSON.stringify(res, null, 2)}\n`);
      drill.check(r.code === 0 && res && res.failed === 0, `drill ${journey === "smoke" ? "drill:smoke" : "drill:edge"} passes unchanged`, { exit: r.code, passed: res?.passed, failed: res?.failed, knownFailures: res?.knownFailures, last: tail });
      if (res?.knownFailures) drill.note(`${journey}: ${res.knownFailures} known failures: ${res.checks.filter((c) => !c.ok && c.known).map((c) => `${c.label} [${c.known}]`).join("; ")}`);
      if (res) drill.note(`${journey}: failed checks: ${JSON.stringify(res.checks.filter((c) => !c.ok && !c.known).map((c) => c.label))}`);
    }
  },

  // The perf fixture's CLI and this item's seed run from a checkout whose path
  // has a space (the owner's is ".../Projects 2026/storeasy26"). A copy of
  // each script is run from such a folder, with everything it imports linked
  // back to this checkout.
  async space(drill) {
    const { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, readdirSync, realpathSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const base = realpathSync(mkdtempSync(join(process.env.DRILL_TMP || tmpdir(), "p2-space-")));
    const root = join(base, "Projects 2026", "storeasy26");
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      for (const name of readdirSync(ROOT)) if (!["scripts", ".git", ".design-data", ".next"].includes(name)) symlinkSync(join(ROOT, name), join(root, name));
      for (const name of readdirSync(join(ROOT, "scripts"))) {
        if (name === "perf-docs-fixture.js" || name === "seed-design-documents.js") copyFileSync(join(ROOT, "scripts", name), join(root, "scripts", name));
        else symlinkSync(join(ROOT, "scripts", name), join(root, "scripts", name));
      }
      const hashHere = await runNode([join(ROOT, "scripts", "perf-docs-fixture.js"), "hash", "--posts", "0"]);
      const hashThere = await runNode([join(root, "scripts", "perf-docs-fixture.js"), "hash", "--posts", "0"], { cwd: root });
      const h = (o) => /"hash":"([0-9a-f]{64})"/.exec(o)?.[1] || null;
      drill.check(hashThere.code === 0 && h(hashThere.out) && h(hashThere.out) === h(hashHere.out), "perf-docs-fixture.js hash runs from a path with a space and prints the same hash", { path: join(root, "scripts"), exit: hashThere.code, hash: h(hashThere.out), here: h(hashHere.out) });
      const bad = await runNode([join(root, "scripts", "perf-docs-fixture.js"), "nonsense"], { cwd: root });
      drill.check(bad.code === 2, "perf-docs-fixture.js answers an unknown command with exit 2 there (the CLI ran, it didn't skip)", { exit: bad.code });
      const seedBad = await runNode([join(root, "scripts", "seed-design-documents.js"), "--nonsense"], { cwd: root });
      drill.check(seedBad.code === 1 && /Unknown option/.test(seedBad.out), "seed-design-documents.js runs its CLI from a path with a space (an unknown option is refused, exit 1)", { exit: seedBad.code, out: seedBad.out.trim().slice(0, 200) });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
};

async function main() {
  const args = process.argv.slice(2);
  const headed = args.includes("--headed");
  const [only] = args.filter((a) => !a.startsWith("--"));
  const names = only ? only.split(",") : Object.keys(PART_FILES);
  for (const n of names) if (!PART_FILES[n]) throw new DrillError(`There is no part "${n}". Parts: ${Object.keys(PART_FILES).join(", ")}.`);
  const ours = runningHarness(join(ROOT, DATA_DIR_NAME));
  if (ours) throw new DrillError(`A design harness is already running in this checkout (pid ${ours.launcher.pid}). The P2 drills seed the store fresh and start their own harness: stop it first.`);
  const ports = harnessPorts();
  if (ports.next === 3017) console.log("! DESIGN_PORT is 3017, the owner's harness port. Agents use their own ports.");
  const harness = { baseUrl: `http://localhost:${ports.next}`, port: ports.next, creds: {} };
  const browser = await launchChrome({ headed });
  let failed = 0;
  try {
    for (const part of names) {
      const mod = PART_FILES[part] === "run.mjs" ? { parts } : await import(pathToFileURL(join(here, PART_FILES[part])).href);
      const drill = new PartDrill({ id: "P2-DRILLS", title: `P2-DRILLS — ${part}`, harness: { ...harness }, browser });
      owned.drills.add(drill);
      console.log(`\n== P2-DRILLS ${part}`);
      let error = null;
      try {
        await mod.parts[part](drill);
        if (AFTER[part]) await AFTER[part](drill);
      } catch (e) {
        error = e;
        console.error(`✗ ${part} stopped: ${e.stack || e}`);
      }
      const r = drill.finishPart(part, { error });
      owned.drills.delete(drill);
      console.log(`-- ${part}: ${r.passed} passed, ${r.failed} failed${r.knownFailures ? `, ${r.knownFailures} known` : ""}`);
      failed += r.failed;
    }
  } finally {
    await browser.close().catch(() => {});
    await stopOwned();
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`✗ ${e.message || e}`);
      process.exit(1);
    },
  );
}
