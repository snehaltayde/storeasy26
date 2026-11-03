// P1-DRILLS-C runner (batch C drills): the P1-DRILLS runner, loading journeys from scripts/drills/p1c/.
//   DESIGN_PORT=3231 node scripts/drills/p1c/run.mjs <journey> [part] [--headed]
// A journey is scripts/drills/p1c/<journey>.mjs exporting `id`, `title` and
// `parts` ({ name: async (drill, ctx) => {} }). Each part writes
// docs/cms-reviews/drills/<id>/results-<part>.json, and never removes a
// screenshot another part made (unlike Drill.finish, which assumes one run per
// folder). Only attaches to this checkout's own harness (connectHarness).
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Drill, DrillError, connectHarness, launchChrome } from "../../drill.js";

const here = dirname(fileURLToPath(import.meta.url));

// The console's sign-in allows 5 tries a minute per address, and these drills
// open many signed-in contexts. Sign in through the real form once per run,
// then give later contexts the same session cookies.
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
    adminCookies = await context.cookies();
    return page;
  }

  finishPart(part, { error } = {}) {
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
    writeFileSync(join(this.dir, `results-${part}.json`), `${JSON.stringify(results, null, 2)}\n`);
    return results;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const headed = args.includes("--headed");
  const [journey, only] = args.filter((a) => !a.startsWith("--"));
  const mod = await import(pathToFileURL(join(here, `${journey}.mjs`)).href);
  const harness = await connectHarness({ start: false });
  const browser = await launchChrome({ headed });
  let failed = 0;
  try {
    const names = only ? only.split(",") : Object.keys(mod.parts);
    for (const part of names) {
      const fn = mod.parts[part];
      if (!fn) throw new DrillError(`no part ${part} in ${journey}`);
      const drill = new PartDrill({ id: mod.id, title: `${mod.title} — ${part}`, harness, browser });
      console.log(`\n== ${mod.id} ${part}`);
      let error = null;
      try {
        await fn(drill);
      } catch (e) {
        error = e;
        console.error(`✗ ${part} stopped: ${e.stack || e}`);
      }
      const r = drill.finishPart(part, { error });
      console.log(`-- ${part}: ${r.passed} passed, ${r.failed} failed${r.knownFailures ? `, ${r.knownFailures} known` : ""}`);
      failed += r.failed;
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return failed ? 1 : 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
