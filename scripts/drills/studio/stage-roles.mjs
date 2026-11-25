// drill:studio stage "roles" (Phase 6 line 1): staff drag (a keyboard move
// that saves) and see "Ask an admin to publish." instead of Publish; support
// sees the sections with no handle, insert point, Add or row button, Space
// on a row picks nothing up, and no documents write leaves the browser.
import { stage } from "./lib.mjs";
import { openStudio, railOrder, upToDate } from "./stage-open.mjs";

const WRITES = /"(saveDraft|publish|publishSet|createDocument|undo|undoSet|unpublish|discardDraft|restoreVersion|keepLiveSection|archiveDocument)"/;

stage("roles", async (drill) => {
  // --- staff ---
  const staff = await openStudio(drill, "staff");
  await upToDate(staff);
  drill.check((await staff.locator("[data-studio-publish]").count()) === 0, "staff: no Publish");
  drill.check((await staff.getByText("Ask an admin to publish.", { exact: true }).count()) === 1, "staff: \"Ask an admin to publish.\"");
  const before = await railOrder(staff);
  const first = staff.locator(`[data-tree-handle="${before[1]}"]`);
  await first.focus();
  await staff.keyboard.press("Space");
  await staff.keyboard.press("ArrowDown");
  await staff.keyboard.press("Space");
  const after = await railOrder(staff);
  drill.check(after[2] === before[1], "staff: the keyboard move took", { before, after });
  await staff.waitForFunction(() => document.querySelector('[data-save-status="saved"]'));
  drill.check(true, "staff: the move saved as a draft");
  await staff.context().close();

  // --- support ---
  const support = await openStudio(drill, "support");
  const writes = [];
  support.on("request", (req) => {
    if (req.url().includes("/api/admin/documents") && req.method() !== "GET" && WRITES.test(req.postData() || "")) writes.push(req.postData().slice(0, 120));
  });
  for (const sel of ["[data-tree-handle]", "[data-tree-insert]", "[data-tree-add]", "[data-op]", "[data-studio-undo]", "[data-studio-publish]"]) drill.check((await support.locator(sel).count()) === 0, `support: no ${sel}`);
  drill.check((await support.locator("[data-studio-readonly]").count()) === 1, "support: the studio is read-only");
  const rows = await railOrder(support);
  await support.locator("[data-tree-select]").first().focus();
  await support.keyboard.press("Space");
  await support.keyboard.press("ArrowDown");
  await support.keyboard.press("Space");
  drill.check(JSON.stringify(await railOrder(support)) === JSON.stringify(rows), "support: Space picks nothing up, the order is the same");
  drill.check((await support.locator("[data-studio-live]").innerText()).trim() === "", "support: nothing is announced");
  await support.keyboard.press("Meta+z");
  drill.check(writes.length === 0, "support: no documents write was sent", writes);
  await drill.shoot(support, "roles-support");
  await support.context().close();
});
