// drill:search shared parts (Phase 7 line 2): the roles store's origin and
// members, signing in, console-error watching and the stage list are
// drill:apps' own (scripts/drills/apps/lib.mjs), as drill:themes and
// drill:studio use them. Search-only helpers live below.
import { harnessPorts } from "../../design-harness.js";
import { ROLES_PROFILE } from "../../seed-roles-store.js";
import { CONSENT_COOKIE, serializeConsent } from "../../../lib/track/names.js";
import { ORIGIN, consoleErrors } from "../apps/lib.mjs";

export * from "../apps/lib.mjs";

// The fixture pictures don't exist: Next's image route would 404 into the
// console check, so a 1x1 gif stands in (as drill:themes and drill:studio do).
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
export const stubImages = (ctx) => ctx.route("**/_next/image**", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));
// the shopper has answered the cookie banner (declined)
export const consent = (ctx) => ctx.addCookies([{ name: CONSENT_COOKIE, value: encodeURIComponent(serializeConsent({ analytics: false, marketing: false })), url: ORIGIN }]);

// statements straight against the roles store's own database (this worktree's sqld)
export async function rolesSql(statements) {
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: `http://127.0.0.1:${harnessPorts(process.env, ROLES_PROFILE).sqld.tenant}` });
  try {
    return await c.batch(statements, "write");
  } finally {
    c.close();
  }
}

export const docsApi = (page, body) =>
  page.evaluate(async (b) => {
    const r = await fetch("/api/admin/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, body);

// an anonymous shopper: a fresh context, no session, consent answered,
// pictures stubbed; its console errors join the drill's
export async function shopper(drill, viewport) {
  const ctx = await drill.browser.newContext({ viewport, deviceScaleFactor: 1, ...(viewport.width < 768 ? { isMobile: true, hasTouch: true } : {}) });
  ctx.setDefaultTimeout(30_000);
  await stubImages(ctx);
  await consent(ctx);
  const page = await ctx.newPage();
  page.on("console", (m) => (m.type() === "error" ? consoleErrors.push(`shopper: ${m.text().slice(0, 300)}`) : null));
  page.on("pageerror", (e) => consoleErrors.push(`shopper: ${String(e?.message || e).slice(0, 300)}`));
  return page;
}
