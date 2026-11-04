// What the home page and content pages render on a legacy store (P2-SECTIONS).
//
//   node scripts/support/home-render-outputs.js            prints the JSON
//   node scripts/support/home-render-outputs.js <out.json> writes it
//
// Builds throwaway legacy tenants (file databases in the checkout's root) and
// renders, to HTML, with Next's SWC and react-dom/server:
//   · app/(storefront)/page.js, the real home page, and
//   · components/ContentPage.js for a set of pages,
// in each of these states (every product in stock, every rail above its
// minimum):
//   drafts          no release: the legacy drafts
//   exp_b, exp_control, exp_founder, exp_preview
//                   a running hero experiment: a visitor in variant b, one
//                   in control, a browser signed in to the console, and the
//                   founder's preview (the PV-08 note)
//   candidate       an S59 preview with unsaved hero and sections
//   v1, v2, v3      a version 1, 2 and 3 release live
//   empty           a store with no products yet (GEN-03)
// It imports the app through relative paths, so running this same file inside
// an older checkout records that checkout's output.
// scripts/fixtures/home-render-outputs.a6d028e.json was recorded this way from
// a6d028e, and test:sections-render compares today's output with it (after
// taking out the data-section-id and data-section-kind attributes P2-SECTIONS
// adds). Nothing here reaches the network.
//
// P4-FIXTURES: the tenants and their content now live in
// scripts/support/legacy-tenants.js (content sets "home" and "empty"); the
// output is the same as before.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  CONTENT_SETS,
  HOME_HERO,
  HOME_PAGES,
  HOME_SECTIONS,
  ROOT,
  asRequest,
  installHooks,
  makeLegacyTenant,
  openWorld,
  putLiveRelease,
  renderKit,
  startHeroExperiment,
} from "./legacy-tenants.js";

installHooks({ headers: "stub" });
const world = await openWorld({ prefix: process.env.HOME_RENDER_DB_PREFIX || ".test-home-render" });
const { db: T } = await makeLegacyTenant(world, { set: "home", state: "no_release_open" });
const { db: TE } = await makeLegacyTenant(world, { set: "empty", state: "no_release_open" });

const { libsql } = await import("../../lib/db.js");
const R = await import("../../lib/releases.js");
const X = await import("../../lib/experiments.js");
const Res = await import("../../lib/content/resolve.js");
const { setPreviewCandidate } = await import("../../lib/cms/candidates.js");
const inT = (fn) => T.run(fn);

// ---- rendering --------------------------------------------------------------------
const { require, React, renderToStaticMarkup, jsxTreeLoader } = await renderKit();
const { imageConfigDefault } = require("next/dist/shared/lib/image-config.js");
const { ImageConfigContext } = require("next/dist/shared/lib/image-config-context.shared-runtime.js");
const imageConfig = { ...imageConfigDefault, ...((await import(pathToFileURL(join(ROOT, "next.config.mjs")).href)).default.images || {}) };
const loadJsx = jsxTreeLoader({ "@/components/site/MarketingHome": { __esModule: true, default: () => null } });
const Home = (await loadJsx(join(ROOT, "app/(storefront)/page.js"))).default;
const ContentPage = (await loadJsx(join(ROOT, "components/ContentPage.js"))).default;

const html = (el) => renderToStaticMarkup(React.createElement(ImageConfigContext.Provider, { value: imageConfig }, el));
const UNIT = "unit-home-render-plain";
async function record(cookies = { _unit: UNIT }, host = "hr.test") {
  const home = await asRequest(host, cookies, async () => html(await Home()));
  const pages = {};
  if (host === "hr.test") {
    for (const { slug } of HOME_PAGES) {
      pages[slug] = await asRequest(host, cookies, async () => {
        const page = await inT(() => Res.resolvedContentPage(slug));
        return html(React.createElement(ContentPage, { page, legalName: "Glow Works Pvt Ltd" }));
      });
    }
  }
  return { home, pages };
}

const out = { recordedFrom: "scripts/support/home-render-outputs.js", states: {} };
out.states.drafts = await record();

// a running hero experiment
await startHeroExperiment(T);
const EXP = await inT(() => X.runningExperimentFor("hero"));
const unitIn = (key) => {
  for (let i = 0; ; i++) if (X.assignVariant(EXP, `unit-home-render-${i}`) === key) return `unit-home-render-${i}`;
};
out.states.exp_b = await record({ _unit: unitIn("b") });
out.states.exp_control = await record({ _unit: unitIn("control") });
out.states.exp_founder = await record({ _unit: unitIn("b"), _admin: "signed-in" });
const token = await inT(() => R.previewToken());
out.states.exp_preview = await record({ _unit: unitIn("b"), [Res.PREVIEW_COOKIE]: token });
await inT(() => libsql.execute("UPDATE experiments SET status = 'completed'"));

// an S59 preview: unsaved hero words and sections
await inT(() =>
  setPreviewCandidate(token, {
    hero: { ...HOME_HERO, title: "Candidate glow", subtitle: "Typed, not saved." },
    home_sections: [HOME_SECTIONS[5], { ...HOME_SECTIONS[2], title: "Candidate banner" }, HOME_SECTIONS[1]],
  }),
);
out.states.candidate = await record({ _unit: UNIT, [Res.PREVIEW_COOKIE]: token });

for (const [name, content] of Object.entries(CONTENT_SETS.home.releases)) {
  await putLiveRelease(T, CONTENT_SETS.home.releaseId(name.slice(1)), content);
  out.states[name] = await record();
}

void TE;
out.states.empty = await record({ _unit: UNIT }, "hre.test");

await world.cleanup();
const json = JSON.stringify(out, null, 2) + "\n";
if (process.argv[2]) await writeFile(process.argv[2], json);
else process.stdout.write(json);
process.exit(0);
