"use client";

// P3-INSPECTOR (AU-01, ED-04): the rich text field. THE INTERFACE IS FINAL.
// P3-RTE replaced the fallback text box with a real editor (Option B: the
// browser's own editing, no new package) and kept every prop below as it is.
//
// Props (the contract):
//   value           string   the stored HTML (sanitized by the server). The
//                            field shows it and never changes it on its own:
//                            an untouched value goes back exactly as it came.
//   onChange(html)  function called with what the founder typed or pasted.
//                            The field never sanitizes (the server is the only
//                            sanitizer: saveDraft sanitizes, and the field then
//                            shows the stored value it gets back).
//   issues          array    the issues placed at this field
//                            ({ message, severity, … }, inspectorModel
//                            placeIssues/notesAt). Each message is shown under
//                            the field in plain words, in an element whose id
//                            is notesId(id), referenced by aria-describedby.
//   focusRequest    { path, offset? } | null
//                            ED-04: when it changes, the field takes the
//                            focus. `path` is the field path the request was
//                            made for (the form only passes a request whose
//                            path lands on this field). `offset` is a block
//                            child index: offset 2 puts the caret at the start
//                            of the third top-level block (paragraph, heading,
//                            list). Without an offset the caret is left alone.
//   readOnlyReason  string?  when given, the field can't be edited and says
//                            why, in these words (for example content this
//                            editor can't edit yet, or a founder without
//                            permission).
//   id              string   the element id: the field's anchor
//                            (fieldAnchor, "f-<section>-<path>"), so publish
//                            links and preview clicks find it.
//   label           string   the field's label, as the registry declares it.
//   placeholder     string?  the empty-state hint.
//   required        boolean? marks the label.
//
// How it works (P3-RTE, docs/cms-reviews/P3-RTE.md):
//   - The text is edited in an iframe sandboxed WITHOUT scripts
//     (sandbox="allow-same-origin"), whose body is contentEditable. Nothing in
//     a value or a paste can run there: no script, no onerror, no onclick. The
//     field's own code, in this page, drives it.
//   - The buttons use the browser's editing commands (bold, formatBlock,
//     lists, createLink). They make only tags the server keeps
//     (richTextModel TOOLBAR, checked by scripts/test-rich-text.js).
//   - Typing sends the surface's HTML. A paste is not inserted by the browser:
//     the clipboard's copied part goes in at the caret as it was copied, the
//     field sends that, and the server cleans it on save (Word's styles,
//     classes and any script are removed there). The stored value then
//     replaces what is shown, keeping the caret.
//   - A value with tags this editor can't edit (a table, a picture, a caption,
//     preformatted text) opens read-only with "Edit as HTML": a plain text box
//     whose text is sent as typed.
//   - When the server refuses a save because cleaning would lose something
//     (WORDS_LOST and the other lostBySanitizing codes), the editable field
//     offers Edit as HTML too: a web page's paste can hold markup the surface
//     shows as ordinary text, and the text box is where it can be removed.
//   - The surface carries the page's own style sheets, so the text looks as
//     the store's shared .rte rules make it look on the storefront.
import { useCallback, useEffect, useRef, useState } from "react";
import { applyFocus, blockStart, notesId, noteTone, blocks } from "./inspectorModel.js";
import { TOOLBAR, uneditableTags, readOnlyWords, refusedByCleaner, REFUSED_WORDS, pastedPart, plainToHtml, hasBlocks, splicePaste, linkHtml, newMarker, blockChildAt, textOffset, pointAt, syncAction, frameDocument, looksEmpty } from "./richTextModel.js";

const TONE = { danger: "text-danger", warning: "text-warning", muted: "text-fg-muted" };
const MIN_HEIGHT = 112;
const MAX_HEIGHT = 560;

function Notes({ id, notes }) {
  if (!notes.length) return null;
  return (
    <div id={notesId(id)} data-for={id} className="mt-1 space-y-0.5">
      {notes.map((n, i) => (
        <p key={i} className={`text-xs ${TONE[noteTone(n)]}`}>
          {n.message}
        </p>
      ))}
    </div>
  );
}

// "Edit as HTML": the stored HTML in a plain text box, sent exactly as typed.
export function HtmlSource({ id, value, onChange, describedBy, invalid, onDone, label }) {
  return (
    <div data-rich-text-source>
      <textarea
        id={id}
        value={value}
        aria-label={`${label} (HTML)`}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        spellCheck={false}
        onChange={(e) => onChange?.(e.target.value)}
        className={`w-full min-h-40 rounded-ctl border bg-surface px-3 py-2 font-mono text-xs text-fg focus-ring ${invalid ? "border-danger" : "border-edge"}`}
      />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-subtle">You're changing the HTML itself. When it saves, anything a page can't show safely, such as scripts, is taken out.</p>
        <button type="button" onClick={onDone} className="rounded-ctl border border-edge bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface-muted focus-ring">
          Show formatted
        </button>
      </div>
    </div>
  );
}

// The sandboxed surface. Its srcdoc is fixed when it mounts; later values go
// in through the DOM (the parent effect), so typing never reloads it.
function Surface({ frameRef, html, label, placeholder, editable, onReady, onGone }) {
  const [srcDoc] = useState(() => frameDocument(html, { label, placeholder, editable }));
  useEffect(() => {
    const f = frameRef.current;
    if (!f) return;
    const ready = () => {
      const d = f.contentDocument;
      if (d && d.URL === "about:srcdoc" && d.body) onReady(d);
    };
    if (f.contentDocument?.readyState === "complete") ready();
    f.addEventListener("load", ready);
    return () => {
      f.removeEventListener("load", ready);
      onGone();
    };
  }, []);
  return <iframe ref={frameRef} title={label} sandbox="allow-same-origin" srcDoc={srcDoc} data-rich-text-surface={editable ? "edit" : "view"} className="block w-full border-0 bg-transparent" style={{ height: MIN_HEIGHT }} />;
}

// `sourceOpen` sets how Edit as HTML first renders (tests; hosts leave it off).
export default function RichTextField({ value, onChange, issues = [], focusRequest = null, readOnlyReason = null, id, label, placeholder = "", required = false, sourceOpen = false }) {
  const html = typeof value === "string" ? value : "";
  const notes = Array.isArray(issues) ? issues : [];
  const locked = typeof readOnlyReason === "string" && readOnlyReason.length > 0;
  const tags = uneditableTags(html);
  const [source, setSource] = useState(sourceOpen === true);
  const mode = locked ? "locked" : source ? "html" : tags.length ? "view" : "edit";
  const editable = mode === "edit";

  const frameRef = useRef(null);
  const sourceRef = useRef(null);
  const docRef = useRef(null);
  const emitted = useRef(null);
  const savedRange = useRef(null);
  const resize = useRef(null);
  const latest = useRef({ onChange, html });
  latest.current = { onChange, html };
  const [linking, setLinking] = useState(false);
  const [address, setAddress] = useState("");
  const [pressed, setPressed] = useState({});

  const send = useCallback((next) => {
    if (next === emitted.current) return;
    emitted.current = next;
    latest.current.onChange?.(next);
  }, []);

  const fit = useCallback(() => {
    const f = frameRef.current;
    const d = docRef.current;
    if (!f || !d?.documentElement) return;
    const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, d.documentElement.scrollHeight));
    f.style.height = `${h}px`;
  }, []);

  const markEmpty = useCallback(() => {
    const d = docRef.current;
    if (!d?.body) return;
    if (looksEmpty(d.body.textContent, d.body.innerHTML)) d.body.setAttribute("data-empty", "");
    else d.body.removeAttribute("data-empty");
  }, []);

  const readPressed = useCallback(() => {
    const d = docRef.current;
    if (!d) return;
    const next = {};
    for (const b of TOOLBAR) {
      if (b.group !== "mark") continue;
      try {
        next[b.id] = d.queryCommandState(b.command);
      } catch {
        next[b.id] = false;
      }
    }
    setPressed((p) => (Object.keys(next).some((k) => p[k] !== next[k]) ? next : p));
  }, []);

  // A paste: the copied part goes in at the caret exactly as it was copied
  // (the server cleans it on save). Blocks around the caret are closed and
  // reopened, so a pasted paragraph doesn't land inside another one.
  const pasteRaw = useCallback(
    (part) => {
      const d = docRef.current;
      if (!d || !part) return;
      const sel = d.getSelection();
      let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!range || !d.body.contains(range.startContainer)) {
        range = d.createRange();
        range.selectNodeContents(d.body);
        range.collapse(false);
      }
      range.deleteContents();
      const marker = newMarker();
      const mk = d.createTextNode(marker);
      range.insertNode(mk);
      const around = [];
      for (let n = mk.parentNode; n && n !== d.body; n = n.parentNode) around.push(n);
      const startTag = (el) => {
        const c = el.cloneNode(false);
        const s = c.outerHTML;
        return s.slice(0, s.length - `</${c.localName}>`.length);
      };
      const split = hasBlocks(part) ? { open: [...around].reverse().map(startTag).join(""), close: around.map((a) => `</${a.localName}>`).join("") } : {};
      const shown = d.body.innerHTML;
      const next = splicePaste(shown, marker, part, split);
      // show it with an end marker for the caret, then take the marker out
      const end = newMarker();
      d.body.innerHTML = splicePaste(shown, marker, part + end, split);
      const walker = d.createTreeWalker(d.body, 4);
      let caret = null;
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const i = t.nodeValue.indexOf(end);
        if (i !== -1) {
          t.nodeValue = t.nodeValue.slice(0, i) + t.nodeValue.slice(i + end.length);
          caret = { node: t, offset: i };
          break;
        }
      }
      if (caret) {
        const r = d.createRange();
        r.setStart(caret.node, caret.offset);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      markEmpty();
      fit();
      send(next);
    },
    [send, fit, markEmpty],
  );

  // The surface went away (the mode changed): the next one starts unread.
  const onGone = useCallback(() => {
    resize.current?.disconnect();
    resize.current = null;
    docRef.current = null;
    emitted.current = null;
  }, []);

  // The surface is ready: carry the page's style sheets in, listen.
  const onReady = useCallback(
    (d) => {
      if (docRef.current === d) return;
      docRef.current = d;
      for (const n of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
        const copy = d.importNode(n, true);
        copy.addEventListener?.("load", fit); // the height is right only once the styles apply
        d.head.appendChild(copy);
      }
      d.documentElement.className = document.documentElement.className;
      const surfaceStyle = d.head.querySelector("style[data-rte-surface]");
      if (surfaceStyle) d.head.appendChild(surfaceStyle); // last, so it wins
      d.addEventListener("click", (e) => {
        if (e.target?.closest?.("a")) e.preventDefault(); // links never navigate the surface
      });
      markEmpty();
      fit();
      try {
        resize.current?.disconnect();
        resize.current = new ResizeObserver(fit);
        resize.current.observe(d.body);
      } catch {}
      if (d.body.getAttribute("data-readonly") != null) return;
      try {
        d.execCommand("styleWithCSS", false, false);
        d.execCommand("defaultParagraphSeparator", false, "p");
      } catch {}
      d.body.contentEditable = "true";
      d.addEventListener("input", () => {
        markEmpty();
        fit();
        send(d.body.innerHTML);
      });
      d.addEventListener("paste", (e) => {
        e.preventDefault();
        const cd = e.clipboardData;
        const raw = cd?.getData("text/html") || "";
        pasteRaw(raw ? pastedPart(raw) : plainToHtml(cd?.getData("text/plain") || ""));
      });
      d.addEventListener("focusin", () => {
        // an empty field starts with a paragraph, so typing makes <p>…</p>
        if (!d.body.firstChild) {
          d.body.innerHTML = "<p><br></p>";
          const r = d.createRange();
          r.setStart(d.body.firstChild, 0);
          r.collapse(true);
          const s = d.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
      });
      d.addEventListener("selectionchange", readPressed);
      d.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
          e.preventDefault();
          openLink();
        }
      });
      // a value that arrived before the surface was ready
      const v = latest.current.html;
      if (d.body.innerHTML !== v && syncAction({ value: v, emitted: emitted.current, shown: d.body.innerHTML }) === "replace") d.body.innerHTML = v;
    },
    [send, fit, markEmpty, pasteRaw, readPressed],
  );

  // A new value from outside (the stored value after a save, a reload, a
  // conflict choice): replace what is shown unless it is the field's own echo
  // or already shown. The caret keeps its place in the text.
  useEffect(() => {
    const d = docRef.current;
    if (!d?.body || mode === "html") return;
    const shown = d.body.innerHTML;
    const t = d.createElement("template");
    t.innerHTML = html; // inert: a template's content never runs or loads
    if (syncAction({ value: html, emitted: emitted.current, shown, normalized: t.innerHTML }) === "keep") return;
    const sel = d.getSelection();
    const focused = d.hasFocus() && sel && sel.rangeCount > 0;
    const at = focused ? textOffset(d.body, sel.anchorNode, sel.anchorOffset) : null;
    d.body.innerHTML = html;
    emitted.current = null;
    if (at != null) {
      const p = pointAt(d.body, at);
      const r = d.createRange();
      r.setStart(p.node, p.offset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    markEmpty();
    fit();
  }, [html, mode]);

  // ED-04: focus, and the caret at the start of block child `offset`.
  useEffect(() => {
    if (!focusRequest || typeof document === "undefined") return;
    if (mode === "html") {
      applyFocus(document, id, blockStart(sourceRef.current?.value ?? html, focusRequest.offset));
      return;
    }
    const wrap = document.getElementById(id);
    if (wrap && typeof wrap.scrollIntoView === "function") wrap.scrollIntoView({ block: "nearest" });
    const place = () => {
      const d = docRef.current;
      if (!d || mode !== "edit") {
        wrap?.focus?.({ preventScroll: true });
        return;
      }
      frameRef.current?.contentWindow?.focus();
      d.body.focus({ preventScroll: true });
      const target = blockChildAt(d.body, focusRequest.offset);
      if (!target) return;
      const r = d.createRange();
      if (target.atEnd) {
        r.selectNodeContents(target.node);
        r.collapse(false);
      } else {
        r.setStart(target.node, 0);
        r.collapse(true);
      }
      const s = d.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    };
    if (docRef.current || mode !== "edit") place();
    else frameRef.current?.addEventListener("load", () => setTimeout(place, 0), { once: true });
    // a new request object is a new request, even for the same path
  }, [focusRequest]);

  const run = (b) => {
    const d = docRef.current;
    if (!d || !editable) return;
    if (b.id === "link") return openLink();
    frameRef.current?.contentWindow?.focus();
    try {
      d.execCommand(b.command, false, b.command === "formatBlock" ? `<${b.value}>` : null);
    } catch {}
    readPressed();
  };

  function openLink() {
    const d = docRef.current;
    if (!d) return;
    const sel = d.getSelection();
    savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const a = savedRange.current?.startContainer?.parentElement?.closest?.("a");
    setAddress(a?.getAttribute("href") || "");
    setLinking(true);
  }

  const applyLink = () => {
    const d = docRef.current;
    const href = address.trim();
    setLinking(false);
    if (!d || !href) return;
    frameRef.current?.contentWindow?.focus();
    const sel = d.getSelection();
    if (savedRange.current) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    try {
      if (sel.rangeCount && !sel.getRangeAt(0).collapsed) d.execCommand("createLink", false, href);
      else d.execCommand("insertHTML", false, linkHtml(href));
    } catch {}
  };

  const readonlyId = `${id}--readonly`;
  // a save the cleaner refused: Edit as HTML is the way to find what it named.
  // Only in the editable surface: in Edit as HTML the founder already sees it.
  const rescue = mode === "edit" && refusedByCleaner(notes);
  const why = locked ? readOnlyReason : mode === "view" ? readOnlyWords(tags) : rescue ? REFUSED_WORDS : null;
  const describedBy = [notes.length ? notesId(id) : null, why ? readonlyId : null].filter(Boolean).join(" ") || undefined;
  const invalid = blocks(notes);
  const labelId = `${id}--label`;

  return (
    <div className="min-w-0" data-rich-text={mode}>
      <span id={labelId} className="mb-1 block text-xs font-medium text-fg-muted">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      {mode === "html" ? (
        <HtmlSource id={id} value={html} label={label} onChange={(v) => onChange?.(v)} describedBy={describedBy} invalid={invalid} onDone={() => setSource(false)} />
      ) : (
        <div
          id={id}
          role="group"
          tabIndex={-1}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-readonly={editable ? undefined : true}
          readOnly={editable ? undefined : true}
          onFocus={(e) => {
            if (e.target === e.currentTarget && editable) frameRef.current?.contentWindow?.focus();
          }}
          className={`overflow-hidden rounded-ctl border bg-surface focus-within:ring-2 focus-within:ring-edge-strong ${invalid ? "border-danger" : "border-edge"}`}
        >
          {editable && (
            <div role="toolbar" aria-label={`Formatting for ${label}`} className="flex flex-wrap items-center gap-0.5 border-b border-edge bg-surface-muted px-1.5 py-1">
              {TOOLBAR.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  data-rte-button={b.id}
                  aria-pressed={b.group === "mark" ? Boolean(pressed[b.id]) : undefined}
                  title={b.key ? `${b.label} (⌘${b.key.toUpperCase()})` : b.label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(b)}
                  className={`rounded px-2 py-1 text-xs text-fg hover:bg-surface-sunken focus-ring ${pressed[b.id] ? "bg-surface-sunken font-semibold" : ""}`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
          {editable && linking && (
            <div className="flex flex-wrap items-center gap-2 border-b border-edge px-2 py-1.5" data-rte-link-form>
              <label htmlFor={`${id}--link`} className="text-xs text-fg-muted">
                Web address
              </label>
              <input
                id={`${id}--link`}
                type="text"
                inputMode="url"
                autoFocus
                value={address}
                placeholder="/collections/new or https://…"
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyLink();
                  } else if (e.key === "Escape") setLinking(false);
                }}
                className="min-w-0 flex-1 rounded-ctl border border-edge bg-surface px-2 py-1 text-xs text-fg focus-ring"
              />
              <button type="button" onClick={applyLink} className="rounded-ctl bg-primary px-2.5 py-1 text-xs font-medium text-primary-fg hover:bg-primary-hover focus-ring">
                Add link
              </button>
              <button type="button" onClick={() => setLinking(false)} className="rounded-ctl px-2 py-1 text-xs text-fg-muted focus-ring">
                Cancel
              </button>
            </div>
          )}
          <Surface key={mode} frameRef={frameRef} html={html} label={label} placeholder={placeholder} editable={editable} onReady={onReady} onGone={onGone} />
        </div>
      )}
      {why && (
        <div id={readonlyId} className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-fg-muted">{why}</p>
          {(mode === "view" || rescue) && (
            <button type="button" data-rte-edit-html onClick={() => setSource(true)} className="rounded-ctl border border-edge bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface-muted focus-ring">
              Edit as HTML
            </button>
          )}
        </div>
      )}
      <Notes id={id} notes={notes} />
    </div>
  );
}
