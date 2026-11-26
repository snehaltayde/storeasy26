// drill:plugins stage "baseline" (Phase 9 step 0): the store as it is before
// lines 1–5 add their plugins. The owner and support see the Apps catalog with
// Trust badges in it; a shopper's PIN code answer keeps its keys in today's
// order with the store's own estimate (the estimate source changes nothing);
// the account page (signed out) and the checkout open.
import { ORIGIN, open, openStore, shopper, signIn, stage } from "./lib.mjs";

stage("baseline", async (drill) => {
  await openStore(drill);

  for (const role of ["owner", "support"]) {
    const page = await signIn(drill, role);
    drill.check((await open(page, "/admin/apps")) === 200, `${role}: /admin/apps opens (200)`);
    await page.locator('[data-apps-tab="browse"]').click();
    await page.locator('[data-app-card="trust-badges"]').first().waitFor();
    drill.check((await page.locator('[data-app-card="trust-badges"]').count()) > 0, `${role}: Trust badges is in the catalog`);
    if (role === "owner") await drill.shoot(page, "apps");
    await page.context().close();
  }

  const page = await shopper(drill);
  const pin = await page.request.get(`${ORIGIN}/api/pincode?pin=411001`);
  const body = await pin.json().catch(() => null);
  drill.check(pin.status() === 200, "GET /api/pincode answers 200", pin.status());
  drill.check(JSON.stringify(Object.keys(body || {})) === JSON.stringify(["found", "city", "state", "estimate", "cod", "freeThreshold", "timeZone"]), "the PIN code answer keeps its keys in order", body && Object.keys(body));
  const est = body?.estimate;
  drill.check(est === null || (Number.isInteger(est.minDays) && Number.isInteger(est.maxDays) && JSON.stringify(Object.keys(est)) === '["minDays","maxDays"]'), "the estimate is the store's own (null or { minDays, maxDays })", est);
  const bad = await page.request.get(`${ORIGIN}/api/pincode?pin=12`);
  drill.check(bad.status() === 400, "a short PIN code is refused (400)", bad.status());

  const account = await page.goto(`${ORIGIN}/account`, { waitUntil: "load" });
  drill.check(account?.status() === 200, "the account page answers 200 (signed out: the sign-in form)", account?.status());
  const checkout = await page.goto(`${ORIGIN}/checkout`, { waitUntil: "load" });
  drill.check(checkout?.status() === 200, "the checkout page answers 200", checkout?.status());
  await drill.shoot(page, "checkout");
  await page.context().close();
});
