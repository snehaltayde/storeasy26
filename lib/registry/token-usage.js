// P3-DESIGN (TOK-03): which parts of the store use which design token group.
// Pure and edge-safe: data plus small functions, no imports.
//
// The design document's change rows (lib/documents/diff.js) come one per
// token group: "Colours: accent changed", "Fonts: text size changed",
// "Shapes: corners changed", "Spacing: space between sections changed",
// "Look: a different look chosen". The design publish panel shows, under each
// row, the live sections that use that group (lib/documents/changes.js
// listChanges, as `affects`).
//
//   TOKEN_GROUPS               colours, fonts, shapes, spacing, look
//   SECTION_TOKENS[kind]       the groups a section kind's renderer uses
//   CHROME_TOKENS[part]        the same for the header, footer and announcement
//                              bar, which show on every page
//   groupsOfRow(words)         the groups a diff row is about ("Brand: other
//                              settings changed" is about all of them)
//   affectsWords(groups, live) the `affects` rows, in plain words
//
// The map is kept by hand from the renderers in components/sections (and the
// layout's header, footer and announcement bar). scripts/test-design-doc.js
// fails when a registered section kind has no entry here.
//   colours   every part: background, text and accent (lib/brand.js ROLES)
//   fonts     every part: the text size scales all type (--type-scale)
//   shapes    parts with buttons, cards or rounded images (--btn-radius,
//             --brand-radius, --sf-radius-*)
//   spacing   parts padded by the section spacing (py-sf-section)
//   look      the theme kit's own surfaces: the header and the hero
//             (lib/brand.js KIT_SURFACES)

export const TOKEN_GROUPS = Object.freeze(["colours", "fonts", "shapes", "spacing", "look"]);

export const SECTION_TOKENS = Object.freeze({
  hero: Object.freeze(["colours", "fonts", "shapes", "look"]),
  collections: Object.freeze(["colours", "fonts", "shapes", "spacing"]),
  new: Object.freeze(["colours", "fonts", "shapes", "spacing"]),
  banner: Object.freeze(["colours", "fonts", "shapes", "spacing"]),
  rich_text: Object.freeze(["colours", "fonts", "spacing"]),
  image_with_text: Object.freeze(["colours", "fonts", "shapes", "spacing"]),
  product_rail: Object.freeze(["colours", "fonts", "shapes", "spacing"]),
  text: Object.freeze(["colours", "fonts", "spacing"]),
  faq: Object.freeze(["colours", "fonts", "spacing"]),
  product_main: Object.freeze(["colours", "fonts", "shapes"]),
});

export const CHROME_TOKENS = Object.freeze({
  header: Object.freeze(["colours", "fonts", "look"]),
  footer: Object.freeze(["colours", "fonts"]),
  announcement: Object.freeze(["colours", "fonts"]),
});

const CHROME_WORDS = { header: "header", footer: "footer", announcement: "announcement bar" };

// The first word of a design diff row names its group.
const ROW_GROUP = { Colours: "colours", Fonts: "fonts", Shapes: "shapes", Spacing: "spacing", Look: "look" };

export function groupsOfRow(words) {
  const head = String(words ?? "").split(":")[0].trim();
  const g = ROW_GROUP[head];
  return g ? [g] : [...TOKEN_GROUPS];
}

const uses = (tokens, groups) => Array.isArray(tokens) && groups.some((g) => tokens.includes(g));
const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// The most pages named one by one; the rest are counted.
export const AFFECTS_PAGE_CAP = 6;

// groups: token groups (from groupsOfRow).
// live: {
//   chrome: ["header", "footer", "announcement"]  the parts shoppers see now
//   pages:  [{ label, sections: [{ kind, label }] }] each live page with its
//           visible sections, in store order
// }
// -> [{ words }]: "Every page: header and footer", "Home page: Hero, Banner
//    and Product rail", "and 3 more pages". [] when nothing live uses them.
export function affectsWords(groups, live = {}) {
  const want = Array.isArray(groups) ? groups.filter((g) => TOKEN_GROUPS.includes(g)) : [];
  if (!want.length) return [];
  const out = [];
  const chrome = (Array.isArray(live.chrome) ? live.chrome : []).filter((p) => uses(CHROME_TOKENS[p], want)).map((p) => CHROME_WORDS[p]);
  if (chrome.length) out.push({ words: `Every page: ${andList(chrome)}` });
  const pages = [];
  for (const p of Array.isArray(live.pages) ? live.pages : []) {
    const labels = [];
    for (const s of Array.isArray(p?.sections) ? p.sections : []) {
      if (!uses(SECTION_TOKENS[s?.kind], want)) continue;
      const l = String(s.label || "Section");
      if (!labels.includes(l)) labels.push(l);
    }
    if (labels.length) pages.push(`${String(p.label || "A page")}: ${andList(labels)}`);
  }
  for (const words of pages.slice(0, AFFECTS_PAGE_CAP)) out.push({ words });
  const more = pages.length - AFFECTS_PAGE_CAP;
  if (more > 0) out.push({ words: `and ${more} more ${more === 1 ? "page" : "pages"}` });
  return out;
}
