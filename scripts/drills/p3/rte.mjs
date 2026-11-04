// P3-RTE drill (AU-01, ED-04): the rich text field in desktop Chrome on the
// design harness, saving through the real documents API and shown in the real
// storefront preview.
//
//   DESIGN_PORT=6140 DESIGN_SQLD_PORT=7140 node scripts/drills/p3/rte.mjs [--headed]
//
// The host. The new editor page (P3-EDITOR) is built in the same batch, so
// this drill hosts the real RichTextField itself: a small page that the drill
// serves on the harness's own address (playwright's page.route), with the
// console's own style sheets, signed in as the owner. The page's script is the
// real component and the real documents client (components/admin/editor/
// documentsApi.js), compiled with Next's SWC and bundled here with React. Its
// Save button does what the editor's store does after a save: saveDraft, then
// the stored value goes back into the field.
//
// Steps:
//   1. an untouched value: clicks and arrow keys send nothing, and saving
//      stores the same bytes and the same hash;
//   2. focusRequest offset 2 puts the caret at the start of the third block;
//   3. type a paragraph, make words bold with the Bold button, make a word a
//      link with the Link button;
//   4. paste a Word fragment with a script, an onclick and inline styles: the
//      field sends it as copied, nothing in it runs, and the save stores it
//      cleaned; the field then shows the stored value;
//   5. preview: the storefront shows the saved text, with the same .rte rules
//      as the editor's surface;
//   6. a table opens read-only with Edit as HTML; editing it as HTML stores
//      the cleaned result.
// Results: docs/cms-reviews/drills/P3-RTE/results-rte.json, with screenshots.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { ROOT } from "../../design-harness.js";
import { DrillError, docsApi, reseed, runDrill, storeSql } from "./lib.mjs";

const FIELD = join(ROOT, "components/admin/editor/fields/RichTextField.js");
const API = join(ROOT, "components/admin/editor/documentsApi.js");
const HOST = "/__p3-rte-drill/host.html";
const BUNDLE = "/__p3-rte-drill/host.js";
const FIELD_ID = "f-sec_rte1-html";

const WORD_CLIPBOARD = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><meta name=ProgId content=Word.Document><meta name=Generator content="Microsoft Word 15">
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]-->
<style><!-- p.MsoNormal {margin:0cm; font-size:12.0pt; font-family:"Calibri",sans-serif;} --></style>
</head>
<body lang=EN-IN style='tab-interval:36.0pt'>
<!--StartFragment--><p class=MsoNormal style='margin-bottom:8.0pt;line-height:107%'><b><span style='font-size:14.0pt;mso-bidi-font-size:11.0pt;color:#C00000'>Spring sizes</span></b><span style='mso-spacerun:yes'> </span>run small.<o:p></o:p></p>
<p class=MsoListParagraphCxSpFirst style='text-indent:-18.0pt;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><![endif]>Order one size up<o:p></o:p></p>
<script>window.parent.__pwned = 'script'; alert('pasted')</script>
<p class=MsoNormal><span style='color:red' onclick="window.parent.__pwned='onclick'">Free returns</span> within 30 days.<details open ontoggle="window.parent.__pwned='ontoggle'">Ask us anything.</details><o:p></o:p></p><!--EndFragment-->
</body></html>`;
const WORD_TEXT = "Spring sizes run small.\nOrder one size up\nFree returns within 30 days.";
const START = "<p>First paragraph.</p><p>Second paragraph.</p><p>Third paragraph.</p>";
const TABLE = "<p>Sizes:</p><table><tbody><tr><th>Size</th><td>Chest</td></tr><tr><th>M</th><td>96 cm</td></tr></tbody></table>";

// ---------- the host page's script: the real field, bundled ----------

const require = createRequire(import.meta.url);
async function compile(file, code) {
  const swc = require("next/dist/build/swc/index.js");
  await swc.loadBindings();
  return (
    await swc.transform(code ?? (await readFile(file, "utf8")), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
}

// A small CommonJS bundle: the entry, every repo module it reaches (compiled
// with SWC) and React's own CommonJS files, with NODE_ENV fixed.
async function bundle(entryCode) {
  const mods = new Map();
  async function add(file, code) {
    if (mods.has(file)) return mods.get(file).id;
    const rec = { id: mods.size, deps: {}, code: "" };
    mods.set(file, rec);
    const own = file.startsWith(ROOT) && !file.includes("/node_modules/");
    let src = code ?? (own ? await compile(file) : await readFile(file, "utf8"));
    src = src.replace(/process\.env\.NODE_ENV/g, '"production"');
    const req = createRequire(file);
    for (const [, spec] of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      if (Object.hasOwn(rec.deps, spec)) continue;
      let target;
      if (spec.startsWith("@/") || spec.startsWith(".")) {
        target = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : resolve(dirname(file), spec);
        if (!/\.(c|m)?js$/.test(target)) {
          try {
            await readFile(`${target}.js`);
            target = `${target}.js`;
          } catch {
            target = join(target, "index.js");
          }
        }
      } else if (spec.startsWith("node:")) {
        throw new DrillError(`${relative(ROOT, file)} needs ${spec}, which a browser doesn't have`);
      } else target = req.resolve(spec);
      rec.deps[spec] = await add(target);
    }
    rec.code = src;
    return rec.id;
  }
  await add(join(ROOT, "components/admin/editor/fields/__rte-drill-host.js"), entryCode);
  const defs = [...mods.values()].map((m) => `${m.id}:[function(require,module,exports){${m.code}\n},${JSON.stringify(m.deps)}]`).join(",\n");
  return `(function(){var D={${defs}};var C={};function L(id){if(C[id])return C[id].exports;var m={exports:{}};C[id]=m;var d=D[id];d[0](function(s){if(!(s in d[1]))throw new Error("not bundled: "+s);return L(d[1][s]);},m,m.exports);return m.exports;}L(0);})();`;
}

// The host: one rich text field on one page's first section, a Save button
// that saves the body with the field's value and puts the stored value back
// (as the editor's store does when nothing was typed since), and a preview.
const hostCode = (field, api) => `
const React = require("react");
const { createRoot } = require("react-dom/client");
const RichTextField = require(${JSON.stringify(field)}).default;
const api = require(${JSON.stringify(api)});
const h = React.createElement;
const docId = new URLSearchParams(location.search).get("doc");
window.__rte = { changes: [], saves: [], ready: false };
function Host() {
  const [doc, setDoc] = React.useState(null);
  const [value, setValue] = React.useState("");
  const [issues, setIssues] = React.useState([]);
  const [focus, setFocus] = React.useState(null);
  const [status, setStatus] = React.useState("Loading…");
  const live = React.useRef({});
  live.current = { doc, value };
  React.useEffect(() => {
    api.call("getDocument", { id: docId }).then((r) => {
      if (!r.ok) return setStatus(r.message);
      setDoc(r.data.document);
      setValue(r.data.document.body.sections[0].settings.html);
      setStatus("Loaded");
      window.__rte.ready = true;
    });
  }, []);
  window.__rte.focus = (offset) => setFocus({ path: "html", offset });
  window.__rte.value = () => live.current.value;
  window.__rte.save = async () => {
    const { doc: d, value: v } = live.current;
    const body = JSON.parse(JSON.stringify(d.body));
    body.sections[0].settings.html = v;
    const r = await api.call("saveDraft", { id: d.id, body }, { revision: d.revision });
    window.__rte.saves.push({ sent: v, answer: r });
    if (r.ok) {
      setDoc(r.data.document);
      setValue(r.data.document.body.sections[0].settings.html);
      setIssues((r.data.issues || []).filter((i) => i.field === "sections.0.settings.html" || String(i.field || "").endsWith("html")));
      setStatus("Saved");
    } else {
      setIssues(r.issues || []);
      setStatus(r.message || "Not saved");
    }
    return r;
  };
  window.__rte.preview = () => api.startDocumentsPreview({ showDesign: false });
  return h("main", { style: { maxWidth: 760, margin: "32px auto", padding: "0 16px" } },
    h("h1", { className: "mb-4 text-lg font-semibold text-fg" }, "Rich text field (P3-RTE drill host)"),
    h(RichTextField, { id: ${JSON.stringify(FIELD_ID)}, label: "Content", value, onChange: (html) => { window.__rte.changes.push(html); setValue(html); }, issues, focusRequest: focus, placeholder: "Write anything" }),
    h("div", { className: "mt-3 flex items-center gap-3" },
      h("button", { id: "host-save", type: "button", style: { background: "#18181b", color: "#fff", borderRadius: 8, padding: "6px 14px", fontSize: 14 }, onClick: () => window.__rte.save() }, "Save"),
      h("span", { id: "host-status", className: "text-sm text-fg-muted" }, status)));
}
createRoot(document.getElementById("root")).render(h(Host));
`;

// ---------- page helpers ----------

const frameOf = (page) => page.frameLocator(`[id="${FIELD_ID}"] iframe`);
const surface = (page) =>
  page.evaluate((id) => {
    const f = document.querySelector(`[id="${id}"] iframe`);
    const d = f?.contentDocument;
    return { mode: document.querySelector("[data-rich-text]")?.getAttribute("data-rich-text") ?? null, editable: d?.body?.isContentEditable ?? false, html: d?.body?.innerHTML ?? null, cls: d?.body?.className ?? null, srcdoc: d?.URL ?? null };
  }, FIELD_ID);
const waitEditable = (page) => page.waitForFunction((id) => document.querySelector(`[id="${id}"] iframe`)?.contentDocument?.body?.isContentEditable === true, FIELD_ID, { timeout: 30_000 });
const state = (page) => page.evaluate(() => ({ changes: window.__rte.changes.slice(), saves: window.__rte.saves.length, pwned: window.__pwned ?? null }));
const caret = (page) =>
  page.evaluate((id) => {
    const d = document.querySelector(`[id="${id}"] iframe`).contentDocument;
    const s = d.getSelection();
    const n = s.anchorNode;
    const block = n && (n.nodeType === 1 ? n : n.parentElement)?.closest("body > *");
    return { focused: d.hasFocus(), block: block ? [...d.body.children].indexOf(block) : null, offset: s.anchorOffset, text: block?.textContent ?? null, atStart: n === block || (n?.nodeType === 3 && s.anchorOffset === 0 && block?.firstChild === n) };
  }, FIELD_ID);
const docRow = async (id) => (await storeSql("tenant", [{ sql: "SELECT draft, draft_hash, revision FROM documents WHERE id = ?", args: [id] }]))[0].rows[0];
const storedHtmlOf = (row) => JSON.parse(row.draft).sections[0].settings.html;
// the .rte rules as Chrome applies them: the line height against the font
// size, and the space between blocks against the root font size
const rteFacts = (target) =>
  target.evaluate((root) => {
    const cs = getComputedStyle(root);
    const second = root.children[1];
    const rootPx = parseFloat(getComputedStyle(root.ownerDocument.documentElement).fontSize);
    const link = root.querySelector("a");
    return {
      lineHeight: Math.round((parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)) * 100) / 100,
      gap: second ? Math.round((parseFloat(getComputedStyle(second).marginTop) / rootPx) * 100) / 100 : null,
      linkUnderline: link ? getComputedStyle(link).textDecorationLine : null,
      rte: root.classList.contains("rte"),
    };
  });

// true when a <p> opens inside another <p> (the browser would split it)
function nestedParagraph(html) {
  let depth = 0;
  for (const [, close] of html.matchAll(/<(\/?)p(?=[\s>])/gi)) {
    if (close) depth = Math.max(0, depth - 1);
    else if (++depth > 1) return true;
  }
  return false;
}

async function makePage(drill, page, slug, html) {
  const made = await docsApi(page, { createDocument: { type: "page", meta: { slug, title: `RTE drill ${slug}` }, body: null, entityId: null } });
  if (made.status !== 200) throw new DrillError(`createDocument answered ${made.status}: ${JSON.stringify(made.body).slice(0, 300)}`);
  const d = made.body.document;
  const body = { ...d.body, sections: [{ id: "sec_rte1", kind: "rich_text", v: 1, settings: { title: "", html } }] };
  const saved = await docsApi(page, { saveDraft: { id: d.id, body }, revision: d.revision });
  if (saved.status !== 200) throw new DrillError(`saveDraft answered ${saved.status}: ${JSON.stringify(saved.body).slice(0, 300)}`);
  drill.note(`made page ${slug} (${d.id})`);
  return saved.body.document;
}

async function openHost(page, docId) {
  await page.goto(`${HOST}?doc=${encodeURIComponent(docId)}`);
  await page.waitForFunction(() => window.__rte?.ready === true, null, { timeout: 30_000 });
}

// ---------- the drill ----------

process.exitCode = await runDrill({ id: "P3-RTE", part: "rte", title: "P3-RTE — the rich text field" }, async (drill) => {
  await reseed(drill);
  const base = drill.harness.baseUrl;
  const ctx = await drill.context();
  const dialogs = [];
  ctx.on("page", (p) => p.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss().catch(() => {}))));
  const page = await drill.login("owner", { context: ctx });

  // the console's own style sheets and <html> attributes, for the host page
  const look = await page.evaluate(() => ({
    links: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href),
    styles: [...document.querySelectorAll("style")].map((s) => s.textContent),
    htmlClass: document.documentElement.className,
    attrs: [...document.documentElement.attributes].filter((a) => a.name.startsWith("data-")).map((a) => [a.name, a.value]),
  }));
  drill.check(look.links.length + look.styles.length > 0, "the console page has style sheets to give the host", `${look.links.length} links, ${look.styles.length} style tags`);
  const js = await bundle(hostCode(FIELD, API));
  drill.note(`host bundle: ${Math.round(js.length / 1024)} KB`);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const hostHtml = `<!doctype html><html class="${esc(look.htmlClass)}" ${look.attrs.map(([k, v]) => `${k}="${esc(v)}"`).join(" ")}><head><meta charset="utf-8"><title>P3-RTE drill host</title>${look.links.map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join("")}${look.styles.map((s) => `<style>${s}</style>`).join("")}</head><body class="bg-surface-muted"><div id="root"></div><script src="${BUNDLE}"></script></body></html>`;
  await ctx.route(`${base}${HOST}*`, (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: hostHtml }));
  await ctx.route(`${base}${BUNDLE}`, (r) => r.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: js }));
  page.on("pageerror", (e) => drill.note(`page error: ${e.message}`));

  // ---- 1. untouched ----
  const doc = await makePage(drill, page, "rte-drill", START);
  const before = await docRow(doc.id);
  await openHost(page, doc.id);
  await waitEditable(page);
  let s = await surface(page);
  drill.check(s.mode === "edit" && s.editable && s.srcdoc === "about:srcdoc", "the field opens editable, in its sandboxed surface", s);
  drill.check(s.html === storedHtmlOf(before), "the surface holds the stored value exactly", s.html);
  const f = frameOf(page);
  await f.locator("p").nth(1).click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowLeft");
  await page.locator("h1").click();
  let st = await state(page);
  drill.check(st.changes.length === 0, "clicks and arrow keys send nothing (an untouched value is never rewritten)", st.changes);
  await page.locator("#host-save").click();
  await page.waitForFunction(() => window.__rte.saves.length === 1);
  const untouched = await docRow(doc.id);
  drill.check(storedHtmlOf(untouched) === storedHtmlOf(before) && untouched.draft_hash === before.draft_hash, "saving the untouched value stores the same bytes and the same hash", { before: storedHtmlOf(before), after: storedHtmlOf(untouched) });

  // ---- 2. focusRequest ----
  await page.evaluate(() => window.__rte.focus(2));
  await page.waitForTimeout(200);
  const c = await caret(page);
  drill.check(c.focused && c.block === 2 && c.atStart && c.text === "Third paragraph.", "focusRequest offset 2 puts the caret at the start of the third block", c);

  // the shared .rte rules on the editor's surface
  const editorRte = await rteFacts(frameOf(page).locator("body"));
  drill.check(editorRte.rte && editorRte.lineHeight === 1.7 && editorRte.gap === 0.85, "the editor's surface is styled by the .rte rules (line height 1.7, 0.85rem between blocks)", editorRte);
  await drill.screenshot(page, "editor-start-1440");

  // ---- 3. type, bold, link ----
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Fourth paragraph with bold words");
  for (let i = 0; i < "bold words".length; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.locator('[data-rte-button="bold"]').click();
  s = await surface(page);
  drill.check(s.html.includes("<p>Fourth paragraph with <b>bold words</b></p>"), "typing makes a paragraph, and Bold makes <b>", s.html);
  drill.check((await page.locator('[data-rte-button="bold"]').getAttribute("aria-pressed")) === "true", "the Bold button shows it is on");
  await page.keyboard.press("Home");
  for (let i = 0; i < "Fourth".length; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.locator('[data-rte-button="link"]').click();
  await page.locator(`[id="${FIELD_ID}--link"]`).fill("/collections/new");
  await drill.screenshot(page, "editor-link-1440");
  await page.keyboard.press("Enter");
  s = await surface(page);
  drill.check(s.html.includes('<a href="/collections/new">Fourth</a> paragraph with <b>bold words</b>'), "Link makes the selected word a link", s.html);
  st = await state(page);
  drill.check(st.changes.length >= 3 && st.changes[st.changes.length - 1] === s.html, "each change sent the surface's HTML", st.changes.length);

  // ---- 4. paste from Word ----
  await frameOf(page).locator("body").press("ControlOrMeta+End");
  await page.keyboard.press("End");
  const pasted = await page.evaluate(
    ({ id, html, text }) => {
      const d = document.querySelector(`[id="${id}"] iframe`).contentDocument;
      const dt = new DataTransfer();
      dt.setData("text/html", html);
      dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      d.body.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented };
    },
    { id: FIELD_ID, html: WORD_CLIPBOARD, text: WORD_TEXT },
  );
  await page.waitForTimeout(500);
  st = await state(page);
  const sent = st.changes[st.changes.length - 1];
  drill.check(pasted.prevented, "the field takes the paste itself (the browser doesn't insert it)", pasted);
  drill.check(sent.includes("<script>") && sent.includes("class=MsoNormal") && sent.includes("style='color:red'") && sent.includes("Spring sizes") && !sent.includes("ProgId"), "the field sends the copied part as it was copied (the client cleans nothing)", sent.slice(0, 300));
  drill.check(st.pwned === null && dialogs.length === 0, "nothing in the paste ran (no script, no ontoggle or onclick, no dialog)", { pwned: st.pwned, dialogs });
  await frameOf(page).locator("text=Free returns").click();
  await page.waitForTimeout(200);
  drill.check((await state(page)).pwned === null, "clicking the pasted onclick text runs nothing");
  await drill.screenshot(page, "editor-pasted-1440");
  await page.locator("#host-save").click();
  await page.waitForFunction(() => window.__rte.saves.length === 2);
  const saved = await page.evaluate(() => window.__rte.saves[1].answer);
  drill.check(saved.ok === true, "the save is accepted", saved.message || saved.code);
  const row = await docRow(doc.id);
  const stored = storedHtmlOf(row);
  const bad = ["<script", "__pwned", "alert", "style=", "class=", "onclick", "ontoggle", "<details", "o:p", "mso", "<!--", "<![if"].filter((x) => stored.includes(x));
  drill.check(bad.length === 0, "the stored value is cleaned: no script, handler, style, class or Word markup", { bad, stored });
  const words = ["First paragraph.", "Third paragraph.", "Spring sizes", "run small.", "Order one size up", "Free returns", "within 30 days.", "Ask us anything."].filter((w) => !stored.includes(w));
  drill.check(words.length === 0, "the stored value keeps every word", words);
  drill.check(stored.includes('<a href="/collections/new">Fourth</a> paragraph with <b>bold words</b>') && stored.includes("<b><span>Spring sizes</span></b>"), "the stored value keeps the bold and the link", stored);
  drill.check(!nestedParagraph(stored), "the pasted paragraphs are not inside another paragraph", stored);
  await page.waitForTimeout(300);
  s = await surface(page);
  drill.check(s.mode === "edit" && !s.html.includes("MsoNormal") && !s.html.includes("style=") && !s.html.includes("<script"), "after the save the field shows the stored value", s.html.slice(0, 300));
  drill.note(`stored after the paste: ${stored}`);
  await drill.screenshot(page, "editor-saved-1440");

  // ---- 5. preview ----
  const pv = await page.evaluate(() => window.__rte.preview());
  drill.check(pv.ok === true, "a preview session starts", pv.message || pv.code);
  const shop = await ctx.newPage();
  const res = await shop.goto(`${base}/policies/rte-drill`, { waitUntil: "load", timeout: 120_000 });
  drill.check(res?.status() === 200, "the page opens in the preview", res?.status());
  const shown = shop.locator(".rte").filter({ hasText: "Spring sizes" }).first();
  drill.check((await shown.count()) === 1, "the preview shows the saved text in a .rte block");
  if ((await shown.count()) === 1) {
    const inner = await shown.evaluate((e) => e.innerHTML);
    drill.check(inner.includes('<a href="/collections/new">Fourth</a>') && inner.includes("<b>bold words</b>") && !inner.includes("script"), "the preview has the bold, the link and no script", inner.slice(0, 300));
    const shopRte = await rteFacts(shown);
    drill.check(shopRte.lineHeight === editorRte.lineHeight && shopRte.gap === editorRte.gap && shopRte.linkUnderline === "underline", "the storefront's rich text has the same .rte rules as the editor's surface", { editor: editorRte, storefront: shopRte });
    await shown.scrollIntoViewIfNeeded();
  }
  drill.check((await shop.evaluate(() => window.__pwned ?? null)) === null, "nothing ran on the storefront");
  await drill.screenshot(shop, "preview-1440");
  await shop.close();

  // ---- 6. a table: read-only, Edit as HTML ----
  const tdoc = await makePage(drill, page, "rte-table", TABLE);
  await openHost(page, tdoc.id);
  await page.waitForFunction(() => document.querySelector("[data-rich-text]")?.getAttribute("data-rich-text") === "view");
  await page.waitForTimeout(500);
  s = await surface(page);
  const editBtn = page.getByRole("button", { name: "Edit as HTML", exact: true });
  drill.check(s.mode === "view" && !s.editable && (await editBtn.count()) === 1 && (await page.locator('[role="toolbar"]').count()) === 0, "a value with a table opens read-only with Edit as HTML", s);
  const fits = await page.evaluate((id) => {
    const f = document.querySelector(`[id="${id}"] iframe`);
    return { frame: f.getBoundingClientRect().height, content: f.contentDocument.documentElement.scrollHeight };
  }, FIELD_ID);
  drill.check(Math.abs(fits.frame - fits.content) <= 2, "the read-only surface is as tall as its content (the whole table shows)", fits);
  drill.check((await page.getByText("This text has a table, which this editor can't change. Use Edit as HTML to change it.").count()) === 1, "it says why, in plain words");
  await drill.screenshot(page, "table-readonly-1440");
  await editBtn.click();
  const box = page.locator(`textarea[id="${FIELD_ID}"]`);
  drill.check((await box.count()) === 1 && (await box.inputValue()) === storedHtmlOf(await docRow(tdoc.id)), "Edit as HTML shows the stored HTML in a plain text box");
  const typed = TABLE.replace("<td>96 cm</td>", "<td>98 cm</td></tr><tr><th>L</th><td onmouseover=\"window.__pwned='x'\" style=\"color:red\">104 cm<script>window.__pwned='y'</script></td>");
  await box.fill(typed);
  st = await state(page);
  drill.check(st.changes[st.changes.length - 1] === typed, "the text box sends exactly what was typed");
  await page.locator("#host-save").click();
  await page.waitForFunction(() => window.__rte.saves.length === 1);
  const tstored = storedHtmlOf(await docRow(tdoc.id));
  drill.check(tstored.includes("<td>98 cm</td>") && tstored.includes("<th>L</th><td>104 cm</td>") && !/script|onmouseover|style=|__pwned/.test(tstored), "editing as HTML stores the cleaned result", tstored);
  drill.check((await box.inputValue()) === tstored, "the text box then shows the stored value", await box.inputValue());
  await page.getByRole("button", { name: "Show formatted", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-rich-text]")?.getAttribute("data-rich-text") === "view");
  await page.waitForTimeout(300);
  s = await surface(page);
  drill.check(s.html === tstored && (await state(page)).pwned === null, "Show formatted shows the stored table read-only again", s.html);
  await drill.screenshot(page, "table-saved-1440");
});
