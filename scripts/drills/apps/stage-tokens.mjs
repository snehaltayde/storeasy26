// drill:apps stage "tokens" (Phase 4 line 4): on the custom app the webhooks
// stage made (state.customId), the owner creates an API token in the dialog
// and copies it (shown once); a cookie-less server-style request to
// /api/apps/v1/orders with it answers 200 with no customer field; the owner
// revokes it (AlertDialog); the next call answers 401; the Recent calls list
// shows both calls. Support sees the card with no live write control and no
// call list. Selectors: ids, data-* hooks and exact names; rows are waited for.
import { ORIGIN, api, open, signIn, stage, state } from "./lib.mjs";

stage("tokens", async (drill) => {
  if (!state.customId) throw new Error("stage tokens needs the webhooks stage's custom app (state.customId)");
  const path = `/admin/apps/${state.customId}`;
  const page = await signIn(drill, "owner");
  drill.check((await open(page, path)) === 200, "owner: the custom app's page opens (200)");
  const card = page.locator('[data-apps="api-access"]');
  await card.locator('[data-apps="token-new"]').waitFor();
  drill.check((await card.locator('[data-api-scope="orders.read"]').count()) === 1, "the API access card lists the approved orders permission");

  await card.locator('[data-apps="token-new"]').click();
  const dialog = page.locator('[data-apps="token-dialog"]');
  await dialog.waitFor();
  await dialog.locator("#token-name").fill("Drill token");
  drill.check((await dialog.locator('[data-scope="orders.read"]').getAttribute("data-state")) === "checked", "dialog: the app's permission is checked");
  await drill.shoot(page, "owner-token-dialog");
  await dialog.locator('[data-apps="token-create"]').click();
  await dialog.locator('[data-apps="token-once"]').waitFor({ timeout: 15_000 });
  const token = (await dialog.locator("#api-token").innerText()).trim();
  drill.check(/^sea_tok_[0-9a-f]{16}\.[0-9a-f]{64}$/.test(token), "the token is shown once, sea_tok_….<64 hex>");
  await drill.shoot(page, "owner-token-once");
  await dialog.locator('[data-apps="token-done"]').click();
  const tokId = token.slice(4, 24);
  const row = card.locator(`[data-token-revoke="${tokId}"]`);
  await row.waitFor();
  drill.check((await card.locator('[data-token-status="active"]').count()) >= 1, "the token is listed Active");
  drill.check(!(await page.content()).includes(token.split(".")[1]), "the page no longer holds the token after the dialog closes");

  // a server-to-server call: a fresh context, no cookies, Bearer only
  const server = await drill.browser.newContext();
  const v1 = async (p) => {
    const r = await server.request.get(`${ORIGIN}/api/apps/v1/${p}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status(), text: await r.text(), headers: r.headers() };
  };
  const orders = await v1("orders");
  drill.check(orders.status === 200, "v1 orders answers 200 with the token", orders.status);
  drill.check(!/drillbuyer|9876500000|Drill Buyer|Drill Road|"email"|"phone"|"address_line1"/.test(orders.text), "v1 orders has no customer field", orders.text.slice(0, 200));
  drill.check(!Object.keys(orders.headers).some((h) => h.startsWith("access-control")), "v1 sends no CORS headers");
  drill.check((await v1("products")).status === 403, "v1 products answers 403 (no storefront permission)");
  const anon = await server.request.get(`${ORIGIN}/api/apps/v1/orders`);
  drill.check(anon.status() === 401, "v1 without a token answers 401", anon.status());

  await row.click();
  const confirm = page.locator('[data-apps="revoke-confirm"]');
  await confirm.waitFor();
  await confirm.locator('[data-apps="revoke-go"]').click();
  await card.locator('[data-token-status="revoked"]').first().waitFor();
  drill.check(true, "the token is listed Revoked");
  const after = await v1("orders");
  drill.check(after.status === 401, "after Revoke the next call answers 401", after.status);
  await server.close();

  await open(page, path);
  const calls = page.locator('[data-apps="call-log"] tbody tr');
  await calls.first().waitFor();
  const statuses = await page.locator('[data-apps="call-log"] [data-call-status]').evaluateAll((els) => els.map((e) => e.getAttribute("data-call-status")));
  drill.check(statuses.includes("200") && statuses.includes("401") && statuses.includes("403"), "Recent calls shows the allowed, refused and revoked calls", statuses);
  await drill.shoot(page, "owner-api-access");
  await page.context().close();

  const support = await signIn(drill, "support");
  await open(support, path);
  await support.locator('[data-apps="api-access"] [data-token-status]').first().waitFor();
  const live = await support.evaluate(() => [...document.querySelectorAll("[data-apps=token-new], [data-apps=scopes-edit], [data-token-revoke]")].filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true").map((el) => el.outerHTML.slice(0, 100)));
  drill.check(live.length === 0, "support: no live token write control", live);
  drill.check((await support.locator('[data-apps="call-log"]').count()) === 0, "support: no call list");
  const refused = await api(support, `apps/${state.customId}/tokens`, { create: { name: "x", scopes: ["orders.read"] } });
  drill.check(refused.status === 403, "support: the API refuses create (403)", refused.status);
  await drill.shoot(support, "support-api-access");
  await support.context().close();
});
