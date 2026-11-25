// drill:studio stage "drag" (Phase 6 line 1): a pointer drag in the
// Sections rail with every draft save held back 2 s by a route: the frame's
// order changes before the save's answer arrives, and the new order is still
// there after a reload. Then a keyboard move from the handle: Space picks up
// (focus stays on the handle), ArrowDown moves, Space drops, and the live
// region reads the plan's exact words.
import { stage, state } from "./lib.mjs";
import { HOME_IDS, frameOrder, openStudio, railOrder, upToDate } from "./stage-open.mjs";

const live = (page) => page.locator("[data-studio-live]").evaluate((el) => el.textContent.replace(/ /g, "").trim());

stage("drag", async (drill) => {
  const page = await openStudio(drill, "owner");
  await upToDate(page);

  // every saveDraft waits 2 s; the answer's arrival is noted
  const saves = { sent: 0, answered: 0 };
  await page.route("**/api/admin/documents", async (route) => {
    const body = route.request().postData() || "";
    if (route.request().method() === "PUT" && body.includes('"saveDraft"')) {
      saves.sent++;
      await new Promise((r) => setTimeout(r, 2000));
      const res = await route.fetch();
      await route.fulfill({ response: res });
      saves.answered++;
      return;
    }
    await route.continue();
  });

  // --- pointer: drag "Drill one" (row 0) below "Drill three" (row 2) ---
  const handle = page.locator('[data-tree-handle="sec_drillone1"]');
  const target = page.locator('[data-section-row="sec_drillthree3"]');
  const h = await handle.boundingBox();
  const t = await target.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 6, { steps: 2 }); // past the 4px threshold
  await page.locator("[data-tree-dragging]").waitFor();
  await page.mouse.move(h.x + h.width / 2, t.y + t.height * 0.75, { steps: 8 });
  drill.check((await page.locator("[data-drop-line]").count()) === 1, "pointer: a drop line shows the target");
  const during = await frameOrder(page);
  drill.check(JSON.stringify(during) === JSON.stringify(["sec_drilltwo2", "sec_drillthree3", "sec_drillone1", "sec_drillfour4"]), "pointer: the frame reorders while dragging", during);
  await page.mouse.up();
  const want = ["sec_drilltwo2", "sec_drillthree3", "sec_drillone1", "sec_drillfour4"];
  await page.waitForFunction(() => document.querySelector("[data-studio-live]")?.textContent.includes("dropped at position 3 of 4"));
  drill.check(JSON.stringify(await railOrder(page)) === JSON.stringify(want), "pointer: the rail shows the new order", await railOrder(page));
  const before = await frameOrder(page);
  drill.check(saves.answered === 0, "pointer: the frame changed before the save's answer came back", saves);
  drill.check(JSON.stringify(before) === JSON.stringify(want), "pointer: the frame's order is the new one at once", before);
  drill.check((await live(page)) === "Rich text dropped at position 3 of 4.", "pointer: the drop is announced", await live(page));
  drill.check((await page.locator('[data-preview-status="Up to date"]').count()) === 0 || saves.answered > 0, "the frame doesn't say \"Up to date\" before the save is acknowledged");
  await page.waitForFunction(() => document.querySelector('[data-save-status="saved"]'), null, { timeout: 15_000 });
  await upToDate(page);
  drill.check(saves.answered >= 1, "the delayed save was answered", saves);
  await page.unroute("**/api/admin/documents");
  await page.reload({ waitUntil: "load" });
  await page.locator("[data-studio-sections] [data-section-row]").first().waitFor();
  await upToDate(page);
  drill.check(JSON.stringify(await frameOrder(page)) === JSON.stringify(want), "pointer: the order survives a reload", await frameOrder(page));
  await drill.shoot(page, "drag-pointer");

  // --- keyboard: "Drill two" (now row 0) down one ---
  const kb = page.locator('[data-tree-handle="sec_drilltwo2"]');
  await kb.focus();
  await page.keyboard.press("Space");
  drill.check((await live(page)) === "Picked up Rich text, position 1 of 4. Arrow keys move it, Space drops it, Escape cancels.", "keyboard: pick up is announced", await live(page));
  await page.keyboard.press("ArrowDown");
  drill.check((await live(page)) === "Rich text, position 2 of 4.", "keyboard: the move is announced", await live(page));
  drill.check(await page.evaluate(() => document.activeElement?.getAttribute("data-tree-handle")) === "sec_drilltwo2", "keyboard: focus stays on the held handle");
  drill.check(JSON.stringify(await frameOrder(page)) === JSON.stringify(["sec_drillthree3", "sec_drilltwo2", "sec_drillone1", "sec_drillfour4"]), "keyboard: the frame follows the hold", await frameOrder(page));
  await page.keyboard.press("Space");
  drill.check((await live(page)) === "Rich text dropped at position 2 of 4.", "keyboard: the drop is announced", await live(page));
  // Escape returns a held section
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  drill.check((await live(page)) === "Move cancelled. Rich text is back at position 2.", "keyboard: Escape returns it", await live(page));
  await page.waitForFunction(() => document.querySelector('[data-save-status="saved"]'));
  await upToDate(page);
  state.homeOrder = ["sec_drillthree3", "sec_drilltwo2", "sec_drillone1", "sec_drillfour4"];
  drill.check(JSON.stringify(await railOrder(page)) === JSON.stringify(state.homeOrder), "keyboard: the rail's final order", await railOrder(page));
  drill.check(HOME_IDS.length === 4, "the four drill sections are all still there");
  await drill.shoot(page, "drag-keyboard");
  await page.context().close();
});
