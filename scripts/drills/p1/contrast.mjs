// In-page contrast audit for the TOK exit check: every visible text node and
// every icon on the page, measured from COMPUTED styles in Chrome (not from
// the token maths). Runs inside the page through page.evaluate.
//
// For each element that directly holds visible text (or is an <svg> icon):
//   fg     its computed `color`, alpha × the opacity of every ancestor
//   bg     the backgrounds of it and its ancestors composited from the top
//          down (a translucent panel over the page is blended, not skipped)
//   large  WCAG large text: ≥ 24px, or ≥ 18.66px at weight ≥ 700
//   need   4.5 for text, 3 for large text and for icons (non-text marks)
// Text over a photo or a gradient (an ancestor with a background-image, or
// an <img> painted under it) is reported apart as `overMedia`: its backdrop
// isn't one colour. Hidden, zero-size and visually-hidden (sr-only) elements
// are skipped; aria-hidden text is still measured (sighted shoppers see it).
export function auditInPage(rootSelector) {
  const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  const rgba = (s) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = s;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3]));
  const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      if (cs.position === "absolute" && cs.clip === "rect(0px, 0px, 0px, 0px)") return false; // sr-only
    }
    // off-canvas (a closed drawer slid out of the window)
    if (r.right <= 0 || r.left >= window.innerWidth) return false;
    return true;
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const backdrop = (el) => {
    const layers = [];
    let media = null;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none") media ||= `background-image on <${e.tagName.toLowerCase()} class="${(e.className?.baseVal ?? e.className ?? "").slice(0, 60)}">`;
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 0.999) break;
    }
    let bg = [255, 255, 255];
    for (const l of layers.reverse()) bg = over(l, bg);
    return { bg, media };
  };
  // An <img>/<svg> image painted under this text (a card title over a photo).
  const imageUnder = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 8);
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    return document.elementsFromPoint(x, y).some((u) => u !== el && u.tagName === "IMG" && !el.contains(u));
  };

  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  const out = [];
  if (!root) return out;
  const seen = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode; el; el = walker.nextNode()) {
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"].includes(el.tagName)) continue;
    const isIcon = el.tagName.toLowerCase() === "svg";
    const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").replace(/\s+/g, " ").trim();
    const isField = (el.tagName === "INPUT" && !["hidden", "radio", "checkbox", "color", "range", "file"].includes(el.type)) || el.tagName === "SELECT" || el.tagName === "TEXTAREA";
    const text = isField ? (el.value || el.placeholder || "").trim() : ownText;
    if (!isIcon && !text) continue;
    if (el.closest("svg") && !isIcon) continue;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    // inactive controls are exempt (WCAG 1.4.3): disabled buttons and fields
    const disabled = el.closest("button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled='true']") !== null;
    let fgRaw = rgba(isField && !el.value && el.placeholder ? getComputedStyle(el, "::placeholder").color : cs.color);
    if (isIcon) {
      const stroke = cs.stroke && cs.stroke !== "none" ? rgba(cs.stroke) : null;
      const fill = cs.fill && cs.fill !== "none" && !/url\(/.test(cs.fill) ? rgba(cs.fill) : null;
      fgRaw = stroke && stroke[3] > 0 ? stroke : fill || fgRaw;
    }
    const alpha = fgRaw[3] * opacityOf(el);
    const { bg, media } = backdrop(el);
    const fg = over([...fgRaw.slice(0, 3), alpha], bg);
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = !isIcon && (size >= 24 || (size >= 18.66 && weight >= 700));
    const need = isIcon || large ? 3 : 4.5;
    const r = Math.round(ratio(fg, bg) * 100) / 100;
    const overMedia = media || imageUnder(el) ? media || "an image under the text" : null;
    const label = isIcon ? `icon in <${el.parentElement?.tagName.toLowerCase()}${el.parentElement?.getAttribute("aria-label") ? ` "${el.parentElement.getAttribute("aria-label")}"` : ""}>` : text.slice(0, 60);
    const key = `${label}|${hex(fg)}|${hex(bg)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text: label,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className?.baseVal ?? el.className ?? "").slice(0, 120),
      fg: hex(fg),
      bg: hex(bg),
      ratio: r,
      size,
      weight,
      large,
      icon: isIcon,
      need,
      disabled,
      overMedia,
      pass: r >= need,
    });
  }
  return out;
}

export function audit(page, rootSelector = null) {
  return page.evaluate(auditInPage, rootSelector);
}
