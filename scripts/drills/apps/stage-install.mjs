// drill:apps stage "install" (Phase 4 line 1): the owner installs Trust
// badges from Browse (the dialog says it can see nothing), edits a badge,
// turns it off and on again; staff and support see the list and the app's
// page with no write control (and the API refuses them); the owner
// uninstalls it, and it can be installed again from Browse.
import { api, open, signIn, stage, state } from "./lib.mjs";

const PLUGIN = "trust-badges";
const writeControls = (page) =>
  page.evaluate(() => {
    const live = (el) => !el.disabled && !(el.getAttribute("aria-disabled") === "true" && el.getAttribute("data-role-gate") === "disabled");
    const sel = '[data-app-install], [data-apps-action], [data-apps="save-settings"], [data-secret-edit], [data-secret-clear], [data-list-add]';
    const fields = '[data-apps="settings"] input, [data-apps="settings"] button[role="combobox"], [data-apps="settings"] button[role="switch"]';
    return [...document.querySelectorAll(`${sel}, ${fields}`)].filter(live).map((el) => el.outerHTML.slice(0, 120));
  });

async function confirm(page, action, status) {
  await page.locator(`[data-apps-action="${action}"]`).click();
  const dialog = page.locator('[data-apps="confirm"]');
  await dialog.waitFor();
  await dialog.locator('[data-apps="confirm-go"]').click();
  if (status) await page.locator(`[data-apps="overview"] [data-app-status="${status}"]`).waitFor({ timeout: 15_000 });
}

async function ownerInstalls(drill) {
  const page = await signIn(drill, "owner");
  drill.check((await open(page, "/admin/apps")) === 200, "owner: /admin/apps opens (200)");
  const card = page.locator(`[data-app-card="${PLUGIN}"]`);
  await card.waitFor();
  drill.check((await page.locator('[data-apps-tab="browse"][data-state="active"]').count()) === 1, "owner: with nothing installed the page opens on Browse");
  await drill.shoot(page, "owner-browse");
  await card.locator(`[data-app-install="${PLUGIN}"]`).click();
  const dialog = page.locator('[data-apps="install-dialog"]');
  await dialog.waitFor();
  const none = await dialog.locator('[data-apps="install-no-scopes"]').innerText();
  drill.check(none === "It can't see your orders or customers.", "install dialog: Trust badges can see nothing, in plain words", none);
  await drill.shoot(page, "owner-install-dialog");
  await dialog.getByRole("button", { name: "Approve and install" }).click();
  await page.waitForURL(/\/admin\/apps\/pin_[0-9a-f]{16}$/, { timeout: 30_000 });
  await page.locator('[data-apps="detail"]').waitFor();
  state.installId = new URL(page.url()).pathname.split("/").pop();
  drill.check((await page.locator('[data-apps="overview"] [data-app-status="enabled"]').count()) === 1, "owner: the app's page says On", { id: state.installId });

  const label = page.locator("#app-setting-badges-0-label");
  await label.fill("Free delivery");
  await page.locator('[data-apps="save-settings"]').click();
  await page.locator('[data-apps="save-bar"]').waitFor({ state: "detached", timeout: 15_000 });
  const saved = await api(page, `apps/${state.installId}`);
  drill.check(saved.status === 200 && saved.json?.install?.settings?.badges?.[0]?.label === "Free delivery", "owner: the badge label is saved", saved.json?.install?.settings);
  await drill.shoot(page, "owner-settings-saved");

  await confirm(page, "disable", "disabled");
  const off = await api(page, `apps/${state.installId}`);
  drill.check(off.json?.install?.status === "disabled" && off.json?.install?.settings?.badges?.[0]?.label === "Free delivery", "owner: turned off, settings kept");
  await confirm(page, "enable", "enabled");
  drill.check((await api(page, `apps/${state.installId}`)).json?.install?.status === "enabled", "owner: turned on again");

  await open(page, `/admin/apps/${state.installId}`);
  const activity = page.locator('[data-apps="activity"] li');
  await activity.first().waitFor();
  const actions = await activity.evaluateAll((els) => els.map((e) => e.getAttribute("data-activity")));
  drill.check(["apps.install", "apps.settings", "apps.disable", "apps.enable"].every((a) => actions.includes(a)), "owner: Activity lists install, settings, off and on", actions);
  await drill.shoot(page, "owner-app-page");
  await page.context().close();
}

async function readOnly(drill, role) {
  const page = await signIn(drill, role);
  drill.check((await open(page, "/admin/apps")) === 200, `${role}: /admin/apps opens (200)`);
  const rows = page.locator('[data-apps="tabs"] tbody tr');
  await rows.first().waitFor();
  drill.check((await rows.count()) === 1 && (await rows.first().innerText()).includes("Trust badges"), `${role}: the Installed tab lists Trust badges`);
  await page.locator('[data-apps-tab="browse"]').click();
  await page.locator(`[data-app-card="${PLUGIN}"]`).waitFor();
  drill.check((await writeControls(page)).length === 0, `${role}: Browse shows no live write control`, await writeControls(page));
  await open(page, `/admin/apps/${state.installId}`);
  await page.locator('[data-apps="detail"]').waitFor();
  const live = await writeControls(page);
  drill.check(live.length === 0, `${role}: the app's page shows no live write control (no toggles, no Save, fields disabled)`, live);
  drill.check((await page.locator('[data-apps="activity"]').count()) === 0, `${role}: no Activity`);
  const refused = await api(page, `apps/${state.installId}`, { disable: true });
  drill.check(refused.status === 403, `${role}: the API refuses Turn off (403)`, refused);
  await drill.shoot(page, `${role}-app-page`);
  await page.context().close();
}

async function ownerUninstalls(drill) {
  const page = await signIn(drill, "owner");
  await open(page, `/admin/apps/${state.installId}`);
  await page.locator('[data-apps="detail"]').waitFor();
  await page.locator('[data-apps-action="uninstall"]').click();
  const dialog = page.locator('[data-apps="confirm"]');
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Uninstall" }).click();
  await page.waitForURL((u) => u.pathname === "/admin/apps", { timeout: 30_000 });
  await page.locator(`[data-app-card="${PLUGIN}"] [data-app-install="${PLUGIN}"]`).waitFor({ timeout: 15_000 });
  const list = await api(page, "apps");
  drill.check(list.status === 200 && list.json?.installs?.length === 0, "owner: uninstalled, the Installed list is empty and Install is back on Browse", list.json?.installs);
  drill.check((await open(page, `/admin/apps/${state.installId}`)) === 404, "owner: the uninstalled app's page is a not-found");
  await drill.shoot(page, "owner-after-uninstall");
  await page.context().close();
}

stage("install", async (drill) => {
  await ownerInstalls(drill);
  await readOnly(drill, "staff");
  await readOnly(drill, "support");
  await ownerUninstalls(drill);
});
