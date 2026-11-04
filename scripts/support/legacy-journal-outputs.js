// What the sitemap and the /journal listing show on a legacy store (P2-READ).
//
//   node scripts/support/legacy-journal-outputs.js            prints the JSON
//   node scripts/support/legacy-journal-outputs.js <out.json> writes it
//
// Builds one throwaway legacy tenant (file databases in the checkout's root)
// with pages, campaigns and journal posts (shown, scheduled, ended, switched
// off), and records, before any publish (drafts) and with a v3 release live:
//   · app/sitemap.js's output,
//   · app/(storefront)/journal/page.js rendered to HTML (Next's SWC).
// It imports the app through relative paths, so running this same file inside
// an older checkout records that checkout's answers. (P4-HARNESS) It now needs
// scripts/support/legacy-tenants.js and scripts/support/tenant-fixture.js too:
// copy all three files into the older checkout before running it there.
// scripts/fixtures/legacy-journal-outputs.a6d028e.json was recorded this way
// from a6d028e, and test:release-readers compares today's answers with it.
//
// P4-FIXTURES: the tenant and its content now live in
// scripts/support/legacy-tenants.js (content set "journal"); the output is
// byte-identical to what this file wrote before.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { CONTENT_SETS, ROOT, asRequest, installHooks, makeLegacyTenant, openWorld, putLiveRelease, renderKit } from "./legacy-tenants.js";

installHooks({ headers: "stub" });
const world = await openWorld({ prefix: ".test-journal-legacy" });
const { db } = await makeLegacyTenant(world, { set: "journal", file: "t", state: "no_release_open" });

// ---- the journal listing, rendered with Next's SWC (as test-releases does) -------
const { renderToStaticMarkup, loadPage } = await renderKit();
const Journal = (await loadPage(join(ROOT, "app/(storefront)/journal/page.js"))).default;
const sitemap = (await import(pathToFileURL(join(ROOT, "app/sitemap.js")).href)).default;

async function record() {
  const map = await asRequest("jl.test", {}, () => sitemap());
  const html = await asRequest("jl.test", {}, async () => renderToStaticMarkup(await Journal()));
  return JSON.parse(JSON.stringify({ sitemap: map, journal: html }));
}

const out = { recordedFrom: "scripts/support/legacy-journal-outputs.js", states: {} };
out.states.drafts = await record();
await putLiveRelease(db, CONTENT_SETS.journal.releaseId(3), CONTENT_SETS.journal.releases.v3);
out.states.v3 = await record();

await world.cleanup();
const json = JSON.stringify(out, null, 2) + "\n";
if (process.argv[2]) await writeFile(process.argv[2], json);
else process.stdout.write(json);
process.exit(0);
