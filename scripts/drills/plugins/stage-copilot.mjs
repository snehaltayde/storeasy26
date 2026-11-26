// drill:plugins stage "copilot" (Phase 9 line 5): the AI copilot on the stub
// provider (AI_PROVIDER=stub, answers from scripts/fixtures/ai/<task>.json;
// drillEnv sets both). The owner installs it from the Copilot page and runs
// product SEO and FAQs on two products: their content drafts hold the search
// title and the FAQ and the editor opens them; an anonymous shopper's product
// page is unchanged (nothing published). Offer ideas appear as offers that are
// off (the over-the-cap one is dropped). The budget meter rises. Support sees
// the page with no run button.
import { ORIGIN, open, rolesSql, shopper, signIn, stage } from "./lib.mjs";

// the roles store's fixture pictures don't exist; Next's image route would 404
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const stubImages = (page) => page.context().route("**/_next/image**", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));

const meter = async (page) => Number(await page.locator("[data-copilot-meter]").first().getAttribute("data-copilot-meter")) || 0;

stage("copilot", async (drill) => {
  const products = (await rolesSql(["SELECT id, handle FROM products ORDER BY title LIMIT 2"]))[0];
  drill.check(products.length === 2, "the roles store has two products to choose", products.length);

  // the anonymous product page before
  const sp = await shopper(drill);
  const readHead = async () => {
    const r = await sp.goto(`${ORIGIN}/products/${products[0].handle}`, { waitUntil: "load" });
    return { status: r?.status(), title: await sp.title(), description: await sp.locator('meta[name="description"]').first().getAttribute("content").catch(() => null) };
  };
  const pdpBefore = await readHead();
  drill.check(pdpBefore.status === 200, "the product page opens for a shopper (200)", pdpBefore.status);

  const owner = await signIn(drill, "owner");
  await stubImages(owner);
  drill.check((await open(owner, "/admin/copilot")) === 200, "owner: /admin/copilot opens (200)");
  await owner.locator("[data-copilot-install]").waitFor();
  drill.check(true, "owner: the page is an install prompt until the copilot is installed");
  await owner.locator("[data-copilot-install-button]").click();
  await owner.locator('[data-copilot-task="product_seo"]').waitFor();
  drill.check((await owner.locator("[data-copilot-task]").count()) === 3, "owner: three tasks once installed");
  const before = await meter(owner);

  for (const p of products) await owner.locator(`[data-copilot-product="${p.handle}"]`).click();
  await owner.locator('[data-copilot-run="product_seo"]').click();
  await owner.locator("[data-copilot-notice]").waitFor({ timeout: 60_000 });
  const tone = await owner.locator("[data-copilot-notice]").getAttribute("data-copilot-notice");
  drill.check(tone === "success", "owner: SEO and FAQs ran (a success notice)", { tone, text: await owner.locator("[data-copilot-notice]").innerText() });
  drill.check((await owner.locator('[data-copilot-draft="product"]').count()) === 2, "owner: the notice links to two product drafts");
  await drill.shoot(owner, "copilot");

  const drafts = (await rolesSql([{ sql: "SELECT entity_id, draft FROM documents WHERE type = 'product_content' AND entity_id IN (?, ?)", args: products.map((p) => p.id) }]))[0];
  const bodies = drafts.map((d) => JSON.parse(String(d.draft)));
  drill.check(bodies.length === 2 && bodies.every((b) => /^Copilot drill title/.test(b.settings?.seo_title || "") && b.sections?.some((s) => s.kind === "faq")), "both products have a content draft with a search title and a FAQ", bodies.map((b) => b.settings?.seo_title));
  const live = (await rolesSql([{ sql: "SELECT count(*) AS n FROM product_content_live WHERE seo_title LIKE 'Copilot drill%'", args: [] }]))[0][0];
  drill.check(Number(live.n) === 0, "nothing is live: no live row carries the copilot's title", live.n);

  const href = await owner.locator('[data-copilot-draft="product"]').first().getAttribute("href");
  const editor = await signIn(drill, "owner");
  await stubImages(editor);
  drill.check((await open(editor, href)) === 200, "the editor opens the first product's draft (200)", href);
  const titleField = editor.getByLabel("Search title", { exact: true }).first();
  await titleField.waitFor({ timeout: 30_000 }).catch(() => {});
  const shown = (await titleField.count()) ? await titleField.inputValue().catch(() => "") : "";
  drill.check(/^Copilot drill title/.test(shown), "the editor shows the drafted search title", shown);
  if (await titleField.count()) await titleField.scrollIntoViewIfNeeded().catch(() => {});
  await drill.shoot(editor, "copilot-editor");
  await editor.context().close();

  const pdpAfter = await readHead();
  drill.check(JSON.stringify(pdpAfter) === JSON.stringify(pdpBefore), "the anonymous product page is unchanged (title and description)", { pdpBefore, pdpAfter });
  await sp.context().close();

  await owner.locator('[data-copilot-run="offer_ideas"]').click();
  await owner.locator('[data-copilot-draft="offer"]').first().waitFor({ timeout: 60_000 });
  const offers = (await rolesSql(["SELECT id, enabled, config FROM offers WHERE id LIKE 'copilot-%'"]))[0];
  drill.check(offers.length === 2 && offers.every((o) => Number(o.enabled) === 0 && JSON.parse(String(o.config)).source === "copilot"), "offer ideas are two offers, both off, marked as the copilot's (the 40% one dropped)", offers.map((o) => [o.id, o.enabled]));
  drill.check((await open(owner, "/admin/offers")) === 200, "owner: Offers opens (200)");
  drill.check((await owner.getByText("Copilot welcome ten").count()) > 0, "owner: the offer idea is listed in Offers");

  drill.check((await open(owner, "/admin/copilot")) === 200, "owner: the copilot page again");
  const after = await meter(owner);
  drill.check(after > before, "the budget meter rose", { before, after });
  drill.check((await owner.locator("[data-copilot-history]").count()) === 1, "owner: recent runs are listed");
  await owner.context().close();

  const support = await signIn(drill, "support");
  drill.check((await open(support, "/admin/copilot")) === 200, "support: /admin/copilot opens (200)");
  await support.locator("[data-copilot-task]").first().waitFor();
  drill.check((await support.locator("[data-copilot-run]").count()) === 0 && (await support.locator("[data-copilot-product]").count()) === 0, "support: no run button and no product picker");
  await support.context().close();
});
