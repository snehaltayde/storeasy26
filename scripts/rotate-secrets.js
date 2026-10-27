// Platform-secret rotation step 2 of 3 (S28 / BE13).
//   1. set PLATFORM_SECRET_NEXT=<new secret> in the environment + deploy
//   2. pnpm rotate:secrets        ← re-encrypts every stored blob (this script)
//   3. move NEXT into PLATFORM_SECRET, unset PLATFORM_SECRET_NEXT, deploy
// Safe to re-run; never prints secret material (fingerprints only).
import { rotateStoredSecrets } from "../lib/platform/rotate.js";
import { keyIds } from "../lib/platform/crypto.js";

const ids = await keyIds();
if (ids.length === 1) {
  console.log(`• no PLATFORM_SECRET_NEXT set — re-encrypting under the CURRENT key (${ids[0]})`);
  console.log("  (useful for upgrading legacy blobs to the k1 envelope; a real rotation sets NEXT first)");
} else {
  console.log(`• rotation open: writing under key ${ids[0]}, still reading key(s) ${ids.slice(1).join(", ")}`);
}

const s = await rotateStoredSecrets({ log: (m) => console.log("  " + m) });
console.log(`✓ rotated: ${s.tenants} tenant row(s), ${s.users} user row(s); ${s.skipped} already current`);
if (s.failures.length) {
  console.error(`✗ ${s.failures.length} failure(s):`);
  for (const f of s.failures) console.error(`  - ${f.kind} ${f.id}: ${f.error}`);
  process.exit(1);
}
if (ids.length > 1) {
  console.log("→ finish: set PLATFORM_SECRET to the new value, unset PLATFORM_SECRET_NEXT, redeploy.");
}
process.exit(0);
