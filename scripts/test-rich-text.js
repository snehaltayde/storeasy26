// P3-RTE suite (AU-01, ED-04): the rich text field.
//   components/admin/editor/fields/RichTextField.js   (the editor, Option B:
//     the browser's own editing in an iframe sandboxed without scripts)
//   components/admin/editor/fields/richTextModel.js   (its pure logic)
//   lib/documents/service.js saveDraft                (the only cleaner)
//
//   1. unit: the editor's tags are exactly the tags the server keeps; every
//      button makes a kept tag.
//   2. unit: an untouched value round-trips byte for byte (the field keeps an
//      echo or a shown value, the surface holds the value exactly, rendering
//      calls onChange zero times, and saveDraft of a stored value stores the
//      same bytes and the same hash).
//   3. unit: a pasted Word fragment with a script and inline styles goes out
//      from the field as it was copied and is stored cleaned by saveDraft.
//   4. unit (grep): no client module calls a sanitizer.
//   5. unit: focusRequest offset 2 targets the third block child; the caret
//      keeps its place in the text when the stored value replaces the shown.
//   6. rendered (SSR): a table opens read-only with "Edit as HTML", and what
//      is typed there is stored cleaned; the editor and the storefront's rich
//      text both use the .rte stylesheet.
// Next's SWC and react-dom/server, a local libsql file. No server.
//   pnpm test:rich-text
import { readFile, readdir, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const started = Date.now();
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-rich-text-default.db";
process.env.PLATFORM_DB_URL = "file:.test-rich-text-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
const DBS = [".test-rich-text-default.db", ".test-rich-text-platform.db", ".test-rich-text-docs.db"];
const cleanup = async () => {
  for (const f of DBS) await rm(join(ROOT, f), { force: true });
};
await cleanup();

const M = await import("../components/admin/editor/fields/richTextModel.js");
const { sanitizeHtml } = await import("../lib/sanitize.js");
const R = await import("../lib/registry/index.js");

let pass = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(e.stack || e.message).split("\n").slice(0, 6).join("\n       ")}`);
  }
}
const ok = (c, m) => {
  if (!c) throw new Error(m);
};
const eq = (a, b, m) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n       expected ${y}\n       got      ${x}`);
};

// ---- the JSX loader (Next's SWC, as test-editor-inspector does) ---------------------
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const exists = (f) => readFile(f).then(
  () => true,
  () => false,
);
const isJsx = (file) => /^components\//.test(relative(ROOT, file));
const seen = new Map();
async function loadJsx(file) {
  if (seen.has(file)) return seen.get(file);
  const mod = { exports: {} };
  seen.set(file, mod.exports);
  const code = await compile(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (deps.has(id) || id === "react" || id === "react/jsx-runtime") continue;
    if (id.startsWith("@/") || id.startsWith(".")) {
      let target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(file), id);
      if (!target.endsWith(".js")) target = (await exists(`${target}.js`)) ? `${target}.js` : join(target, "index.js");
      deps.set(id, isJsx(target) ? await loadJsx(target) : await import(pathToFileURL(target).href));
    } else deps.set(id, require(id));
  }
  const req = (id) => {
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return require("react/jsx-runtime");
    if (deps.has(id)) return deps.get(id);
    throw new Error(`unresolved import "${id}" in ${relative(ROOT, file)}`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  return mod.exports;
}
const FIELDS = join(ROOT, "components/admin/editor/fields");
const RTF = await loadJsx(join(FIELDS, "RichTextField.js"));
const RichTextField = RTF.default;
const h = React.createElement;
const render = (el) => renderToStaticMarkup(el);
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// the srcdoc of the field's surface, as the browser would read it
const srcdocOf = (markup) => {
  const m = /srcDoc="([^"]*)"|srcdoc="([^"]*)"/.exec(markup);
  return m ? unescape(m[1] ?? m[2]) : null;
};
const bodyOf = (doc) => {
  const open = /<body\b[^>]*>/.exec(doc);
  return doc.slice(open.index + open[0].length, doc.lastIndexOf("</body>"));
};
const bodyTagOf = (doc) => /<body\b[^>]*>/.exec(doc)[0];

// ---- a documents-mode store on a local file ------------------------------------------
const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const Docs = await import("../lib/documents/service.js");
await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
const raw = createClient({ url: "file:.test-rich-text-docs.db" });
await raw.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
await runMigrations(raw, await loadMigrations("tenant"));
await raw.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await C.upsertTenant({ id: "zr", name: "Rich text", domains: ["zr.test"], dbUrl: "file:.test-rich-text-docs.db", config: {}, secrets: {} });
const TEN = await C.getTenant("zr");
const inT = (fn) => withTenant(TEN, fn);
const ACTOR = { kind: "merchant", id: "u_rte", role: "owner" };

const pageBody = (html, slug = "rte-test") => {
  const b = R.emptyBody("page");
  return { ...b, meta: { ...b.meta, slug, title: "Rich text test" }, sections: [{ id: "sec_rte1", kind: "rich_text", v: 1, settings: { title: "", html } }] };
};
const storedHtml = async (id) => (await inT(() => Docs.getDocument(id))).body.sections[0].settings.html;
let slugN = 0;
// a fresh page holding `html`, saved once through saveDraft; returns { id, revision }
async function freshPage(html) {
  const made = await inT(() => Docs.createDocument({ type: "page", meta: { slug: `rte-${++slugN}`, title: "Rich text test" }, body: null, actor: ACTOR }));
  const d = made.document;
  const saved = await inT(() => Docs.saveDraft({ id: d.id, revision: d.revision, body: pageBody(html, d.slug), actor: ACTOR }));
  return { id: d.id, revision: saved.document.revision, slug: d.slug, draftHash: saved.document.draftHash, html: saved.document.body.sections[0].settings.html };
}
const saveHtml = (p, html) => inT(() => Docs.saveDraft({ id: p.id, revision: p.revision, body: pageBody(html, p.slug), actor: ACTOR }));

// What Word puts on the clipboard (Word 16, Windows and Mac): a whole document,
// Word's style sheet in the head, the copied part between the fragment
// comments, conditional comments for list bullets, classes and inline styles
// on everything, <o:p>. A script and an onclick are added, as a hostile page
// could put them on the clipboard.
const WORD_CLIPBOARD = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><meta name=ProgId content=Word.Document><meta name=Generator content="Microsoft Word 15">
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]-->
<style><!-- p.MsoNormal {margin:0cm; font-size:12.0pt; font-family:"Calibri",sans-serif;} --></style>
</head>
<body lang=EN-IN style='tab-interval:36.0pt'>
<!--StartFragment--><p class=MsoNormal style='margin-bottom:8.0pt;line-height:107%'><b><span style='font-size:14.0pt;mso-bidi-font-size:11.0pt;color:#C00000'>Spring sizes</span></b><span style='mso-spacerun:yes'> </span>run small.<o:p></o:p></p>
<p class=MsoListParagraphCxSpFirst style='text-indent:-18.0pt;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><![endif]>Order one size up<o:p></o:p></p>
<script>alert('pasted')</script>
<p class=MsoNormal><span style='color:red' onclick="alert(2)">Free returns</span> within 30 days.<o:p></o:p></p><!--EndFragment-->
</body></html>`;

// =============================== 1. tags ============================================
console.log("1. the editor's tags are exactly the tags the server keeps");

// Every tag name the HTML standard knows, plus Word's and a few made up.
const ALL_TAGS = "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track u ul var video wbr font center marquee o:p st1:place founder".split(" ");
const kept = (tag) => sanitizeHtml(`<${tag}>x</${tag}>`).startsWith(`<${tag}`);

await t("unit: marks, blocks and the read-only tags together are exactly what lib/sanitize.js keeps", () => {
  const server = ALL_TAGS.filter(kept).sort();
  const editor = [...M.MARKS, ...M.BLOCKS, ...M.NOT_EDITABLE].sort();
  eq(editor, server, "the editor's tag lists and the server's allowlist differ");
  const all = [...M.MARKS, ...M.BLOCKS, ...M.NOT_EDITABLE];
  eq(all.length, new Set(all).size, "a tag is in two lists");
});

await t("unit: every button makes a tag the server keeps unchanged (the browser's own command output)", () => {
  // what Chrome's editing commands write (styleWithCSS off): checked in the drill too
  const OUT = { bold: "<p><b>x</b></p>", italic: "<p><i>x</i></p>", underline: "<p><u>x</u></p>", p: "<p>x</p>", h2: "<h2>x</h2>", h3: "<h3>x</h3>", ul: "<ul><li>x</li></ul>", ol: "<ol><li>x</li></ol>", quote: "<blockquote>x</blockquote>", link: '<p><a href="/collections/new">x</a></p>', unlink: "<p>x</p>" };
  for (const b of M.TOOLBAR) {
    ok(Object.hasOwn(OUT, b.id), `no expected output for the ${b.label} button`);
    eq(sanitizeHtml(OUT[b.id]), OUT[b.id], `the server changes what ${b.label} makes`);
    if (b.tag) ok([...M.MARKS, ...M.BLOCKS].includes(b.tag) && kept(b.tag), `${b.label} makes <${b.tag}>, which the editor or the server doesn't keep`);
  }
  eq(sanitizeHtml(M.linkHtml('/a"b?x=<1>', "")), M.linkHtml('/a"b?x=<1>', ""), "a link typed at a caret is kept as it is");
});

await t("unit: a value with a table, a picture, a caption or preformatted text is read-only, in plain words", () => {
  eq(M.uneditableTags("<p>Hi</p><table><tbody><tr><td>1</td></tr></tbody></table><img src=/a.png>"), ["table", "tbody", "tr", "td", "img"], "tags found in order");
  eq(M.uneditableTags("<p>pretty</p><p>tablet</p><!-- <table> -->"), [], "words and comments are not tags");
  eq(M.readOnlyWords(["table", "td"]), "This text has a table, which this editor can't change. Use Edit as HTML to change it.", "one thing");
  eq(M.readOnlyWords(["pre", "img", "figure"]), "This text has preformatted text, a picture and a picture with a caption, which this editor can't change. Use Edit as HTML to change it.", "three things");
  eq(M.readOnlyWords([]), null, "nothing");
});

// =============================== 2. round trip ======================================
console.log("2. an untouched value round-trips byte for byte");

// Values as the server stores them: entities, <br />, attributes, rel words,
// characters some scripts need, an ordered list's start, a long line.
const STORED = [
  "",
  "<p>Hello &amp; welcome</p>",
  "<p>Line one<br />line two</p><h2>Sizes</h2><ul><li>S</li><li>M</li></ul>",
  '<p><a href="https://example.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">out</a> and <a href="/collections/new">in</a></p>',
  '<ol start="3"><li>three</li></ol><blockquote><p>quoted</p></blockquote><hr />',
  "<p>नमस्ते‍ 👩‍👩‍👧 café &lt;500 &nbsp; ok</p>",
  "plain words with no tags",
  "\n  <p>spaces and a line break around it</p>\n",
  "<p><b>bold</b> <strong>strong</strong> <i>i</i> <em>em</em> <u>u</u> <s>s</s> <small>small</small> <sub>sub</sub> <sup>sup</sup> <code>code</code> <span>span</span></p>",
];

await t("unit: the field keeps its own echo and a value it already shows; anything else replaces", () => {
  eq(M.syncAction({ value: "<p>a</p>", emitted: "<p>a</p>", shown: "<p>a</p><p>b</p>" }), "keep", "its own echo");
  eq(M.syncAction({ value: "<p>a</p>", emitted: null, shown: "<p>a</p>" }), "keep", "already shown");
  eq(M.syncAction({ value: "<p>a<br /></p>", emitted: "<p>a<br></p>", shown: "<p>a<br></p>", normalized: "<p>a<br></p>" }), "keep", "the same once parsed");
  eq(M.syncAction({ value: "<p>clean</p>", emitted: "<p style=x>clean</p>", shown: "<p style=x>clean</p>", normalized: "<p>clean</p>" }), "replace", "the stored value after a cleaned paste");
  eq(M.syncAction({ value: "<p>other tab</p>", emitted: null, shown: "<p>mine</p>" }), "replace", "a value from elsewhere");
});

await t("unit+rendered: the surface holds each stored value exactly, and rendering sends nothing", () => {
  for (const v of STORED) {
    eq(bodyOf(M.frameDocument(v, { label: "Content" })), v, "frameDocument");
    let calls = 0;
    const markup = render(h(RichTextField, { id: "f-sec_rte1-html", label: "Content", value: v, onChange: () => calls++, issues: [] }));
    eq(bodyOf(srcdocOf(markup)), v, "the rendered surface");
    eq(calls, 0, "onChange during render");
  }
});

await t("unit: saveDraft of an untouched stored value stores the same bytes and the same hash", async () => {
  // what Chrome writes after typing (innerHTML), and the stored values above
  const typed = ["<p>Hi<br></p>", "<p><b>Bold</b> and <a href=\"/x\">a link</a></p><p><br></p>", "<h2>Head</h2><ul><li>one</li></ul>", "<p>a&nbsp;b</p>"];
  for (const v of [...STORED.filter(Boolean), ...typed]) {
    const p = await freshPage(v);
    const again = await saveHtml(p, p.html); // the field sent nothing new: the store resends what it holds
    eq(again.document.body.sections[0].settings.html, p.html, `the stored bytes changed for ${JSON.stringify(v)}`);
    eq(again.document.draftHash, p.draftHash, "the hash changed");
    eq(await storedHtml(p.id), p.html, "the stored row");
  }
});

// =============================== 3. paste ===========================================
console.log("3. a Word paste goes out as copied and is stored cleaned by saveDraft");

await t("unit: the field sends the Word fragment as copied, and saveDraft stores it cleaned", async () => {
  const part = M.pastedPart(WORD_CLIPBOARD);
  ok(part.startsWith("<p class=MsoNormal") && part.endsWith("<o:p></o:p></p>"), "the copied part is the fragment");
  ok(!part.includes("<style>") && !part.includes("ProgId"), "Word's head is not part of what was copied");
  // the caret in "Intro |" inside a paragraph: the field splits it
  const marker = M.newMarker(() => 0.5);
  const shown = `<p>Intro ${marker}</p><p>After</p>`;
  const sent = M.splicePaste(shown, marker, part, { open: "<p>", close: "</p>" });
  ok(sent.startsWith("<p>Intro </p><p class=MsoNormal"), `the paragraph is split at the caret: ${sent.slice(0, 40)}`);
  ok(sent.includes("<script>alert('pasted')</script>") && sent.includes("style='color:red'") && sent.includes('onclick="alert(2)"') && sent.includes("class=MsoNormal"), "the field sent the paste as copied (the client cleans nothing)");
  const p = await freshPage("<p>Intro</p>");
  const saved = await saveHtml(p, sent);
  const stored = saved.document.body.sections[0].settings.html;
  eq(stored, sanitizeHtml(sent), "the server's own cleaner made the stored value");
  for (const bad of ["<script", "alert", "style=", "class=", "onclick", "o:p", "mso", "<![if", "<!--"]) ok(!stored.includes(bad), `"${bad}" is stored: ${stored}`);
  for (const words of ["Intro", "Spring sizes", "run small.", "Order one size up", "Free returns", "within 30 days.", "After"]) ok(stored.includes(words), `"${words}" was lost: ${stored}`);
  ok(stored.includes("<b><span>Spring sizes</span></b>"), "the bold is kept");
  eq(await storedHtml(p.id), stored, "the stored row");
  eq(saved.issues.filter((i) => i.cls === "structure"), [], "no refusal");
});

await t("unit: a paste's helpers change nothing they don't have to", () => {
  eq(M.pastedPart("<b>bare</b>"), "<b>bare</b>", "no document around it");
  eq(M.pastedPart("<html><body class=x><p>in body</p></body></html>"), "<p>in body</p>", "a body without fragment comments");
  eq(M.plainToHtml("orders <500 & more"), "orders &lt;500 &amp; more", "plain text keeps its characters as words");
  eq(M.plainToHtml("one\ntwo\n\nthree"), "<p>one<br>two</p><p>three</p>", "lines and paragraphs");
  const mk = "⁣m⁣";
  eq(M.splicePaste(`<p>${mk}After</p>`, mk, "<p>X</p>", { open: "<p>", close: "</p>" }), "<p>X</p><p>After</p>", "an empty half before is dropped");
  eq(M.splicePaste(`<p>Before${mk}</p>`, mk, "<p>X</p>", { open: "<p>", close: "</p>" }), "<p>Before</p><p>X</p>", "an empty half after is dropped");
  eq(M.splicePaste(`<p>a${mk}b</p>`, mk, "<b>X</b>", {}), "<p>a<b>X</b>b</p>", "inline text goes in place");
  ok(M.hasBlocks("<p>x</p>") && !M.hasBlocks("<b>x</b><!-- <p> -->"), "blocks");
});

// =============================== 4. grep ============================================
console.log("4. no client module calls a sanitizer");

async function walkJs(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkJs(p, out);
    else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const SANITIZER_IMPORT = /from\s+["'][^"']*(lib\/sanitize|registry\/text|dompurify|sanitize-html)[^"']*["']|require\(\s*["'][^"']*(lib\/sanitize|registry\/text|dompurify|sanitize-html)/i;
const SANITIZER_CALL = /\b(sanitize|sanitizeHtml|lostBySanitizing|DOMPurify)\s*\(|\bimport\s*\{[^}]*\bsanitize\w*\b[^}]*\}/;

await t("unit (grep): no editor module and no client component imports or calls a sanitizer", async () => {
  const editor = await walkJs(join(ROOT, "components/admin/editor"));
  ok(editor.some((f) => f.endsWith("RichTextField.js")) && editor.some((f) => f.endsWith("richTextModel.js")), "the field's files are missing");
  const client = [];
  for (const f of await walkJs(join(ROOT, "components"))) {
    const src = await readFile(f, "utf8");
    if (editor.includes(f) || /^\s*["']use client["']/.test(src)) client.push([f, src]);
  }
  ok(client.length > 20, `only ${client.length} client modules found`);
  const hits = [];
  for (const [f, src] of client) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    if (SANITIZER_IMPORT.test(code) || SANITIZER_CALL.test(code)) hits.push(relative(ROOT, f));
  }
  eq(hits, [], "client modules that clean HTML");
  const model = await readFile(join(FIELDS, "richTextModel.js"), "utf8");
  ok(!/^\s*import\s/m.test(model), "richTextModel.js imports nothing");
  // the check bites: a planted call is found
  ok(SANITIZER_CALL.test("x = sanitizeHtml(v)") && SANITIZER_IMPORT.test('import { sanitize } from "../../../../lib/registry/text.js"'), "the grep finds a planted call");
});

// =============================== 5. focus and caret ===================================
console.log("5. focusRequest and the caret");

// a tiny DOM: elements and text nodes with parentNode links
const el = (tag, ...children) => {
  const n = { nodeType: 1, localName: tag, childNodes: [], parentNode: null };
  for (const c of children) {
    const k = typeof c === "string" ? { nodeType: 3, nodeValue: c, childNodes: [], parentNode: null } : c;
    k.parentNode = n;
    n.childNodes.push(k);
  }
  return n;
};
const comment = (v) => ({ nodeType: 8, nodeValue: v, childNodes: [], parentNode: null });

await t("unit: focusRequest offset 2 targets the third block child", () => {
  const blocks = [el("p", "One"), el("h2", "Two ", el("em", "a")), el("ul", el("li", "x")), el("p", "Four", el("br"), "line")];
  const root = el("body", "\n  ", blocks[0], "\n", comment(" note "), blocks[1], "  ", blocks[2], "\n", blocks[3]);
  const at = M.blockChildAt(root, 2);
  ok(at && at.node === blocks[2] && at.index === 2 && !at.atEnd, "offset 2 is the <ul>, the third block child (text and comments between blocks don't count)");
  eq(M.blockChildAt(root, 0).node.localName, "p", "offset 0");
  ok(M.blockChildAt(root, 3).node === blocks[3], "a <br> inside a block doesn't count");
  const past = M.blockChildAt(root, 9);
  ok(past.node === blocks[3] && past.atEnd, "past the end: the end of the last block");
  eq(M.blockChildAt(root, undefined), null, "no offset leaves the caret alone");
  eq(M.blockChildAt(root, -1), null, "a negative offset");
  eq(M.blockChildAt(el("body", "only text"), 0), null, "no blocks");
});

await t("unit: the caret keeps its place in the text across a replace", () => {
  const t1 = el("b", "Spring");
  const root = el("body", el("p", "Intro "), el("p", t1, " sizes"));
  eq(M.textOffset(root, t1.childNodes[0], 3), 9, "inside the bold word");
  eq(M.textOffset(root, root.childNodes[1], 1), 12, "an element and a child index");
  eq(M.textOffset(root, root, 2), 18, "the end");
  // the stored value has the same text in another shape
  const after = el("body", el("p", "Intro "), el("p", el("b", el("span", "Spring")), " sizes"));
  const p = M.pointAt(after, 9);
  eq([p.node.nodeValue, p.offset], ["Spring", 3], "the same place in the new tree");
  const end = M.pointAt(after, 99);
  eq([end.node.nodeValue, end.offset], [" sizes", 6], "past the end");
});

// =============================== 6. rendered ========================================
console.log("6. rendered: read-only with Edit as HTML, and the shared .rte stylesheet");

const TABLE = "<p>Sizes:</p><table><tbody><tr><th>Size</th><td>Chest</td></tr><tr><th>M</th><td>96 cm</td></tr></tbody></table>";

await t("rendered: content with a table opens read-only with 'Edit as HTML', no toolbar and no editing", () => {
  const markup = render(h(RichTextField, { id: "f-sec_rte1-html", label: "Content", value: TABLE, onChange: () => {}, issues: [] }));
  ok(markup.includes('data-rich-text="view"'), "the field is in its read-only view");
  ok(/<button[^>]*data-rte-edit-html[^>]*>Edit as HTML<\/button>/.test(markup), "the Edit as HTML button");
  ok(markup.includes("This text has a table, which this editor can&#x27;t change. Use Edit as HTML to change it."), "the reason, in plain words");
  ok(!markup.includes('role="toolbar"'), "no formatting buttons");
  const doc = srcdocOf(markup);
  eq(bodyOf(doc), TABLE, "the table is shown as stored");
  ok(/aria-readonly="true"/.test(bodyTagOf(doc)) && !/contenteditable/i.test(doc), "the surface is read-only");
  ok(/sandbox="allow-same-origin"/.test(markup) && !/allow-scripts/.test(markup), "the surface runs no scripts");
  const box = /<div[^>]*id="f-sec_rte1-html"[^>]*>/.exec(markup)[0];
  ok(/aria-describedby="f-sec_rte1-html--readonly"/.test(box) && /aria-readonly="true"/.test(box), "the field names its reason and says it is read-only");
  // an editable value has the toolbar and no Edit as HTML
  const plain = render(h(RichTextField, { id: "f-x", label: "Content", value: "<p>Hi</p>", onChange: () => {}, issues: [] }));
  ok(plain.includes('data-rich-text="edit"') && plain.includes('role="toolbar"') && !plain.includes("Edit as HTML"), "editable");
  for (const b of M.TOOLBAR) ok(plain.includes(`data-rte-button="${b.id}"`), `no ${b.label} button`);
  // readOnlyReason (no permission): read-only, the reason, and no Edit as HTML
  const locked = render(h(RichTextField, { id: "f-y", label: "Content", value: TABLE, onChange: () => {}, issues: [], readOnlyReason: "Only the store owner can change this." }));
  ok(locked.includes('data-rich-text="locked"') && locked.includes("Only the store owner can change this.") && !locked.includes("Edit as HTML") && !locked.includes('role="toolbar"'), "locked");
});

// Drive the real HtmlSource: a host calls it as a plain function, and the tree
// it returns is searched for the text box's onChange (as test-editor-inspector
// drives LinkControl).
function findProps(node, pred) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findProps(n, pred);
      if (f) return f;
    }
    return null;
  }
  if (node.props && pred(node)) return node.props;
  return findProps(node.props?.children, pred);
}

await t("rendered+driven: editing the table as HTML sends what was typed, and saveDraft stores it cleaned", async () => {
  const sent = [];
  let tree = null;
  const Host = () => {
    tree = RTF.HtmlSource({ id: "f-sec_rte1-html", value: TABLE, label: "Content", onChange: (v) => sent.push(v), onDone: () => {} });
    return tree;
  };
  const markup = render(h(Host));
  ok(/<textarea[^>]*id="f-sec_rte1-html"/.test(markup) && unescape(markup).includes(TABLE), "the stored HTML is in a plain text box");
  ok(markup.includes("Show formatted"), "a way back");
  const box = findProps(tree, (n) => n.type === "textarea");
  const typed = `<p>Sizes:</p><table onmouseover="alert(1)"><tbody><tr><th style="color:red">Size</th><td>Chest</td></tr><tr><th>L</th><td>104 cm<script>steal()</script></td></tr></tbody></table>\n`;
  box.onChange({ target: { value: typed } });
  eq(sent, [typed], "the text box sends exactly what was typed");
  const p = await freshPage(TABLE);
  const saved = await saveHtml(p, typed);
  const stored = await storedHtml(p.id);
  eq(saved.document.body.sections[0].settings.html, stored, "the answer holds the stored value");
  eq(stored, sanitizeHtml(typed), "stored by the server's cleaner");
  for (const bad of ["onmouseover", "style=", "<script", "steal"]) ok(!stored.includes(bad), `"${bad}" is stored: ${stored}`);
  ok(stored.includes("<td>104 cm</td>") && stored.includes("<th>L</th>"), "the edit is stored");
  // a video the page can't show is refused in plain words, never stored less (AU-05)
  const before = await raw.execute({ sql: "SELECT draft, revision FROM documents WHERE id = ?", args: [p.id] });
  const refused = await saveHtml({ ...p, revision: saved.document.revision }, `${typed}<iframe src="https://video.example/x"></iframe>`).then(
    () => null,
    (e) => e,
  );
  ok(refused?.issues?.some((i) => i.code === "MEDIA_LOST" && /can't show embedded videos/.test(i.message)), `a refusal with plain words: ${refused?.message}`);
  const after = await raw.execute({ sql: "SELECT draft, revision FROM documents WHERE id = ?", args: [p.id] });
  eq(after.rows[0], before.rows[0], "the refused save changed nothing");
  // the field shows the stored value, still read-only (it still has a table)
  const back = render(h(RichTextField, { id: "f-sec_rte1-html", label: "Content", value: stored, onChange: () => {}, issues: [] }));
  ok(back.includes('data-rich-text="view"') && bodyOf(srcdocOf(back)) === stored, "the stored value is shown read-only");
});

// P3-FIX4 (owner default, option b): a paste from a web page with its own
// elements (every Shopify theme has them, with or without attributes) or a
// <noscript> is cleaned on save, not refused: the elements are unwrapped and
// their children kept, and a <noscript> goes with its content (no browser that
// opens the store shows it). These are the RTE reviewer's pastes.
const WEB_PASTES = [
  [
    `<p>Our story.</p><div class="product__description rte"><p>Made from <strong>organic cotton</strong>.</p></div><product-info id="ProductInfo-1" data-section="main"><p>Ships in 2 days.</p></product-info>`,
    `<p>Our story.</p><div><p>Made from <strong>organic cotton</strong>.</p></div><p>Ships in 2 days.</p>`,
    ["Made from", "organic cotton", "Ships in 2 days."],
  ],
  [`<p>Our story.</p><p>Updated <relative-time datetime="2026-10-01T10:00:00Z">last month</relative-time>.</p>`, `<p>Our story.</p><p>Updated last month.</p>`, ["Updated last month."]],
  [`<p>Our story.</p><p>Hello</p><noscript><p>Turn on JavaScript.</p></noscript>`, `<p>Our story.</p><p>Hello</p>`, ["Hello"]],
  // the RTE reviewer's probe: no attributes; and each tag left alone after the other was removed
  [`<p>Our story.</p><product-info><p>Ships</p></product-info>`, `<p>Our story.</p><p>Ships</p>`, ["Ships"]],
  [`<p>Our story.</p><p>Ships</p></product-info>`, `<p>Our story.</p><p>Ships</p>`, ["Ships"]],
  [`<p>Our story.</p><product-info id="x"><p>Ships</p>`, `<p>Our story.</p><p>Ships</p>`, ["Ships"]],
  [`<p>Our story.</p><cart-drawer class="drawer" defer-hydration hidden><p>Your cart</p></cart-drawer>`, `<p>Our story.</p><p>Your cart</p>`, ["Your cart"]],
];

await t("P3-FIX4 unit: the reviewer's custom-element and <noscript> web pastes are saved cleaned, with their visible text", async () => {
  for (const [pasted, cleaned, words] of WEB_PASTES) {
    eq(R.lostBySanitizing(pasted, R.sanitize(pasted)), null, `the cleaner refuses ${pasted}`);
    const p = await freshPage("<p>Our story.</p>");
    const saved = await saveHtml(p, pasted);
    ok(saved.document.revision > p.revision, `not saved: ${pasted}`);
    const stored = await storedHtml(p.id);
    eq(stored, cleaned, `stored cleaned (${pasted})`);
    eq(stored, sanitizeHtml(pasted), "stored as the sanitizer cleans it");
    for (const w of words) ok(stored.includes(w), `the visible words "${w}" are kept: ${stored}`);
    ok(!/product-info|relative-time|cart-drawer|noscript|JavaScript|datetime|data-section/.test(stored), `hidden markup stored: ${stored}`);
  }
});

// Real text loss is still refused (AU-05), and the words name the tag instead
// of blaming < or > signs; stray signs still get the old words.
const STILL_REFUSED = [
  // a name with no hyphen is somebody's word, not a web page's element
  [`<p>Our story.</p><shop class="x"><p>Ships in 2 days.</p></shop>`, "shop"],
  ["Ask for the <founder> today.", "founder"],
  ["Click the <link> below.", "link"],
  // a lone opening tag with nothing closing it, and no attributes, is still words
  [`<p>Our story.</p><product-info><p>Ships</p>`, "product-info"],
  // an attribute with no value that reads as a word
  ["<sale-ends soon>Friday</sale-ends>", "sale-ends"],
  // the noscript rule is for a whole element: a lone one is words
  ["<p>Hi</p><noscript>Our founder's note", "noscript"],
];

await t("P3-FIX4 unit: real text loss is still refused, and the refusal words name the tag and Edit as HTML", async () => {
  for (const [typed, tag] of STILL_REFUSED) {
    const lost = R.lostBySanitizing(typed, R.sanitize(typed));
    eq(lost?.code, "WORDS_LOST", `refused: ${typed}`);
    ok(lost.message.includes(`<${tag}> tag`) && lost.message.includes("Edit as HTML"), `names <${tag}> and Edit as HTML: ${lost.message}`);
    ok(!lost.message.includes("< or > signs"), `blames < or > signs: ${lost.message}`);
  }
  for (const typed of ["Free on orders <500 and >100 rupees.", "Write to Priya <priya@store.com> any day.", "Call <tel:9876543210> now."]) {
    const lost = R.lostBySanitizing(typed, R.sanitize(typed));
    eq(lost?.code, "WORDS_LOST", `refused: ${typed}`);
    ok(lost.message.includes("This usually comes from < or > signs.") && !lost.message.includes("Edit as HTML"), `stray signs keep their words: ${lost.message}`);
  }
  // the legacy editors keep the strict reading and their words (test-page-editor pins them)
  const { wordsLostBySanitizing } = await import("../lib/sanitize.js");
  for (const [pasted] of WEB_PASTES) ok(wordsLostBySanitizing(pasted, sanitizeHtml(pasted)), `the legacy reading cleans ${pasted}`);
  for (const [pasted] of WEB_PASTES) ok(!wordsLostBySanitizing(pasted, sanitizeHtml(pasted), { webPaste: true }), `the web paste reading refuses ${pasted}`);
  // the legacy editor's words (lib/cms/store.js): its box already shows the HTML, so they name the tag without Edit as HTML
  const { checkPageSections } = await import("../lib/cms/store.js");
  const said = (html) => checkPageSections([{ kind: "rich", heading: "", html }]).issues.map((i) => i.message);
  const [legacyTag] = said(WEB_PASTES[0][0]);
  ok(legacyTag?.includes("<product-info> tag") && !legacyTag.includes("< or > signs") && !legacyTag.includes("Edit as HTML"), `legacy names the tag: ${legacyTag}`);
  eq(said("Free on orders <500 and >100 rupees."), ['saving would lose these words: "<500 and >". This usually comes from < or > signs. Reword them or remove them, then save again.'], "legacy stray signs, word for word:");
});

// Text that is still refused offers Edit as HTML in the editable field, where
// the hidden markup can be seen and removed (P3-RTE fix round 1).
const REFUSED_PASTE = `<p>Our story.</p><shop class="x"><p>Ships in 2 days.</p></shop>`;

await t("rendered+driven: a refused web-page paste offers Edit as HTML in the editable field, and the edit there saves", async () => {
  ok(M.refusedByCleaner([{ code: "WORDS_LOST" }]) && M.refusedByCleaner([{ code: "ADDRESS_LOST" }]) && M.refusedByCleaner([{ code: "MEDIA_LOST" }]) && M.refusedByCleaner([{ code: "PICTURE_LOST" }]), "every cleaner refusal counts");
  ok(!M.refusedByCleaner([{ code: "REQUIRED" }, { code: "TOO_LONG" }]) && !M.refusedByCleaner(null), "other issues don't");
  for (const pasted of [REFUSED_PASTE, `<p>Our story.</p><product-info><p>Ships in 2 days.</p>`]) {
    const p = await freshPage("<p>Our story.</p>");
    const refused = await saveHtml(p, pasted).then(
      () => null,
      (e) => e,
    );
    const issue = refused?.issues?.find((i) => M.CLEANER_REFUSALS.includes(i.code));
    ok(issue, `the server refuses ${pasted}: ${refused?.message}`);
    ok(/<(shop|product-info)> tag/.test(issue.message) && issue.message.includes("Edit as HTML"), `the server's words name the tag: ${issue.message}`);
    eq(await storedHtml(p.id), "<p>Our story.</p>", "nothing stored");
    // the field as the inspector shows it: the unsaved value and the server's issue
    const markup = render(h(RichTextField, { id: "f-sec_rte1-html", label: "Content", value: pasted, onChange: () => {}, issues: [issue] }));
    ok(markup.includes('data-rich-text="edit"') && markup.includes('role="toolbar"'), "still editable");
    ok(/<button[^>]*data-rte-edit-html[^>]*>Edit as HTML<\/button>/.test(markup), `no Edit as HTML for ${issue.code}`);
    ok(markup.includes("Pasted text can hold hidden code that doesn&#x27;t show here. Use Edit as HTML to see it, and remove the part named below."), "the way out, in plain words");
    const box = /<div[^>]*id="f-sec_rte1-html"[^>]*>/.exec(markup)[0];
    ok(new RegExp(`aria-describedby="[^"]*f-sec_rte1-html--readonly`).test(box), "the field names the way out");
    // in Edit as HTML the hidden markup is in plain sight; the founder removes it
    const sent = [];
    let tree = null;
    const Host = () => (tree = RTF.HtmlSource({ id: "f-sec_rte1-html", value: pasted, label: "Content", onChange: (v) => sent.push(v), onDone: () => {} }));
    ok(unescape(render(h(Host))).includes(pasted), "the text box shows the paste as it is");
    const fixed = pasted.replace(/<\/?(shop|product-info)[^>]*>/g, "");
    findProps(tree, (n) => n.type === "textarea").onChange({ target: { value: fixed } });
    const saved = await saveHtml(p, sent[0]);
    eq(await storedHtml(p.id), sanitizeHtml(fixed), "the edited text is stored cleaned");
    ok(saved.document.revision > p.revision, "saved");
  }
  // without a cleaner refusal, an editable field still has no Edit as HTML
  const other = render(h(RichTextField, { id: "f-x", label: "Content", value: "<p>Hi</p>", onChange: () => {}, issues: [{ code: "REQUIRED", severity: "incomplete", message: "Add the content." }] }));
  ok(!other.includes("Edit as HTML"), "no Edit as HTML for other issues");
  // and a founder without permission gets none, refusal or not
  const locked = render(h(RichTextField, { id: "f-y", label: "Content", value: REFUSED_PASTE, onChange: () => {}, issues: [{ code: "WORDS_LOST", severity: "error", message: "x" }], readOnlyReason: "Only the store owner can change this." }));
  ok(!locked.includes("Edit as HTML"), "locked stays locked");
});

await t("P3-FIX4 rendered: in Edit as HTML a refusal shows no rescue words and no second Edit as HTML button", async () => {
  const issue = { code: "WORDS_LOST", severity: "error", message: "saving would lose these words" };
  const markup = render(h(RichTextField, { id: "f-h", label: "Content", value: REFUSED_PASTE, onChange: () => {}, issues: [issue], sourceOpen: true }));
  ok(markup.includes('data-rich-text="html"') && markup.includes("<textarea"), `Edit as HTML is open: ${markup.slice(0, 200)}`);
  ok(!markup.includes("data-rte-edit-html"), "a do-nothing Edit as HTML button inside the text box");
  ok(!markup.includes("Pasted text can hold hidden code"), "the rescue words inside the text box");
  ok(!markup.includes("f-h--readonly"), "a read-only reason inside the text box");
  ok(markup.includes("saving would lose these words"), "the server's own note still shows");
  // the same issue in the surface does get the rescue (the pair pins the mode check)
  const surface = render(h(RichTextField, { id: "f-h", label: "Content", value: REFUSED_PASTE, onChange: () => {}, issues: [issue] }));
  ok(surface.includes("data-rte-edit-html") && surface.includes("Pasted text can hold hidden code"), "the surface offers the rescue");
});

await t("rendered: the editor and the storefront's rich text both use the .rte stylesheet", async () => {
  // the editor's surface is a .rte body that carries the page's own style sheets
  const markup = render(h(RichTextField, { id: "f-z", label: "Content", value: "<p>Hi</p>", onChange: () => {}, issues: [] }));
  ok(/\bclass="rte"/.test(bodyTagOf(srcdocOf(markup))), "the editor's surface body is .rte");
  const field = await readFile(join(FIELDS, "RichTextField.js"), "utf8");
  ok(field.includes(`document.head.querySelectorAll('link[rel="stylesheet"], style')`) && field.includes("d.importNode(n, true)"), "the surface copies in the page's style sheets");
  // the storefront: rich text sections on the home page and on a content page, and FAQ answers
  const Sections = await loadJsx(join(ROOT, "components/sections/RichTextSection.js"));
  for (const ctx of [{}, { surface: "page" }]) {
    const sf = render(h(Sections.default, { section: { id: "sec_rte1", kind: "rich_text", settings: { title: "T", html: "<p>Hi</p>" } }, ctx }));
    ok(/<div class="rte\b[^"]*"><p>Hi<\/p><\/div>/.test(sf), `the storefront's rich text is .rte (${ctx.surface || "home"}): ${sf}`);
  }
  // one stylesheet: the .rte rules live once, in app/globals.css, which both route groups load
  const css = await readFile(join(ROOT, "app/globals.css"), "utf8");
  ok(/\n\.rte \{[^}]*line-height: 1\.7/.test(css) && /\.rte a \{/.test(css) && /\.rte ul,\n\.rte ol \{/.test(css), "the .rte rules");
  const appFiles = (await walkJs(join(ROOT, "app"))).concat(await walkJs(join(ROOT, "components")));
  const cssFiles = (await readdir(join(ROOT, "app"))).filter((f) => f.endsWith(".css"));
  const defining = [];
  for (const f of cssFiles) if (/(^|\n)\.rte[\s,{.>:]/.test(await readFile(join(ROOT, "app", f), "utf8"))) defining.push(f);
  eq(defining, ["globals.css"], "the .rte rules are defined in one stylesheet");
  for (const layout of ["app/(console)/layout.js", "app/(storefront)/layout.js"]) ok((await readFile(join(ROOT, layout), "utf8")).includes('import "../globals.css"'), `${layout} doesn't load globals.css`);
  ok(appFiles.length > 0, "files scanned");
});

await cleanup();
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${failures.length} failed in ${secs} s`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
