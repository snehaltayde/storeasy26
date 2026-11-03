// TOK-02 for the console: the pairing matrix for a brand on this store's
// (draft) theme kit, against what the live store shows now. Used by the
// Brand API (save and preview answers) and the Brand page (on load), so the
// founder sees the same warnings whether they just saved or came back later.
import { checkBrand } from "../brand.js";
import { getLiveReleaseState, DOCUMENTS_RELEASE_VERSION } from "../releases.js";
import { kitAttr } from "../themes/kits.js";
import { currentTenant } from "../tenant-context.js";
import { DOCUMENTS_MESSAGE } from "../cms-mode.js";

// P2-GUARD: when the live release is a documents list (v4) there is no legacy
// brand in it to compare against, and this store doesn't publish this way: the
// answer is the documents marker, no warnings and nothing blocking.
export async function brandReadability(brand) {
  let live = null;
  try {
    const s = await getLiveReleaseState();
    if (s.state === "live" && s.release.v === DOCUMENTS_RELEASE_VERSION) {
      return { warnings: [], notes: [], pairs: [], blocking: false, documents: true, message: DOCUMENTS_MESSAGE };
    }
    live = s.state === "live" ? s.release.content : null;
  } catch {
    live = null; // compare against the platform default: strict
  }
  const r = checkBrand(brand, { kit: kitAttr(currentTenant()?.config?.theme || null), live: live?.brand || null, liveKit: kitAttr(live?.theme || null) });
  // blocking: at least one warning would stop a publish (the save toast says so)
  return { warnings: r.issues.map((i) => i.message), notes: r.notes, pairs: r.failing, blocking: r.errors.length > 0 };
}
