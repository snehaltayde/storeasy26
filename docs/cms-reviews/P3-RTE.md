# P3 · RTE · The rich text field (AU-01, Option B)

Branch `cms/p3-rte`, cut from `0b81097`. Plan: `docs/cms-reviews/P3-PLAN.md` (batch 4, decision 13, "AU-01 acceptance gains shared `.rte` styles, server-only sanitizing and Edit as HTML", "`focusRequest {path, offset}` is in the RichTextField interface") and `P3-BATCHES.json`. Requirement: AU-01, plus ED-04's caret placement. No migration. **No new npm package:** `package.json`, `pnpm-lock.yaml` and `next.config.mjs` are unchanged (Option B, as decided).

This is the author's own report. Reviewers should re-read the code.

## Where this stands

| Stage | Status |
|---|---|
| Implemented | Yes, on this branch |
| Locally tested | Yes (after fix round 1). `pnpm test`: 81 of 81 suites passed in 129.6 s (`TEST_PUBLISH_PORTS=7143,7144 TEST_PUBLISH_SERVICE_PORTS=7145,7146 TEST_PUBLISH_UNDO_PORTS=7147`). `pnpm test:rich-text`: 15 passed in 0.5 s. `pnpm test:editor-inspector`: 34 passed, unchanged. `pnpm build` passed before fix round 1 (its one warning is the old `next.config.mjs` NFT trace warning); fix round 1 changed only the field, its model, the suite and the drill, and was not rebuilt |
| Browser verified | Yes, in desktop Chrome 156 (headless, `playwright-core`) on the design harness on this Mac (`DESIGN_PORT=6140`, `DESIGN_SQLD_PORT=7140`, `next dev`). `scripts/drills/p3/rte.mjs`: **43 passed, 0 failed** (after fix round 1). The field is the real component, but it runs on a host page the drill serves, not on the editor page (see "The drill's host"). Not Safari, not Firefox, not a phone |
| Staging verified | **NOT DONE** |
| Production enabled | **NOT DONE.** Nothing pushed, merged or deployed. No tenant changed mode |

## Fix round 1 (review of batch 4)

**The blocker.** A paste from a web page that uses its own elements (`<product-info …>`, `<relative-time …>`, as every Shopify theme and many sites have) or a `<noscript>` was refused by the server with WORDS_LOST. The surface shows only normal text, the field stayed editable with no Edit as HTML, so the founder could not find or remove the hidden markup, and every later save of the page was refused until the pasted text was deleted.

**The cause** is on the server: `lib/sanitize.js` `visibleText` counts a tag whose name is not an HTML name, and that has attributes, as the founder's words (`<founder>` is a word by design, AU-05). `sanitizeHtml` strips it, so `lostBySanitizing` refuses the save. A `<noscript>`'s text is counted as words a reader sees, and the sanitizer drops it.

**What this round changed (option a, in files RTE owns).**
- `richTextModel.js`: `CLEANER_REFUSALS` (`WORDS_LOST`, `ADDRESS_LOST`, `MEDIA_LOST`, `PICTURE_LOST`, the codes `lib/registry/text.js` `lostBySanitizing` gives), `refusedByCleaner(issues)` and `REFUSED_WORDS`.
- `RichTextField.js`: when the editable field has one of those issues, it shows "Pasted text can hold hidden code that doesn't show here. Use Edit as HTML to see it, and remove the part named below." and the **Edit as HTML** button, named in the field's `aria-describedby`. The toolbar stays. The text box shows the unsaved paste as it is, so `<product-info …>` is in plain sight. After a good save, "Show formatted" goes back to the editor, and the button goes away with the issue. A field locked by `readOnlyReason` still gets no Edit as HTML.

**What it does not change.** The server still refuses such a paste: the founder has to remove the element's tags in Edit as HTML. So the brief's "a paste from a web page is cleaned on the server" is met only for web pages without their own elements or `<noscript>`. Option (b), counting a valid custom element name (lowercase, with a hyphen, and a closing tag or attributes) as markup in `visibleText`, is in `lib/sanitize.js`, which RTE does not own. **That part is NOT DONE here and needs an owner or plan ruling** (Owner checks). The server's message also still says "This usually comes from < or > signs", which is `lib/registry/text.js`, not RTE's.

**Tests that fail before the fix.**
- `test-rich-text`, new test "a refused web-page paste offers Edit as HTML in the editable field, and the edit there saves". For three pastes (the reviewer's `<product-info>` paste, a `<relative-time datetime=…>` and a `<noscript>`) it saves through the real `saveDraft` and gets the cleaner's refusal with nothing stored. It renders the field with the unsaved value and that issue, and checks that the field is still editable and has the Edit as HTML button, the plain words and the `aria-describedby`. It drives the real `HtmlSource`, removes the hidden markup, and checks that `saveDraft` stores the cleaned text. It also checks that other issues and a locked field show no Edit as HTML. With `RichTextField.js` from the item's first commit it fails with "no Edit as HTML for WORDS_LOST".
- Drill step 7 (`rte.mjs`), in Chrome: it pastes a browser-style clipboard (`<!--StartFragment-->` with the reviewer's fragment). The field sends it as copied. The save is refused with WORDS_LOST, and nothing is stored. The field stays editable and offers Edit as HTML with its words. Clicking the button shows the `<product-info …>` tag in the text box. Removing it and saving stores `<p>Our story.</p>`, the bold "organic cotton" and "Ships in 2 days." with no class or data attribute. "Show formatted" returns to the editor with the stored text, and the button is gone. Screenshots: `web-paste-refused-1440.png`, `web-paste-saved-1440.png`. With the first commit's field the drill gives 38 passed and 3 failed ("the field stays editable and offers Edit as HTML" `{"mode":"edit","buttons":0}`, "it says why, in plain words", and the steps after it).

## What and why

AU-01 asks for a real rich text editor: a founder formats text with buttons, never sees tags, and pastes from Word or a web page without breaking the store. P3-INSPECTOR shipped the field's final interface with a fallback inside (a text box showing tags). This item replaces the inside and keeps the interface.

The owner chose Option B: no new package. So the editor uses the browser's own editing (contentEditable and its editing commands), with the safety and the rules below.

## Design

### The server is the only cleaner

- The field sends what was typed or pasted. It removes nothing.
- `saveDraft` already cleans rich text. It validates in draft mode (`lib/registry/validate.js`), and the `rich_text` and FAQ-answer setting kinds run `sanitize` (`lib/registry/settings.js` `checkHtml`). The stored body is the validator's. **So `lib/documents/service.js` needed no change,** and none was made. The suite proves the cleaning end to end through `saveDraft` on a real (file) database.
- When cleaning would lose words, a link or picture address, or a video, the save is refused in plain words (AU-05, unchanged). The suite shows a pasted video being refused with nothing stored.
- After a save, the store (P3-STORE) puts the stored value back into the field when nothing was typed since. The field then replaces what it shows with the stored value and keeps the caret where it was in the text.

### Nothing in a value or a paste can run

If the client never cleans, the field must still never put raw HTML into the console page, where it would run with the founder's session. So the text is edited in an **iframe sandboxed without scripts** (`sandbox="allow-same-origin"`, no `allow-scripts`). Its body is contentEditable, and the field's own code drives it from the console page. Inside the frame, no `<script>`, `onerror`, `onclick` or `ontoggle` runs. The prototype and the drill both show this: a pasted script, an `ontoggle` that fires on insert, and an `onclick` that is clicked all ran nothing, and no dialog opened.

Links inside the surface never navigate. A click on one is stopped.

### The parts

- **`components/admin/editor/fields/richTextModel.js`** (new, pure, no imports at all, so it is edge-safe). It holds:
  - the tag lists;
  - the toolbar;
  - the read-only rule and its words;
  - the paste helpers (`pastedPart`, `plainToHtml`, `splicePaste`);
  - focus (`blockChildAt`) and the caret as a text offset (`textOffset`, `pointAt`);
  - `syncAction`, which decides when an arriving value replaces what is shown;
  - `frameDocument`, the surface's srcdoc.
- **`components/admin/editor/fields/RichTextField.js`** (replaced). Same props and the same header contract. It also exports `HtmlSource`, the Edit as HTML text box, so the suite can drive it.

### Tags: exactly what the server keeps

The editor's marks (`a b strong i em u s small sub sup span code br`), blocks (`p div h1–h6 ul ol li blockquote hr`) and read-only tags (`table thead tbody tfoot tr th td figure figcaption pre img`) are, together, exactly the server's allowlist. The suite probes `lib/sanitize.js` with every HTML tag name, plus Word's and some made-up names, and compares the two sets. The toolbar buttons are Bold, Italic, Underline, Paragraph, Heading (h2), Subheading (h3), Bulleted list, Numbered list, Quote, Link and Remove link. They use the browser's commands with `styleWithCSS` off, so Chrome writes `<b>`, `<i>`, `<u>` and `<a href>`, never `style=`. The suite checks that the server keeps each button's output byte for byte, and the drill checks what Chrome really wrote. ⌘B, ⌘I and ⌘U are the browser's own shortcuts, and ⌘K opens the link box.

### Typing, linking, pasting

- **Typing** sends the surface's `innerHTML` on each `input` event. An empty field starts with `<p><br></p>` when it is focused, so the first words go in a paragraph. That change is not sent unless something is typed.
- **Link** opens a small "Web address" box under the toolbar. With text selected, the selection becomes the link (`createLink`). With no selection, the address is inserted as its own text. The address is not checked on the client: the server refuses an unsafe one with AU-05's words.
- **Paste** is taken by the field (`preventDefault`), so the browser never inserts or rewrites it:
  1. The copied part of the clipboard HTML is taken: what sits between `<!--StartFragment-->` and `<!--EndFragment-->`, else the body. Nothing inside it is changed. Plain text becomes paragraphs, with its characters encoded.
  2. A marker goes in at the caret.
  3. When the paste holds blocks, the blocks around the caret are closed and reopened, so a pasted paragraph never lands inside another one. A half left empty by that is dropped.
  4. The field sends that string, with Word's classes, styles, `<o:p>` and any script still in it.
  5. The surface shows it (it can't run), the caret goes after the paste, and the save stores it cleaned.

### Read-only content and Edit as HTML

A value holding a read-only tag opens in a read-only view of the same surface. There is no toolbar, and it shows the words "This text has a table, which this editor can't change. Use Edit as HTML to change it." (with a picture, a caption or preformatted text named the same way), plus an **Edit as HTML** button. That opens a plain text box (`HtmlSource`) whose text is sent exactly as typed. The server cleans it on save. "Show formatted" goes back to the view.

`readOnlyReason` (for example a founder without permission) makes the field read-only with that reason and no Edit as HTML.

### Untouched values (byte for byte)

- The surface's srcdoc holds the value exactly (`frameDocument`).
- The field sends only on `input` and `paste`. Focus, clicks and arrow keys send nothing.
- An arriving value that is the field's own echo, or that the surface already shows, is kept, never rewritten (`syncAction`). The same holds when the value differs only as the browser writes it (`<br />` against `<br>`); the comparison parses the value in an inert `<template>`.
- On the server, saving a stored value again stores the same bytes and the same hash.

### Focus (ED-04)

`focusRequest {path, offset}` focuses the surface and puts the caret at the start of element child number `offset` of its body. Offset 2 is the third block. Text and comments between blocks don't count, which is the same count the preview bridge uses (`bridge-core.js` `pickOf`). Past the end, the caret goes to the end of the last block. With no offset, the caret is left alone. In Edit as HTML, the text box gets the caret at that block's start (`inspectorModel.blockStart`). If the surface hasn't loaded yet, the request waits for it.

### One `.rte` stylesheet

- The storefront's rich text (`components/sections/RichTextSection.js` on both surfaces, and FAQ answers) is `class="rte"`. Its rules are the `.rte` block in `app/globals.css`, which both `app/(console)/layout.js` and `app/(storefront)/layout.js` load.
- The editor's surface body is `class="rte"`. When the surface loads, the field copies the console page's own style sheets into it (`link[rel=stylesheet]` and `style`), so the same `.rte` rules style the text. Only a small surface sheet (padding, the empty hint) is added on top.
- The drill measured both in Chrome:
  - in the editor: line height 1.7 and 0.85rem between blocks;
  - on the storefront preview of the same text: the same values, with links underlined.
- **`app/rte.css` was not created.** The plan listed it so the shared rules could move into it. Moving them needs an edit to `app/globals.css`, which no batch 4 item owns. One `.rte` stylesheet already exists and is shared, so the move would add nothing. A later owner of `globals.css` can split it out with a one-line `@import`. An editor-only CSS file is not needed either: a CSS import in `RichTextField.js` would also break the plain-node loaders in `test-editor-inspector` and `test-rich-text`.

### The surface's height

The surface grows with its content, from 112 px to 560 px, then scrolls. It is measured again when the copied style sheets load and whenever the body resizes (`ResizeObserver`). The first drill run caught the read-only table being cut off before this was added.

## Acceptance, with evidence

| # | Item | Status | Evidence | Fails without |
|---|---|---|---|---|
| 1 | unit: an untouched value round-trips byte for byte; a pasted Word fragment with a script and inline styles is stored sanitized by saveDraft; no client module calls a sanitizer (grep) | **DONE** | `test-rich-text` parts 2, 3 and 4. Round trip: `syncAction` keeps echoes and shown values. The rendered surface holds 9 stored values exactly (entities, `<br />`, `rel` words, joiners and emoji, leading and trailing whitespace), and rendering calls `onChange` 0 times. `saveDraft` of each stored value, and of 4 Chrome-typed values, stores the same bytes and the same `draftHash`. Word paste: the copied part is the fragment, the string the field sends still holds the `<script>`, `style=`, `onclick` and `class=MsoNormal`, and the stored value equals `sanitizeHtml(sent)`, with no script, `alert`, `style=`, `class=`, `onclick`, `o:p`, `mso` or comment, every word kept and the bold kept. Grep: every `components/admin/editor/**` module and every `"use client"` component under `components/` (comments stripped) imports no sanitizer and calls none; `richTextModel.js` imports nothing. Drill steps 1 and 4 repeat all of this in Chrome | On the base, the suite was a placeholder and `richTextModel.js` didn't exist. Mutations: M1 (the client strips the script from a paste), M3 (the surface trims the value), M4 (an echo is replaced) and M9 (the field imports `sanitizeHtml`, which also fails `test-editor-inspector`) each fail it. D2 (the field sends its value on load) fails the drill's "clicks and arrow keys send nothing". `saveDraft`'s cleaning itself is older than this item: the server half of the test passes on the base |
| 2 | rendered: content with a table opens read-only with 'Edit as HTML'; editing it as HTML stores the sanitized result | **DONE** | Rendered: a table value gives `data-rich-text="view"`, the Edit as HTML button, the plain-words reason named in `aria-describedby`, no toolbar, a surface with `aria-readonly` and no contenteditable, and no `allow-scripts`. Driven: the real `HtmlSource`'s `onChange` sends the typed table with `onmouseover`, `style` and a script exactly as typed. `saveDraft` stores `sanitizeHtml` of it (the edit kept, the rest gone). Re-rendered with the stored value, the field is the read-only view of it. A pasted video in the same box is refused with AU-05's words, and the row is unchanged. Drill step 6: the button is clicked in Chrome, the text box shows the stored HTML, the save stores the cleaned table, the text box shows the stored value, and "Show formatted" shows it read-only | M6 (no read-only view) fails 2 tests. M8 (`allow-scripts` added) fails the rendered test. M11 (the text box trims what was typed) fails the driven test |
| 3 | rendered: editor and storefront rich text both use the .rte stylesheet | **DONE** | Rendered: the surface body is `class="rte"`, the field copies the page's style sheets, `RichTextSection` renders `<div class="rte …">` on both surfaces, the `.rte` rules exist in exactly one stylesheet (`app/globals.css`), and both route layouts import it. Drill: the editor's computed line height 1.7 and block gap 0.85rem equal the storefront preview's for the same text | M7 (the surface body loses `rte`) fails it |
| 4 | unit: focusRequest offset 2 targets the third block child | **DONE** | `blockChildAt(root, 2)` is the `<ul>` in a body with whitespace text and a comment between blocks. The `<br>` inside a block doesn't count. Past the end and negative or missing offsets are handled. Drill step 2: `focusRequest {offset: 2}` puts Chrome's caret at offset 0 of "Third paragraph.", block 2, with the surface focused | M2 (text nodes counted as blocks) fails it |
| 5 | drill (harness): rte.mjs passes. package.json and pnpm-lock.yaml change only if Option A was approved | **DONE** | `docs/cms-reviews/drills/P3-RTE/results-rte.json`: 43 passed, 0 failed after fix round 1 (35 before it; step 7, the web-page paste, added 8). Nine screenshots are next to it. `git diff 0b81097 -- package.json pnpm-lock.yaml next.config.mjs` is empty | D1 (no block split on paste) fails "the stored value keeps the bold and the link", and since then the nesting check too (see below). D2 is above |

Every acceptance item is met with Option B. Nothing is marked NOT DONE for want of Tiptap. One part of the brief (not an acceptance line) is NOT DONE: a web page's paste with its own elements or a `<noscript>` is refused and must be fixed in Edit as HTML, not cleaned on save; see "Fix round 1". What Tiptap (Option A) would change is listed under Known limits.

### Do the tests bite?

The scratch runner is `…/scratchpad/p3-b4/P3-RTE/mut/run.py`. It applies one break at a time, runs `test-rich-text` and `test-editor-inspector`, and restores the file.

| Break | Caught by |
|---|---|
| M1 client strips `<script>` from a paste | the Word paste test |
| M2 offset counts text nodes | the offset 2 test |
| M3 surface trims the value | the round-trip and driven tests (after the corpus gained a value with surrounding whitespace; the first run let it through) |
| M4 echo replaced | the syncAction test |
| M5 `pre` dropped from the read-only list | the tag-set test |
| M6 no read-only view | the rendered and driven table tests |
| M7 surface not `.rte` | the `.rte` test |
| M8 `allow-scripts` added to the sandbox | the rendered table test |
| M9 field imports `sanitizeHtml` | the grep test, and `test-editor-inspector`'s header check |
| M10 no block split on paste | not by the suite: the split is DOM code. Caught by the drill as D1 |
| M11 Edit as HTML trims what was typed | the driven test (after a trailing newline was added; the first run let it through) |

Drill run with D1 and D2 applied together: 33 passed, 2 failed. D2 failed "clicks and arrow keys send nothing" and D1 failed "the stored value keeps the bold and the link". The drill's own "not inside another paragraph" check missed D1 in that run (its regex was too narrow). It is now a real nesting count, checked against D1's stored value.

## Tests

| What | Result | Time |
|---|---|---|
| `pnpm test:rich-text` (`scripts/test-rich-text.js`, replaces SCAFFOLD's placeholder) | 15 passed | 0.5 s |
| `pnpm test:editor-inspector` (not edited) | 34 passed | 0.8 s |
| `pnpm test` | 81 of 81 suites | 129.6 s |
| `pnpm build` | passed before fix round 1 (the old NFT warning only); not rerun after it | |
| `scripts/drills/p3/rte.mjs` | 43 passed, 0 failed | |

## The drill's host

P3-EDITOR builds the editor page in this same batch, so no page in this branch mounts `RichTextField` yet. The drill therefore hosts the real field itself:
- `playwright`'s `context.route` serves a small page **on the harness's own address**, so it is the same origin with the owner's real cookies;
- the page uses the console's own style sheets and `<html>` attributes, read from the signed-in dashboard;
- its script is `RichTextField.js` and `documentsApi.js`, compiled with Next's SWC and bundled with React's CommonJS files by about 40 lines in `rte.mjs`. No package is added, and the bundler refuses any `node:` import, so it also shows the field's whole import graph runs in a browser;
- its Save button calls `saveDraft` through `documentsApi` and puts the stored value back into the field, which is what the store does when nothing was typed since;
- the preview is `startDocumentsPreview`, and the page opens at `/policies/rte-drill` on the real storefront.

The drill doesn't prove the field inside P3-EDITOR's layout, with the real store's autosave timing. That is for P3-EDITOR's and P3-DRILLS' drills once both are merged.

## Known limits

- **A web page's own elements and `<noscript>` are refused, not cleaned** (fix round 1). The server's AU-05 check counts `<product-info id=…>` and the text in a `<noscript>` as words the sanitizer would lose, so the save is refused. The field now offers Edit as HTML for any such refusal, and the founder removes the tags there. Cleaning them without a refusal needs the `lib/sanitize.js` change in "Fix round 1", which RTE does not own. The refusal's words ("This usually comes from < or > signs") don't fit this case; they are `lib/registry/text.js`'s.

- **The paste in the drill is a dispatched `paste` event** carrying a `DataTransfer` with Word's clipboard HTML. It is not the OS clipboard. Chrome's async clipboard API cleans `text/html` when a page writes it, so a script can't be put on the real clipboard that way. The field's handler is the same code either way. A real Word-to-Chrome paste is an owner check.
- **Undo (⌘Z).** The browser's own undo history doesn't know about a paste (the field inserts it) or about the stored value replacing the shown one. After either, ⌘Z may do nothing or skip back past it. Tiptap (Option A) would keep its own undo history across both.
- **Word lists** come out as paragraphs that start with Word's "·" bullet character, because the server keeps the bullet's text and drops Word's list markup. Turning them into real lists would be client-side conversion of a paste, which the "server is the only cleaner" rule rules out. It needs a server-side rule or an owner ruling.
- **Pictures in a paste.** Word puts `file:///…` picture addresses on the clipboard, and the server refuses those with AU-05's plain words (nothing is stored). The field then shows the paste read-only, because it holds `<img>`, and Edit as HTML is the way to remove the picture. A picture with a web address is kept, and its text opens read-only.
- **While a paste waits for the save,** the surface shows it as copied (it can't run). Word's own spacing and colours can show until the stored value comes back.
- **`execCommand`** is deprecated in the standards, though every current browser supports it. Its output was checked only in Chrome. Safari and Firefox write the same tags for these commands, but that wasn't tested. Tiptap would give the same output in every browser and a schema-driven model, and could make tables editable with an extension. None of that is needed for this item's acceptance.
- **The surface uses the platform's default colours** for text and links, not the store's brand. The brand's variables are only on storefront pages. The rules (sizes, spacing, lists, underlines) are the shared `.rte` ones.
- **The wrapper element** (the one with the field's `id`) carries `readonly` and `aria-readonly` in read-only modes. `aria-readonly` is what assistive tech reads. `readonly` is kept because `test-editor-inspector`'s contract test looks for it.
- **`test-editor-inspector`'s test name** still says "fallback". It is not this item's file. The test passes against the new field.
- **Height** is capped at 560 px, after which the surface scrolls.
- **Desktop Chrome only, headless.** No phone or screen-reader run.

From review:

- Earlier blocker (a web page's paste with its own elements is refused and the founder has no way out): fixed by option (a). When the editable field has a WORDS_LOST, ADDRESS_LOST, MEDIA_LOST or PICTURE_LOST issue, it now shows plain words and an 'Edit as HTML' button. RichTextField.js line 416 sets `rescue = mode === "edit" && refusedByCleaner(notes)`, and the button condition at line 498 is `(mode === "view" || rescue)`. The codes match what lib/registry/text.js lostBySanitizing and lib/cms/store.js return. The store keeps a 422's issues in `pending` until the next good save. I re-ran drill step 7 in Chrome on my own harness (ports 6340/7340): the paste is refused with WORDS_LOST and nothing is stored. The field stays editable and offers Edit as HTML, the text box shows the <product-info> tag, and after the tag is removed the save stores the cleaned text. The whole drill passed 43/0.
- Still NOT DONE, and recorded honestly in the packet with an owner ruling: a web page's paste that has custom elements or a <noscript> is refused, not cleaned on save. That needs the lib/sanitize.js visibleText change, which RTE does not own. This is the brief's line 'Paste from Word or a web page is cleaned on the server'. It is not an acceptance line, and the earlier review accepted '(a) and/or (b) ... or the item marks this NOT DONE'. My Node probe also found that a custom element with no attributes (`<product-info><p>Ships</p></product-info>`) is refused. Removing only the opening tag or only the closing tag is refused too, naming the leftover tag. The founder therefore has to remove both tags of every such element by hand, which on a Shopify page can be many. Compared with the base textarea, where the paste went in as plain text, this workflow is still worse for a founder who doesn't know HTML. The owner ruling on option (b) should come before founders use the field. <svg>, <style>, Word's <xml>/<o:p>, and <button>/<input>/<label>/<select> all clean without a refusal.
- The server's message under the field still says 'This usually comes from < or > signs. Reword them or remove them'. That doesn't fit a hidden element the founder can only see in Edit as HTML. The wording is in lib/registry/text.js and lib/cms/store.js, which RTE does not own, and the packet notes it. It should be part of the same owner ruling.
- One mutation survived: `rescue = !locked && refusedByCleaner(notes)` (rescue also on in html mode). It would show the refusal words and a do-nothing Edit as HTML button inside the HTML text box. It is cosmetic, and the current code is correct. Four other mutations of the fix were each caught by the new test: removing the rescue from the button condition, removing REFUSED_WORDS, ignoring the first issue, and dropping WORDS_LOST from CLEANER_REFUSALS.
- Checked and fine: test-rich-text 15/15. pnpm test 81 of 81 suites in 131.5 s with TEST_PUBLISH_PORTS=7343,7344, TEST_PUBLISH_SERVICE_PORTS=7345,7346 and TEST_PUBLISH_UNDO_PORTS=7347. pnpm build passes at 90ed4f2 with only the known Turbopack warning; the packet had said the build was not re-run after fix round 1. git diff 0b81097..90ed4f2 touches nothing in package.json, pnpm-lock.yaml, next.config.mjs, .github/ or lib/, so legacy tenants and the server path are unchanged. richTextModel.js still imports nothing.
- Owner checks still open (from the packet, still valid):
  - A real OS-clipboard paste from Word and from a live Shopify page, in Chrome, Safari and Firefox, once P3-EDITOR mounts the field. Also check whether Cmd+Shift+V (paste as plain text) gives the founder a simpler way out.
  - The 375-wide phone layout.
  - VoiceOver.
  - The CI sqld download's source and checksum.

## Owner checks

- **A real paste from Word** (Word for Mac and Windows) and from a web page into the field in Chrome, then save and preview. Check that the words, bold, italics and links come through and nothing else does. Once P3-EDITOR is merged, do this in the editor itself.
- **Safari and Firefox:** Bold, the lists, Link and paste.
- **Phones at 375 wide** (after P3-EDITOR mounts the field): the toolbar wraps, and the surface is usable.
- **VoiceOver:** the field is announced with its label as a text box, the toolbar as "Formatting for Content", and a read-only reason is read.
- **Ruling: web-page pastes with their own elements** (fix round 1). Should `lib/sanitize.js` `visibleText` count a valid custom element name (lowercase, with a hyphen, closed or with attributes, such as `<product-info id=…>…</product-info>`) as markup, so such a paste is cleaned on save instead of refused? And should a `<noscript>`'s text count as lost words? Until then the founder removes them in Edit as HTML. Whoever owns `lib/sanitize.js` would make the change; the AU-05 suites must keep refusing `<founder>` and "the <link> below".
- **Rulings:** Word bullets kept as "·" paragraphs (Known limits); ⌘Z after a paste (Known limits).
- **CI:** the sqld download in CI still needs the owner's approval of its source and checksum. Nothing under `.github/` was changed.

## Files

- `components/admin/editor/fields/RichTextField.js` (replaced; interface and header contract unchanged)
- `components/admin/editor/fields/richTextModel.js` (new)
- `scripts/test-rich-text.js` (replaces the placeholder)
- `scripts/drills/p3/rte.mjs` (new)
- `docs/cms-reviews/drills/P3-RTE/`: `results-rte.json` and 9 screenshots (2 added in fix round 1)
- this packet

Not changed: `lib/documents/service.js` (it already cleans; proved by the suite), `app/rte.css` (not created; see "One `.rte` stylesheet"), `package.json`, `pnpm-lock.yaml`, `next.config.mjs`, `.github/`.

## Commands

```
pnpm install --frozen-lockfile --prefer-offline
pnpm test:rich-text
TEST_PUBLISH_PORTS=7143,7144 TEST_PUBLISH_SERVICE_PORTS=7145,7146 TEST_PUBLISH_UNDO_PORTS=7147 pnpm test
pnpm build
DESIGN_PORT=6140 DESIGN_SQLD_PORT=7140 node scripts/drills/p3/rte.mjs
```
