// What the storefront reads from a version 1, 2 and 3 release (P2-VGATE).
//
//   node scripts/support/legacy-release-outputs.js            prints the JSON
//   node scripts/support/legacy-release-outputs.js <out.json> writes it
//
// Builds one throwaway tenant (file databases in the checkout's root), puts
// three hand-made releases live in turn (v1, v2 and v3), and records what
// getLiveReleaseState(), contentSource() and every resolved* getter return for
// each. It imports the app through relative paths, so running this same file
// inside an older checkout records that checkout's answers. (P4-HARNESS) It now needs
// scripts/support/legacy-tenants.js and scripts/support/tenant-fixture.js too:
// copy all three files into the older checkout before running it there.
// scripts/fixtures/legacy-release-outputs.a6d028e.json was recorded this way
// from a6d028e, and test:releases compares today's answers with it.
//
// P4-FIXTURES: the tenant, its content and the recording now live in
// scripts/support/legacy-tenants.js (content set "vgate", state live_v1, no
// drafts, then the v2 and v3 envelopes put live in turn). The output is
// byte-identical to what this file wrote before.
//
// Plain JSON only: Maps, Dates and undefined are written the way JSON.stringify
// writes them. Nothing here reaches the network.
import { writeFile } from "node:fs/promises";
import { CONTENT_SETS, LEGACY_RELEASE_ROUTES, installHooks, makeLegacyTenant, openWorld, putLiveRelease, recordOutputs } from "./legacy-tenants.js";

installHooks({ headers: "real" });
const world = await openWorld({ prefix: ".test-vgate-legacy" });
const { db } = await makeLegacyTenant(world, { set: "vgate", file: "t", state: "live_v1", drafts: false });

const out = { recordedFrom: "scripts/support/legacy-release-outputs.js", fixtures: {} };
for (const name of ["v1", "v2", "v3"]) {
  if (name !== "v1") await putLiveRelease(db, CONTENT_SETS.vgate.releaseId(name.slice(1)), CONTENT_SETS.vgate.releases[name]);
  out.fixtures[name] = await recordOutputs(db, { routes: LEGACY_RELEASE_ROUTES });
}

await world.cleanup();
const json = JSON.stringify(out, null, 2) + "\n";
if (process.argv[2]) await writeFile(process.argv[2], json);
else process.stdout.write(json);
process.exit(0);
