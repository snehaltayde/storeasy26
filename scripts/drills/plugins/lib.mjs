// drill:plugins shared parts (Phase 9 step 0): the roles store's origin,
// members, sign-in, stages and SQL come from drill:mobile-cart (and through it
// drill:themes and drill:apps); this file adds the shopper's context. Lines
// 1–5 append to it (append-only file).
import { CONSENT_COOKIE, serializeConsent } from "../../../lib/track/names.js";
import { ORIGIN } from "../mobile-cart/lib.mjs";

export { ORIGIN, STAGES, api, consoleErrors, member, open, openStore, port, rolesSql, signIn, stage, state } from "../mobile-cart/lib.mjs";

// The roles store's fixture pictures don't exist; Next's image route would 404.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const stubImages = (ctx) => ctx.route("**/_next/image**", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));

export const shopperErrors = [];
// A desktop shopper with the cookie banner already answered (declined), so it covers nothing.
export async function shopper(drill) {
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  ctx.setDefaultTimeout(30_000);
  await stubImages(ctx);
  await ctx.addCookies([{ name: CONSENT_COOKIE, value: encodeURIComponent(serializeConsent({ analytics: false, marketing: false })), url: ORIGIN }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => shopperErrors.push(String(e?.message || e).slice(0, 300)));
  page.on("console", (m) => {
    // React's dev-mode eval note, which drill:apps also expects
    if (m.type() === "error" && !/eval\(\) is not supported/.test(m.text())) shopperErrors.push(m.text().slice(0, 300));
  });
  return page;
}
