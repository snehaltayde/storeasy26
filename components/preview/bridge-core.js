// The preview frame's side of the editor protocol (P3-FRAME; PV-01, ED-04,
// ED-02). A plain module: no React, no imports. The window and the document
// are passed in, so a test drives it with a small stand-in DOM, and
// components/preview/PreviewBridge.js only mounts it in a useEffect.
//
// It stays inert unless the page is inside a frame (window.parent !== window),
// and it only listens to messages from its own origin.
//
// v1, the legacy Designer (S54), unchanged:
//   parent → "storeasy:designer:hello"            select mode on
//   parent → {type:"storeasy:sec:highlight", id}  outline + scroll to a [data-sec]
//   parent → {type:"storeasy:refresh"}            reload (after a draft save)
//   child  → {type:"storeasy:sec:click", id}      a [data-sec] was clicked
//   child  → {type:"storeasy:ready"}              mounted (and the hello's answer)
//
// v2, the new editor, after parent → {type:"storeasy:editor:hello", v:2}:
//   child  → {type:"storeasy:ready", v:2, state, ok, reason?, unfinished}
//            state: what the layout says this frame shows (documents preview:
//            {kind, sid, docs:{[id]: draftHash}, offline, skipped, designShown});
//            ok false with reason "revoked" | "expired" | "not_found" (the
//            preview ended), "live" (no preview: the live store) or "legacy";
//            unfinished: the section ids marked [data-unfinished].
//   while v2 is on, every click on a link, every form submit and every submit
//   button is stopped in the capture phase (the founder is choosing, not
//   shopping), and every click inside the page posts a pick. The preview's own
//   bar ([data-preview-bar]: "See the live store", Exit, the colours toggle)
//   is the founder's, not the store's: it works as a bar, never picked.
//   child  → {type:"storeasy:pick", doc, sectionId, kind, field, offset}
//            from the closest [data-doc], [data-section-id] (its
//            data-section-kind) and [data-field] (inside that section).
//            offset: inside a rich text field ([data-field-type="rich_text"]),
//            the index of the block the click landed in; else null.
//   parent → {type:"storeasy:select", sectionId}  outline + scroll to it
//   parent → {type:"storeasy:refresh"}            keep the scroll and the
//            selection in sessionStorage, then reload; the next mount puts
//            them back. Storage that throws (private mode, blocked) only
//            loses the scroll, never the reload.

export const SELECTED_CLASS = "storeasy-selected";
export const DESIGNING_CLASS = "storeasy-designing";
export const EDITING_CLASS = "storeasy-editing";
export const RESTORE_KEY = "storeasy:frame:restore";

// The document a route shows, for data-doc on <main> and the offline line.
// routes: { "<path>": "<document id>" } from the layout (lib/content/resolve.js
// previewFrameRoutes). Product and collection pages are their layout
// documents. null when the page is not a document's (search, account, …).
const PREFIX_DOCS = [
  ["/products/", "doc_product_layout"],
  ["/collections/", "doc_collection_layout"],
];
export function routeDocFor(pathname, routes) {
  const raw = typeof pathname === "string" && pathname.startsWith("/") ? pathname : "/";
  const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  const map = routes && typeof routes === "object" ? routes : {};
  if (Object.hasOwn(map, path) && typeof map[path] === "string") return map[path];
  for (const [prefix, doc] of PREFIX_DOCS) if (path.startsWith(prefix) && path.length > prefix.length) return doc;
  return null;
}

const attrOf = (el, name) => (el && typeof el.getAttribute === "function" ? el.getAttribute(name) : null);
const closest = (el, sel) => (el && typeof el.closest === "function" ? el.closest(sel) : null);

function escapeAttr(win, v) {
  const s = String(v);
  try {
    if (win.CSS && typeof win.CSS.escape === "function") return win.CSS.escape(s);
  } catch {
    /* fall through */
  }
  return s.replace(/["\\]/g, "\\$&");
}

// A submit button: <button> with no type (inside a form it submits) or
// type="submit", and <input type="submit|image">.
function submitButtonOf(target) {
  const b = closest(target, "button, input");
  if (!b) return null;
  const tag = String(b.tagName || "").toLowerCase();
  const type = String(attrOf(b, "type") || (tag === "button" ? "submit" : "text")).toLowerCase();
  return type === "submit" || (tag === "input" && type === "image") ? b : null;
}

// What a click picked: the document, the section, the field and the block.
export function pickOf(target) {
  const docEl = closest(target, "[data-doc]");
  const secEl = closest(target, "[data-section-id]");
  if (!docEl && !secEl) return null;
  let fieldEl = closest(target, "[data-field]");
  if (fieldEl && secEl && typeof secEl.contains === "function" && !secEl.contains(fieldEl)) fieldEl = null;
  let offset = null;
  if (fieldEl && attrOf(fieldEl, "data-field-type") === "rich_text") {
    let n = target;
    while (n && n.parentElement && n.parentElement !== fieldEl) n = n.parentElement;
    if (n && n.parentElement === fieldEl) {
      const i = Array.prototype.indexOf.call(fieldEl.children || [], n);
      offset = i >= 0 ? i : null;
    }
  }
  return {
    type: "storeasy:pick",
    doc: attrOf(docEl, "data-doc") || null,
    sectionId: attrOf(secEl, "data-section-id") || null,
    kind: attrOf(secEl, "data-section-kind") || null,
    field: attrOf(fieldEl, "data-field") || null,
    offset,
  };
}

// Mount the bridge. Returns the function that takes it down again.
//   state, ok, reason  what the layout says this frame shows (see above)
//   css                the outline styles (PreviewBridge.js holds them)
export function createBridge({ window: win, document: doc, state = null, ok = false, reason = null, css = "" } = {}) {
  if (!win || !doc || !win.parent || win.parent === win) return () => {}; // not embedded: inert
  const origin = win.location?.origin;
  let v1 = false;
  let v2 = false;
  let selected = null;
  let style = null;

  const post = (msg) => {
    try {
      win.parent.postMessage(msg, origin);
    } catch {
      /* the parent went away */
    }
  };
  const addStyle = () => {
    if (style || !css) return;
    try {
      style = doc.createElement("style");
      style.textContent = css;
      doc.head.appendChild(style);
    } catch {
      style = null;
    }
  };
  const clearSelected = () => {
    for (const el of doc.querySelectorAll(`.${SELECTED_CLASS}`) || []) el.classList.remove(SELECTED_CLASS);
  };
  const outline = (selector, scroll) => {
    clearSelected();
    const el = doc.querySelector(selector);
    if (!el) return false;
    el.classList.add(SELECTED_CLASS);
    if (scroll && typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  };
  // v1: a [data-sec]
  const highlight = (id) => {
    if (!id) return clearSelected();
    outline(`[data-sec="${escapeAttr(win, id)}"]`, true);
  };
  // v2: a [data-section-id]
  const selectSection = (id, { scroll = true } = {}) => {
    selected = typeof id === "string" && id ? id : null;
    if (!selected) return clearSelected();
    outline(`[data-section-id="${escapeAttr(win, selected)}"]`, scroll);
  };

  const unfinished = () => {
    const ids = [];
    for (const el of doc.querySelectorAll("[data-unfinished]") || []) {
      const id = attrOf(el, "data-section-id");
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  };
  const ready = () => ({ type: "storeasy:ready", v: 2, state: state ?? null, ok: ok === true, ...(ok === true ? {} : { reason: reason || "live" }), unfinished: unfinished() });

  const inBar = (target) => Boolean(closest(target, "[data-preview-bar]"));

  const onClick = (e) => {
    const target = e.target;
    if (v2) {
      if (inBar(target)) return;
      if (closest(target, "a[href]") || submitButtonOf(target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      const pick = pickOf(target);
      if (pick) {
        if (pick.sectionId) selectSection(pick.sectionId, { scroll: false });
        post(pick);
      }
      return;
    }
    if (!v1) return;
    const sec = closest(target, "[data-sec]");
    if (!sec) return;
    // selecting, not shopping: swallow the navigation
    e.preventDefault();
    e.stopPropagation();
    highlight(attrOf(sec, "data-sec"));
    post({ type: "storeasy:sec:click", id: attrOf(sec, "data-sec") });
  };

  const onSubmit = (e) => {
    if (!v2 || inBar(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const keepPlace = () => {
    try {
      win.sessionStorage.setItem(RESTORE_KEY, JSON.stringify({ path: win.location.pathname, y: Number(win.scrollY) || 0, sectionId: selected }));
    } catch {
      /* storage blocked: the reload still happens, at the top */
    }
  };

  const onMessage = (e) => {
    if (e.origin !== origin) return; // same-origin console only
    const msg = e.data;
    if (msg === "storeasy:designer:hello") {
      v1 = true;
      addStyle();
      doc.body.classList.add(DESIGNING_CLASS);
      post({ type: "storeasy:ready" });
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "storeasy:editor:hello" && msg.v === 2) {
      v2 = true;
      addStyle();
      doc.body.classList.add(EDITING_CLASS);
      post(ready());
      return;
    }
    if (v2) {
      if (msg.type === "storeasy:select") selectSection(msg.sectionId);
      if (msg.type === "storeasy:refresh") {
        keepPlace();
        win.location.reload();
      }
      return;
    }
    if (!v1) return;
    if (msg.type === "storeasy:sec:highlight") highlight(msg.id);
    if (msg.type === "storeasy:refresh") win.location.reload();
  };

  // After a v2 refresh: the scroll and the selection come back, once.
  let saved = null;
  try {
    const raw = win.sessionStorage.getItem(RESTORE_KEY);
    if (raw) {
      win.sessionStorage.removeItem(RESTORE_KEY);
      saved = JSON.parse(raw);
    }
  } catch {
    saved = null;
  }
  if (saved && typeof saved === "object" && saved.path === win.location.pathname) {
    if (typeof saved.y === "number" && Number.isFinite(saved.y) && typeof win.scrollTo === "function") win.scrollTo(0, saved.y);
    if (typeof saved.sectionId === "string" && saved.sectionId) selectSection(saved.sectionId, { scroll: false });
  }

  win.addEventListener("message", onMessage);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("submit", onSubmit, true);
  // announce, in case the parent's hello raced the mount (v1 shape, as before)
  post({ type: "storeasy:ready" });
  return () => {
    win.removeEventListener("message", onMessage);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("submit", onSubmit, true);
    if (style) style.remove();
    doc.body.classList.remove(DESIGNING_CLASS);
    doc.body.classList.remove(EDITING_CLASS);
  };
}
