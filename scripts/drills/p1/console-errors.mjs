// What the Next dev overlay's "1 Issue" is on a storefront page: console and
// page errors on a signed-out load. Part of the P1 drill notes.
export const id = "harness";
export const title = "Storefront console errors";
export const parts = {
  async "home-console"(drill) {
    const ctx = await drill.context({ width: 1440 });
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errs.push(`${m.type()}: ${m.text().slice(0, 400)}`));
    page.on("pageerror", (e) => errs.push(`pageerror: ${String(e.message).slice(0, 400)}`));
    for (const p of ["/", "/products/glow-serum", "/account"]) {
      await drill.open(page, p);
      await page.waitForTimeout(1500);
      drill.note(`${p}: ${JSON.stringify(errs.splice(0))}`);
    }
    await ctx.close();
  },
};
