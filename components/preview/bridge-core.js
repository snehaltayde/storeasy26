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
//   while v2 is on, every click on a link or a control (any button, add to
//   cart and wishlist included, inputs, selects, summaries, labels and
//   role=button elements) and every form submit is stopped in the capture
//   phase (the founder is choosing, not shopping), and every click inside the
//   page posts a pick, so a click on "Add to cart" selects its section and
//   adds nothing (P3-EDITOR, from the P3-FRAME review). The preview's own
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
//
// Look mode (Phase 1 line 6, onboarding's brand step), after parent →
// {type:"storeasy:editor:hello", v:2, look:true}: v2 as above (the same ready,
// clicks and submits still stopped), but no picks are posted, nothing is
// outlined, and body.storeasy-look hides the preview's own bar.
//   parent → {type:"storeasy:brand", paletteId, logo, description}
//            the founder's unsaved choices, drawn over the page until the
//            next load; nothing is written anywhere. Taken only after a v2
//            hello, only in a working preview (ok true), only from this
//            origin and from window.parent. Each field:
//              paletteId    a palette id: its colours (brandFor(id) → {css,
//                           kit}, worked out here, never sent) go into
//                           <style id="brand-vars-draft"> after #brand-vars,
//                           and data-kit on <html>; null: the page's own;
//                           an unknown id: ignored
//              logo         {media, alt}: a library picture (LOGO_RE) in the
//                           header and footer logo slots; false: no picture
//                           (the store name shows); null: the page's own;
//                           any other address: ignored
//              description  text (at most 160 characters, set as text) in
//                           [data-store-tagline]; null: the page's own
//            All three null: the page as it rendered.

export const SELECTED_CLASS = "storeasy-selected";
export const DESIGNING_CLASS = "storeasy-designing";
export const EDITING_CLASS = "storeasy-editing";
export const RESTORE_KEY = "storeasy:frame:restore";
export const LOOK_CLASS = "storeasy-look";
export const DRAFT_STYLE_ID = "brand-vars-draft";
export const LOGO_RE = /^\/api\/media\/[A-Za-z0-9_-]{1,120}$/;
export const TAGLINE_MAX = 160;

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

// A control the store would act on: links, every kind of button (a
// type="button" too: add to cart, wishlist, the cart drawer), form fields,
// <summary> and <label> (they toggle), and elements that act as buttons.
export const CONTROL_SELECTOR = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="switch"], [role="checkbox"], [role="tab"], [role="menuitem"]';
export const controlOf = (target) => closest(target, CONTROL_SELECTOR);

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
//   brandFor(id)       a palette's {css, kit}, or null (PreviewBridge.js)
export function createBridge({ window: win, document: doc, state = null, ok = false, reason = null, css = "", brandFor = () => null } = {}) {
  if (!win || !doc || !win.parent || win.parent === win) return () => {}; // not embedded: inert
  const origin = win.location?.origin;
  let v1 = false;
  let v2 = false;
  let look = false;
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
      if (controlOf(target) || submitButtonOf(target)) {
        e.preventDefault();
        e.stopPropagation();
      }
      const pick = look ? null : pickOf(target);
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

  // ---- look mode: the founder's unsaved brand choices ------------------------
  const kept = new Map(); // element -> its attributes and text as rendered
  const html = doc.documentElement || null;
  const keep = (el) => {
    if (!el || kept.has(el)) return;
    kept.set(el, { src: attrOf(el, "src"), alt: attrOf(el, "alt"), hidden: attrOf(el, "hidden"), text: el.textContent });
  };
  const setAttr = (el, name, v) => {
    if (v == null) el.removeAttribute(name);
    else el.setAttribute(name, v);
  };
  const restore = (el, { text = false } = {}) => {
    const k = kept.get(el);
    if (!k) return;
    if (String(el.tagName).toUpperCase() === "IMG") {
      setAttr(el, "src", k.src);
      setAttr(el, "alt", k.alt);
    }
    setAttr(el, "hidden", k.hidden);
    if (text) el.textContent = k.text;
  };
  const byId = (id) => (typeof doc.getElementById === "function" ? doc.getElementById(id) : null);
  let kitBefore;
  function applyPalette(id) {
    if (id === null) {
      byId(DRAFT_STYLE_ID)?.remove();
      if (html && kitBefore !== undefined) setAttr(html, "data-kit", kitBefore);
      return;
    }
    let b = null;
    try {
      b = typeof id === "string" ? brandFor(id) : null;
    } catch {
      b = null;
    }
    if (!b || typeof b.css !== "string") return; // unknown: ignored
    let el = byId(DRAFT_STYLE_ID);
    if (!el) {
      el = doc.createElement("style");
      el.setAttribute("id", DRAFT_STYLE_ID);
      const after = byId("brand-vars");
      if (after && typeof after.insertAdjacentElement === "function") after.insertAdjacentElement("afterend", el);
      else doc.head.appendChild(el);
    }
    el.textContent = b.css;
    if (html && typeof b.kit === "string" && b.kit) {
      if (kitBefore === undefined) kitBefore = attrOf(html, "data-kit");
      html.setAttribute("data-kit", b.kit);
    }
  }
  function applyLogo(logo) {
    const imgs = doc.querySelectorAll("[data-store-logo-img]") || [];
    const texts = doc.querySelectorAll("[data-store-logo-text]") || [];
    if (logo === null) {
      for (const el of [...imgs, ...texts]) restore(el);
      return;
    }
    if (logo === false) {
      for (const el of imgs) (keep(el), el.setAttribute("hidden", ""));
      for (const el of texts) (keep(el), el.removeAttribute("hidden"));
      return;
    }
    if (!logo || typeof logo !== "object" || typeof logo.media !== "string" || !LOGO_RE.test(logo.media)) return; // ignored
    const alt = typeof logo.alt === "string" ? logo.alt.slice(0, 300) : "";
    for (const el of imgs) {
      keep(el);
      el.setAttribute("src", logo.media);
      el.setAttribute("alt", alt);
      el.removeAttribute("hidden");
    }
    for (const el of texts) (keep(el), el.setAttribute("hidden", ""));
  }
  function applyDescription(text) {
    for (const el of doc.querySelectorAll("[data-store-tagline]") || []) {
      if (text === null) {
        restore(el, { text: true });
        continue;
      }
      if (typeof text !== "string") continue;
      keep(el);
      const line = text.replace(/[\r\n]+/g, " ").trim().slice(0, TAGLINE_MAX);
      el.textContent = line;
      if (line) el.removeAttribute("hidden");
      else el.setAttribute("hidden", "");
    }
  }
  function applyBrand(msg) {
    if (msg.paletteId !== undefined) applyPalette(msg.paletteId);
    if (msg.logo !== undefined) applyLogo(msg.logo);
    if (msg.description !== undefined) applyDescription(msg.description);
  }

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
      look = msg.look === true;
      addStyle();
      doc.body.classList.add(look ? LOOK_CLASS : EDITING_CLASS);
      doc.body.classList.remove(look ? EDITING_CLASS : LOOK_CLASS);
      post(ready());
      return;
    }
    if (v2) {
      if (msg.type === "storeasy:brand") {
        if (ok === true && e.source === win.parent) applyBrand(msg);
        return;
      }
      if (msg.type === "storeasy:select" && !look) selectSection(msg.sectionId);
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
    doc.body.classList.remove(LOOK_CLASS);
  };
}
