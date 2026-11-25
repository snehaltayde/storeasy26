// drill:themes stage "upload" (Phase 5 line 1): the owner opens Themes (the
// built-in looks, no uploaded theme yet), uploads Aurora from a file (the
// dialog summarises it) and opens its page (Download and Archive offered);
// then uploads an evil package and sees every issue with its place,
// and nothing new is listed. Staff sees the list and Aurora's page with no
// Upload or Archive (and the API refuses staff's upload).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, open, signIn, stage, state } from "./lib.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "themes");
const fixturePath = (name) => join(FIX, `${name}.theme.json`);

async function uploadFile(page, name) {
  await page.locator('[data-themes-action="upload"]').click();
  const dialog = page.locator('[data-themes="upload-dialog"]');
  await dialog.waitFor();
  await dialog.locator('input[type="file"]').setInputFiles(fixturePath(name));
  await dialog.locator('[data-themes-action="upload-submit"]').click();
  return dialog;
}

async function ownerUploads(drill) {
  const page = await signIn(drill, "owner");
  drill.check((await open(page, "/admin/themes")) === 200, "owner: /admin/themes opens (200)");
  drill.check((await page.locator("[data-theme-builtin]").count()) === 2, "owner: the built-in looks Pulse and Glow are listed");
  drill.check((await page.getByText("No uploaded themes yet").count()) === 1, "owner: the plain empty state shows");
  await drill.shoot(page, "owner-themes-empty");

  const dialog = await uploadFile(page, "aurora");
  const done = dialog.locator('[data-themes="upload-done"]');
  await done.waitFor({ timeout: 30_000 });
  const summary = await done.innerText();
  drill.check(/Aurora 1\.2\.0 was uploaded/.test(summary) && /Based on Pulse/.test(summary) && /2 home page sections/.test(summary), "owner: the upload summary names the base, sections and rules", summary);
  await drill.shoot(page, "owner-upload-done");
  const list = await api(page, "themes");
  const aurora = list.json?.packages?.find((p) => p.slug === "aurora");
  drill.check(list.status === 200 && Boolean(aurora), "owner: Aurora is listed", list.json?.packages?.map((p) => p.name));
  state.themeId = aurora?.id;

  await open(page, `/admin/themes/${state.themeId}`);
  await page.locator('[data-themes="detail"]').waitFor();
  drill.check((await page.locator('[data-themes-action="download"]').count()) === 1, "owner: Download package is offered");
  drill.check((await page.locator('[data-themes-action="archive"]').count()) === 1, "owner: Archive is offered");
  await drill.shoot(page, "owner-theme-detail");

  await open(page, "/admin/themes");
  const evil = await uploadFile(page, "evil-script");
  const issues = evil.locator('[data-themes="upload-issues"]');
  await issues.waitFor({ timeout: 30_000 });
  const text = await issues.innerText();
  drill.check(/Themes can't contain scripts\./.test(text) && /templates\.home\.sections\[1\]\.settings\.html/.test(text), "owner: the evil package is refused in plain words with its place", text);
  await drill.shoot(page, "owner-upload-refused");
  const after = await api(page, "themes");
  drill.check(after.json?.packages?.length === list.json?.packages?.length, "owner: nothing new was stored");
  await page.context().close();
}

async function staffReads(drill) {
  const page = await signIn(drill, "staff");
  drill.check((await open(page, "/admin/themes")) === 200, "staff: /admin/themes opens (200)");
  drill.check((await page.locator('[data-themes-action="upload"]').count()) === 0, "staff: no Upload theme button");
  await open(page, `/admin/themes/${state.themeId}`);
  await page.locator('[data-themes="detail"]').waitFor();
  drill.check((await page.locator('[data-themes-action="archive"]').count()) === 0, "staff: no Archive button");
  const refused = await api(page, "themes", { format: "storeasy-theme/1" });
  drill.check(refused.status === 403, "staff: the API refuses an upload (403)", refused.status);
  await drill.shoot(page, "staff-theme-detail");
  await page.context().close();
}

stage("upload", async (drill) => {
  await ownerUploads(drill);
  await staffReads(drill);
});
