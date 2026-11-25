// MEDIA: `pnpm drill:media`, the media screen in a real browser (Phase 2
// line 5, docs/plans/phase-2.md "Line 5" §5.6). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree on its own roles
// store (seeded and started there); never in the owner's checkout.
//   staff: uploads two files through the hidden input (setInputFiles), each
//     with its own progress row; finds one by name; edits its alt text;
//     archives it and brings it back; one more file arrives by a real drop
//     (a DataTransfer drop event on the zone)
//   a file used on home (the home draft's hero image, saved through the
//     documents API): Delete is refused with the fixed words, the place by
//     page name and "Archive it instead", and no force anywhere
//   an unused file is deleted
//   support: no upload zone or file input, no alt field, archive or delete;
//     "Where it's used" lists home; the only non-GET request support sends is
//     that usage PUT, and it answers 200
// Evidence: docs/cms-reviews/drills/MEDIA/ (results-main.json, screenshots).
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { docsApi, runDrill, settle } from "../p3/lib.mjs";

const DRILL_ID = "MEDIA";
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const MEDIA_PAGE = "/admin/media";
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));

// A solid-colour PNG (its own bytes per colour, so no two dedupe).
function png(r, g, b, size = 48) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([r, g, b]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const consoleErrors = [];
async function signIn(drill, role) {
  const m = seed().members.find((x) => x.role === role);
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30_000);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    // the refused delete's 409 is the answer the drill asks for
    if (msg.type() === "error" && !/eval\(\) is not supported|status of 409 \(Conflict\)/.test(msg.text())) consoleErrors.push(`${role}: ${msg.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${role}: ${String(e?.message || e).slice(0, 300)}`));
  return page;
}

const library = (page, query = "") => page.evaluate(async (q) => (await fetch(`/api/admin/media?view=library${q}`)).json(), query);
const findByName = async (page, name) => (await library(page, `&q=${encodeURIComponent(name)}`)).items?.find((m) => m.filename === name) || null;
const card = (page, name) => page.locator('[data-media="grid"] button[data-media-id]', { hasText: name });
const sheet = (page) => page.locator('[data-media="sheet"]');
const dialog = (page) => page.locator('[data-media="delete-dialog"]');
const waitFor = (page, fn, arg, ms = 30_000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const openMedia = async (page) => {
  await page.goto(ORIGIN + MEDIA_PAGE, { waitUntil: "load" });
  await settle(page);
};
async function openCard(page, name) {
  await card(page, name).first().click();
  await sheet(page).waitFor({ timeout: 10_000 });
}
async function closeSheet(page) {
  await dialog(page).waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  await sheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await sheet(page).waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
}

async function staffFlows(drill) {
  const page = await signIn(drill, "staff");
  await openMedia(page);
  drill.check((await page.locator('[data-media="upload-zone"]').count()) === 1 && (await page.getByRole("button", { name: "Upload images" }).count()) === 1, "staff: the upload zone and the header's Upload images");

  // 1. two files through the input, each with its own row
  await page.locator('[data-media="file-input"]').setInputFiles([
    { name: "drill-red.png", mimeType: "image/png", buffer: png(220, 40, 40) },
    { name: "drill-blue.png", mimeType: "image/png", buffer: png(40, 60, 220) },
  ]);
  const rowsDone = await waitFor(page, () => {
    const rows = [...document.querySelectorAll('[data-media="upload-row"]')];
    return rows.length === 2 && rows.every((r) => r.getAttribute("data-state") === "success");
  });
  const rowText = await page.locator('[data-media="upload-row"]').allInnerTexts();
  drill.check(rowsDone && rowText.some((t) => t.includes("drill-red.png uploaded")) && rowText.some((t) => t.includes("drill-blue.png uploaded")), "staff uploads two files at once: one row each, both 'uploaded'", rowText);
  await waitFor(page, () => document.querySelectorAll('[data-media="grid"] button[data-media-id]').length >= 2);
  drill.check((await card(page, "drill-red.png").count()) === 1 && (await card(page, "drill-blue.png").count()) === 1, "both files show in the grid");
  await drill.shoot(page, "staff-uploaded");

  // the same bytes again: reused
  await page.locator('[data-media="file-input"]').setInputFiles([{ name: "drill-red-again.png", mimeType: "image/png", buffer: png(220, 40, 40) }]);
  const reused = await waitFor(page, () => [...document.querySelectorAll('[data-media="upload-row"]')].some((r) => /reused/.test(r.textContent)));
  drill.check(reused, "the same bytes again say 'reused'");

  // 2. find one by name
  await page.getByRole("searchbox", { name: "Search files" }).fill("drill-blue");
  const found = await waitFor(page, () => {
    const cards = [...document.querySelectorAll('[data-media="grid"] button[data-media-id]')];
    return cards.length === 1 && cards[0].textContent.includes("drill-blue.png");
  });
  drill.check(found, "the search finds drill-blue.png alone");

  // 3. alt text
  await openCard(page, "drill-blue.png");
  drill.check((await sheet(page).getByText("No alt text yet").count()) === 1, "the sheet notes the empty alt text");
  await sheet(page).locator("textarea").fill("A blue square");
  await sheet(page).getByRole("button", { name: "Save alt text" }).click();
  let altSaved = false;
  for (let i = 0; i < 40 && !altSaved; i++) {
    altSaved = (await findByName(page, "drill-blue.png"))?.alt === "A blue square";
    if (!altSaved) await page.waitForTimeout(250);
  }
  drill.check(altSaved, "staff saves the alt text and the library has it");
  await drill.shoot(page, "staff-sheet");

  // 4. archive and bring back
  await sheet(page).getByRole("button", { name: "Archive", exact: true }).click();
  await sheet(page).waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  const archived = await waitFor(page, () => document.querySelectorAll('[data-media="grid"] button[data-media-id]').length === 0);
  await page.getByRole("tab", { name: /Archived/ }).click();
  await waitFor(page, () => document.querySelectorAll('[data-media="grid"] button[data-media-id]').length === 1);
  drill.check(archived && (await card(page, "drill-blue.png").count()) === 1 && (await findByName(page, "drill-blue.png")) === null, "Archive moves it to the Archived tab");
  await openCard(page, "drill-blue.png");
  await sheet(page).getByRole("button", { name: "Bring back" }).click();
  await sheet(page).waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  drill.check((await findByName(page, "drill-blue.png"))?.archived_at === null, "Bring back returns it to the library");

  // 5. a real drop: a DataTransfer drop event on the zone
  await page.getByRole("tab", { name: /Active/ }).click();
  await page.getByRole("searchbox", { name: "Search files" }).fill("");
  const bytes = [...png(40, 180, 60)];
  await page.locator('[data-media="drop"]').evaluate((zone, b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], "drill-green.png", { type: "image/png" }));
    zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, bytes);
  const dropped = await waitFor(page, () => [...document.querySelectorAll('[data-media="upload-row"]')].some((r) => r.textContent.includes("drill-green.png uploaded")));
  drill.check(dropped && (await findByName(page, "drill-green.png")) !== null, "a file dropped on the zone uploads");

  // 6. a file used on home: the delete is refused
  const red = await findByName(page, "drill-red.png");
  const listed = await docsApi(page, { listDocuments: { type: "home" } });
  let homeId = (listed.body?.documents || []).find((d) => d.type === "home")?.id || null;
  if (!homeId) homeId = (await docsApi(page, { createDocument: { type: "home" } })).body?.document?.id || null;
  const home = homeId ? await docsApi(page, { getDocument: homeId }) : { body: null };
  const doc = home.body?.document;
  const body = structuredClone(doc?.body || { sections: [] });
  body.sections ||= [];
  let hero = body.sections.find((s) => s.kind === "hero");
  if (!hero) {
    const Reg = await import("../../../lib/registry/index.js");
    hero = Reg.newSection("hero", { id: "sec_drillhero" });
    body.sections.unshift(hero);
  }
  hero.settings = { ...hero.settings, image: { media: red.url, alt: "" } };
  const saved = doc ? await docsApi(page, { saveDraft: { id: doc.id, body }, revision: doc.revision }) : { status: 0, body: listed };
  drill.check(saved.status === 200, "the home draft's hero uses drill-red.png (documents API)", { status: saved.status, homeId, body: JSON.stringify(saved.body).slice(0, 300) });
  await openMedia(page);
  await openCard(page, "drill-red.png");
  await sheet(page).getByRole("button", { name: "Delete" }).click();
  await dialog(page).getByRole("button", { name: "Delete file" }).click();
  const refused = await dialog(page).locator('[data-media="refusal-usage"]').waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const words = refused ? await dialog(page).innerText() : "";
  const dialogButtons = refused ? await dialog(page).getByRole("button").allInnerTexts() : [];
  drill.check(refused && words.includes("This file can't be deleted") && words.includes("still used") && /home/i.test(await dialog(page).locator('[data-media="refusal-usage"]').innerText()), "deleting the file home uses is refused: the fixed words and home by name", words);
  drill.check(dialogButtons.includes("Archive it instead") && !dialogButtons.some((b) => /anyway|force/i.test(b)), "the refusal offers Archive it instead and no force", dialogButtons);
  await drill.shoot(page, "staff-delete-refused");
  drill.check((await findByName(page, "drill-red.png")) !== null, "the used file is still in the library");
  // Archive it instead: archived, under the Archived tab; then brought back for the support step
  await dialog(page).getByRole("button", { name: "Archive it instead" }).click();
  await sheet(page).waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  let redArchived = null;
  for (let i = 0; i < 40 && !redArchived; i++) {
    redArchived = (await library(page, "&archived=only&q=drill-red.png")).items?.find((m) => m.filename === "drill-red.png" && m.archived_at) || null;
    if (!redArchived) await page.waitForTimeout(250);
  }
  await page.getByRole("tab", { name: /Archived/ }).click();
  const underTab = await waitFor(page, () => [...document.querySelectorAll('[data-media="grid"] button[data-media-id]')].some((b) => b.textContent.includes("drill-red.png")));
  drill.check(Boolean(redArchived?.archived_at) && underTab && (await findByName(page, "drill-red.png")) === null, "Archive it instead archives the used file: archived_at set, shown under Archived", redArchived);
  await openCard(page, "drill-red.png");
  await sheet(page).getByRole("button", { name: "Bring back" }).click();
  await sheet(page).waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  let back = false;
  for (let i = 0; i < 40 && !back; i++) {
    back = (await findByName(page, "drill-red.png"))?.archived_at === null;
    if (!back) await page.waitForTimeout(250);
  }
  drill.check(back, "drill-red.png is brought back before the support step");
  await page.getByRole("tab", { name: /Active/ }).click();

  // 7. an unused file is deleted
  await openCard(page, "drill-green.png");
  await sheet(page).getByRole("button", { name: "Delete" }).click();
  await dialog(page).getByRole("button", { name: "Delete file" }).click();
  await sheet(page).waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    gone = (await findByName(page, "drill-green.png")) === null && (await card(page, "drill-green.png").count()) === 0;
    if (!gone) await page.waitForTimeout(250);
  }
  drill.check(gone, "deleting an unused file removes it");
  await page.context().close();
}

async function supportView(drill) {
  const page = await signIn(drill, "support");
  const writes = [];
  page.on("response", (r) => {
    const m = r.request().method();
    // the app's own requests (Next's dev overlay posts to /__nextjs_*)
    if (m !== "GET" && m !== "HEAD" && !new URL(r.url()).pathname.startsWith("/__nextjs")) writes.push(`${m} ${new URL(r.url()).pathname} ${r.status()}`);
  });
  await openMedia(page);
  const sees = {
    zone: await page.locator('[data-media="upload-zone"]').count(),
    input: await page.locator('input[type="file"]').count(),
    upload: await page.getByRole("button", { name: /Upload images|Choose images/ }).count(),
    readOnly: await page.locator("main").getByText("You have read-only access", { exact: false }).count(),
  };
  drill.check(sees.zone === 0 && sees.input === 0 && sees.upload === 0 && sees.readOnly === 1, "support: no upload zone, file input or upload button; the read-only line", sees);
  await drill.shoot(page, "support-library");
  await openCard(page, "drill-red.png");
  const inSheet = {
    textarea: await sheet(page).locator("textarea").count(),
    writes: await sheet(page).getByRole("button", { name: /Save alt text|Archive|Bring back|Delete/ }).count(),
    alt: await sheet(page).locator('[data-media="alt-read"]').count(),
  };
  drill.check(inSheet.textarea === 0 && inSheet.writes === 0 && inSheet.alt === 1, "support's sheet: the alt text read-only, no Save, Archive or Delete", inSheet);
  await sheet(page).getByRole("button", { name: "Where it's used" }).click();
  const used = await sheet(page).locator('[data-media="usage"]').waitFor({ timeout: 15_000 }).then(() => sheet(page).locator('[data-media="usage"]').innerText(), () => "");
  drill.check(/home/i.test(used), "support's Where it's used lists home", used);
  await drill.shoot(page, "support-sheet");
  await page.waitForTimeout(300);
  drill.check(writes.length > 0 && writes.every((w) => w === "PUT /api/admin/media 200"), "support's only non-GET request is the usage PUT (a read), answered 200", writes);
  await page.context().close();
}

async function media(drill) {
  if (!port) throw new Error("drill:media needs ROLES_PORT (run it as pnpm drill:media).");
  await staffFlows(drill);
  await supportView(drill);
  drill.check(consoleErrors.length === 0, "no error in the browser console (staff and support)", consoleErrors);
}

runDrill({ id: DRILL_ID, part: "main", title: "MEDIA — upload, find, archive and delete, every role" }, media).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
