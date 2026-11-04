// P3-DIFF (PUB-09, PUB-04, PUB-03, TOK-03): what changed between two bodies of
// one document, in plain words. Pure and edge-safe: no database, no node:
// imports, no Node globals. Used by P3-CHANGES (listChanges), P3-UNDO (the
// dry run and the Recently published summaries) and the publish-both review.
//
//   diffBodies(type, fromBody, toBody)
//     -> [{ kind, sectionId?, words }]
//        kind is one of added, removed, edited, moved, hidden, shown, meta,
//        settings. sectionId is the section's id in toBody (in fromBody for a
//        removed section). Rows come in this order: meta, document settings,
//        then sections top to bottom as toBody has them, then removed sections.
//   firstPublishRows(type, body)
//     -> [{ words }]: what will go live on a first publish. The title of a
//        page with an address, then one row per visible section. A type with
//        no sections gives one row naming it.
//
// Rules the words keep:
//   - Bodies whose id-stripped canonical form is equal give []. That is the
//     same test as equal documentHash (lib/registry/body.js hashes exactly
//     this string), done without hashing so the function stays synchronous.
//   - Sections are matched by id first. Sections left over are paired by kind
//     plus their id-stripped content, so ids stamped lazily on a migrated body
//     never show as changes. Then a section with no usable id on one side
//     pairs with the next unmatched section of the same kind on the other
//     side, so an edit to a migrated section that never had an id reads as an
//     edit, not as "removed" plus "added".
//   - Fields are named by their registry labels ("Banner: button text
//     changed"). Inside a list, the words count items ("Text: a paragraph
//     changed", "FAQ: a question added").
//   - The address is "web address". No row carries an id, a hash, or the words
//     slug, handle, CTA or href, and no row quotes founder text, except the
//     page title in firstPublishRows.
//   - The design document gives one row per changed token group
//     ("Colours: accent changed", "Fonts: text size changed").
import { documentType, sectionType, stripIds, stableStringify, upgradeBody, SECTION_ID_RE } from "../registry/index.js";
import { isEmptySetting } from "../registry/settings.js";
import { DEFAULT_BRAND } from "../brand.js";

export const DIFF_KINDS = Object.freeze(["added", "removed", "edited", "moved", "hidden", "shown", "meta", "settings"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => stableStringify(a) === stableStringify(b);
const lower = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const canonical = (body) => stableStringify(stripIds(body));

// ---- phrases ------------------------------------------------------------------------
//
// A phrase is { noun, verb } ("title", "changed") or { text } (a whole phrase).
// Nouns that share a verb are joined: "title and subtitle changed".

const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function joinPhrases(phrases) {
  const parts = [];
  const byVerb = new Map();
  for (const p of phrases) {
    if (p.text) {
      parts.push({ text: p.text });
      continue;
    }
    let group = byVerb.get(p.verb);
    if (!group) {
      group = { verb: p.verb, nouns: [] };
      byVerb.set(p.verb, group);
      parts.push(group);
    }
    if (!group.nouns.includes(p.noun)) group.nouns.push(p.noun);
  }
  return parts.map((g) => (g.text ? g.text : `${andList(g.nouns)} ${g.verb}`)).join(", ");
}

const article = (noun) => (/^[aeiou]/i.test(noun) ? "an" : "a");
const PLURALS = { entry: "entries" };
const counted = (n, noun) => (n === 1 ? `${article(noun)} ${noun}` : `${n} ${PLURALS[noun] || `${noun}s`}`);

// added / removed / changed, from whether each side is empty
function presence(fromEmpty, toEmpty) {
  if (fromEmpty && !toEmpty) return "added";
  if (!fromEmpty && toEmpty) return "removed";
  return "changed";
}

// ---- lists ----------------------------------------------------------------------------

const ITEM_NOUNS = { paragraphs: "paragraph", qa_list: "question", nav_items: "menu item", collection_list: "collection", product_list: "product", entries: "entry" };
// Lists that sit side by side on one document (the collections page has three)
// say which list: "a collection added to featured collections".
const NAMED_LISTS = new Set(["collection_list", "product_list"]);

function listPhrases(s, a, b) {
  const from = Array.isArray(a) ? a : [];
  const to = Array.isArray(b) ? b : [];
  const noun = ITEM_NOUNS[s.kind] || "item";
  const label = lower(s.label);
  const keyed = (xs) => xs.map((x) => stableStringify(x));
  const fk = keyed(from);
  const tk = keyed(to);
  if (fk.length === tk.length && fk.length > 1 && [...fk].sort().join("\n") === [...tk].sort().join("\n")) return [{ noun: label, verb: "reordered" }];
  let start = 0;
  while (start < fk.length && start < tk.length && fk[start] === tk[start]) start++;
  let endF = fk.length;
  let endT = tk.length;
  while (endF > start && endT > start && fk[endF - 1] === tk[endT - 1]) {
    endF--;
    endT--;
  }
  const midF = from.slice(start, endF);
  const midT = to.slice(start, endT);
  const changedPairs = Math.min(midF.length, midT.length);
  const added = midT.length - changedPairs;
  const removed = midF.length - changedPairs;
  const where = (verb) => (NAMED_LISTS.has(s.kind) ? `${verb} ${verb === "added" ? "to" : verb === "removed" ? "from" : "in"} ${label}` : verb);
  const out = [];
  if (changedPairs) {
    if (s.kind === "qa_list") {
      let q = 0;
      let ans = 0;
      for (let j = 0; j < changedPairs; j++) {
        const x = isObj(midF[j]) ? midF[j] : {};
        const y = isObj(midT[j]) ? midT[j] : {};
        const qDiff = !same(x.q, y.q);
        const aDiff = !same(x.a, y.a);
        if (qDiff || !aDiff) q++;
        if (aDiff) ans++;
      }
      if (q) out.push({ noun: counted(q, "question"), verb: "changed" });
      if (ans) out.push({ noun: counted(ans, "answer"), verb: "changed" });
    } else out.push({ noun: counted(changedPairs, noun), verb: where("changed") });
  }
  if (added) out.push({ noun: counted(added, noun), verb: where("added") });
  if (removed) out.push({ noun: counted(removed, noun), verb: where("removed") });
  return out.length ? out : [{ noun: label, verb: "changed" }];
}

// ---- one setting ----------------------------------------------------------------------

function emptyOf(s, v) {
  try {
    return isEmptySetting(s, v);
  } catch {
    return v == null;
  }
}

function settingPhrases(s, a, b) {
  if (same(a, b)) return [];
  const label = lower(s.label);
  switch (s.kind) {
    case "boolean":
      if (s.key === "enabled") return [{ text: b === true ? "switched on" : "switched off" }];
      return [{ noun: label, verb: b === true ? "turned on" : "turned off" }];
    case "paragraphs":
    case "qa_list":
    case "nav_items":
    case "collection_list":
    case "product_list":
    case "entries":
      return listPhrases(s, a, b);
    case "cta": {
      const x = isObj(a) ? a : null;
      const y = isObj(b) ? b : null;
      if (!x || !y) return [{ noun: label, verb: presence(!x, !y) }];
      const out = [];
      if (!same(x.label, y.label)) out.push({ noun: `${label} text`, verb: presence(emptyOf({ kind: "text" }, x.label), emptyOf({ kind: "text" }, y.label)) });
      if (!same(x.link, y.link)) out.push({ noun: `${label} link`, verb: presence(x.link == null, y.link == null) });
      return out.length ? out : [{ noun: label, verb: "changed" }];
    }
    case "image": {
      const fromEmpty = emptyOf(s, a);
      const toEmpty = emptyOf(s, b);
      if (fromEmpty || toEmpty) return [{ noun: label, verb: presence(fromEmpty, toEmpty) }];
      const out = [];
      if (!same(a.media, b.media)) out.push({ noun: label, verb: "changed" });
      if (!same(a.alt, b.alt)) out.push({ noun: `${label} description`, verb: "changed" });
      return out.length ? out : [{ noun: label, verb: "changed" }];
    }
    default:
      return [{ noun: label, verb: presence(emptyOf(s, a), emptyOf(s, b)) }];
  }
}

// Settings no declaration names: one plain phrase, never the key.
function settingsPhrases(declared, a, b) {
  const x = isObj(a) ? a : {};
  const y = isObj(b) ? b : {};
  const out = [];
  const keys = new Set(declared.map((s) => s.key));
  for (const s of declared) out.push(...settingPhrases(s, x[s.key], y[s.key]));
  const extra = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !keys.has(k));
  if (extra.some((k) => !same(x[k], y[k]))) out.push({ noun: "other settings", verb: "changed" });
  return out;
}

// ---- the design document (TOK-03) -----------------------------------------------------

const TOKEN_GROUPS = [
  ["Colours", { accent: "accent", background: "background", foreground: "text colour", accent_label: "text on accent" }],
  ["Fonts", { type_scale: "text size" }],
  ["Shapes", { radius: "corners", button_shape: "button shape" }],
  ["Spacing", { section_spacing: "space between sections" }],
];
const TOKEN_KEYS = new Set(TOKEN_GROUPS.flatMap(([, words]) => Object.keys(words)));

function brandRows(a, b) {
  // A brand left unset renders with the platform default, so compare what
  // each side would render with. accent_label is derived from the accent; it
  // counts only when both sides hold one.
  const x = { ...DEFAULT_BRAND, ...(isObj(a) ? a : {}) };
  const y = { ...DEFAULT_BRAND, ...(isObj(b) ? b : {}) };
  const rows = [];
  for (const [group, words] of TOKEN_GROUPS) {
    const changed = Object.keys(words).filter((k) => {
      if (k === "accent_label" && !(Object.hasOwn(x, k) && Object.hasOwn(y, k))) return false;
      return !same(x[k], y[k]);
    });
    if (changed.length) rows.push({ kind: "settings", words: `${group}: ${andList(changed.map((k) => words[k]))} changed` });
  }
  const extra = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !TOKEN_KEYS.has(k));
  if (extra.some((k) => !same(x[k], y[k]))) rows.push({ kind: "settings", words: "Brand: other settings changed" });
  return rows;
}

function themeRows(a, b) {
  if (same(a, b)) return [];
  const x = isObj(a) ? a : null;
  const y = isObj(b) ? b : null;
  if (!x) return [{ kind: "settings", words: "Look: chosen" }];
  if (!y) return [{ kind: "settings", words: "Look: back to the standard look" }];
  if (same(x.kit, y.kit) && same(x.version, y.version)) return [{ kind: "settings", words: "Look: applied again" }];
  return [{ kind: "settings", words: "Look: a different look chosen" }];
}

// ---- document settings and meta -------------------------------------------------------

function documentSettingRows(t, a, b) {
  const x = isObj(a) ? a : {};
  const y = isObj(b) ? b : {};
  const rows = [];
  const keys = new Set(t.settings.map((s) => s.key));
  for (const s of t.settings) {
    if (s.kind === "brand") {
      if (!same(x[s.key], y[s.key])) rows.push(...brandRows(x[s.key], y[s.key]));
      continue;
    }
    if (s.kind === "theme") {
      rows.push(...themeRows(x[s.key], y[s.key]));
      continue;
    }
    const phrases = settingPhrases(s, x[s.key], y[s.key]);
    if (phrases.length) rows.push({ kind: "settings", words: `${t.label}: ${joinPhrases(phrases)}` });
  }
  const extra = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !keys.has(k));
  if (extra.some((k) => !same(x[k], y[k]))) rows.push({ kind: "settings", words: `${t.label}: other settings changed` });
  return rows;
}

const blank = (v) => v == null || (typeof v === "string" && !v.trim());

function metaRows(t, a, b) {
  const x = isObj(a) ? a : {};
  const y = isObj(b) ? b : {};
  const rows = [];
  const row = (words) => rows.push({ kind: "meta", words });
  const field = (k, name) => {
    if (same(x[k], y[k])) return;
    row(`${name} ${presence(blank(x[k]), blank(y[k]))}`);
  };
  field("slug", "Web address");
  field("title", `${t.label} title`);
  field("description", "Search description");
  if (!same(x.enabled, y.enabled) && (x.enabled === false) !== (y.enabled === false)) {
    row(y.enabled === false ? `${t.label} switched off, so shoppers won't see it` : `${t.label} switched on, so shoppers can see it`);
  }
  field("effective_at", "Effective date");
  const dates = [];
  if (!same(x.window_start, y.window_start)) dates.push({ noun: "start date", verb: presence(blank(x.window_start), blank(y.window_start)) });
  if (!same(x.window_end, y.window_end)) dates.push({ noun: "end date", verb: presence(blank(x.window_end), blank(y.window_end)) });
  if (dates.length) row(`Showing dates: ${joinPhrases(dates)}`);
  if (!same(x.redirect_from, y.redirect_from)) {
    const from = new Set((Array.isArray(x.redirect_from) ? x.redirect_from : []).map(stableStringify));
    const to = new Set((Array.isArray(y.redirect_from) ? y.redirect_from : []).map(stableStringify));
    const added = [...to].filter((r) => !from.has(r)).length;
    const removed = [...from].filter((r) => !to.has(r)).length;
    const parts = [];
    if (added) parts.push(`${counted(added, "old address")} added`);
    if (removed) parts.push(`${counted(removed, "old address")} removed`);
    row(`Old addresses that lead here: ${parts.length ? parts.join(", ") : "reordered"}`);
  }
  const known = new Set(["slug", "title", "description", "enabled", "effective_at", "window_start", "window_end", "redirect_from"]);
  const extra = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !known.has(k));
  if (extra.some((k) => !same(x[k], y[k]))) row("Other page details changed");
  return rows;
}

// ---- sections -------------------------------------------------------------------------

const SECTION_KNOWN = new Set(["id", "kind", "v", "enabled", "settings", "mobile", "show", "bindings", "blocks"]);
const validId = (s) => (isObj(s) && typeof s.id === "string" && SECTION_ID_RE.test(s.id) ? s.id : null);
const sectionCanonical = (s) => (isObj(s) ? stableStringify(stripIds({ sections: [s] }).sections[0]) : stableStringify(s));
const isShown = (s) => !isObj(s) || s.enabled !== false;

// "Banner", or "Banner 2" when the body holds more than one banner.
function sectionName(list, index) {
  const s = list[index];
  const d = sectionType(isObj(s) ? s.kind : null);
  const label = d ? d.label : "Section";
  const kind = isObj(s) ? s.kind : undefined;
  const sameKind = list.map((x, i) => [x, i]).filter(([x]) => (isObj(x) ? x.kind : undefined) === kind);
  if (sameKind.length < 2) return label;
  return `${label} ${sameKind.findIndex(([, i]) => i === index) + 1}`;
}

// Pairs the sections of two lists: [[fromIndex, toIndex]].
function matchSections(from, to) {
  const pairs = [];
  const usedF = new Set();
  const usedT = new Set();
  const take = (i, j) => {
    pairs.push([i, j]);
    usedF.add(i);
    usedT.add(j);
  };
  // 1. by id
  const fromById = new Map();
  from.forEach((s, i) => {
    const id = validId(s);
    if (id && !fromById.has(id)) fromById.set(id, i);
  });
  to.forEach((s, j) => {
    const id = validId(s);
    const i = id ? fromById.get(id) : undefined;
    if (i !== undefined && !usedF.has(i) && isObj(from[i]) && from[i].kind === s.kind) take(i, j);
  });
  // 2. by kind plus id-stripped content
  const fc = from.map(sectionCanonical);
  to.forEach((s, j) => {
    if (usedT.has(j)) return;
    const c = sectionCanonical(s);
    const i = fc.findIndex((x, k) => !usedF.has(k) && x === c);
    if (i >= 0) take(i, j);
  });
  // 3. a section with no usable id on either side pairs with the next
  //    unmatched one of the same kind on the other side
  to.forEach((s, j) => {
    if (usedT.has(j) || !isObj(s)) return;
    const i = from.findIndex((x, k) => !usedF.has(k) && isObj(x) && x.kind === s.kind && (!validId(x) || !validId(s)));
    if (i >= 0) take(i, j);
  });
  return pairs.sort((p, q) => p[1] - q[1]);
}

// The pairs whose order changed: those outside one longest run that kept its
// order. A swap of two sections moves one of them, not both.
function movedPairs(pairs) {
  const seq = pairs.map(([i]) => i);
  const n = seq.length;
  const len = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    for (let m = 0; m < k; m++) {
      if (seq[m] < seq[k] && len[m] + 1 > len[k]) {
        len[k] = len[m] + 1;
        prev[k] = m;
      }
    }
  }
  let best = -1;
  for (let k = 0; k < n; k++) if (best < 0 || len[k] > len[best]) best = k;
  const keep = new Set();
  for (let k = best; k >= 0; k = prev[k]) keep.add(k);
  const fromRank = new Map([...seq].sort((p, q) => p - q).map((i, r) => [i, r]));
  const out = new Map();
  pairs.forEach(([i], k) => {
    if (keep.has(k)) return;
    const r = fromRank.get(i);
    out.set(k, k < r ? "moved up" : k > r ? "moved down" : "moved");
  });
  return out;
}

function sectionEditPhrases(a, b) {
  const d = sectionType(b.kind);
  const out = [];
  if (d) out.push(...settingsPhrases(d.settings, a.settings, b.settings));
  else if (!same(a.settings, b.settings)) out.push({ noun: "settings", verb: "changed" });
  if (!same(a.show, b.show)) {
    const x = isObj(a.show) ? a.show : {};
    const y = isObj(b.show) ? b.show : {};
    for (const [k, screen] of [["mobile", "phones"], ["desktop", "computers"]]) {
      if ((x[k] === false) !== (y[k] === false)) out.push({ text: y[k] === false ? `now hidden on ${screen}` : `now shown on ${screen}` });
    }
  }
  if (!same(a.mobile, b.mobile)) out.push({ noun: "phone settings", verb: "changed" });
  if (!same(a.bindings, b.bindings)) out.push({ noun: "the products or collections it shows", verb: "changed" });
  if (!same(stripIds({ sections: [{ blocks: a.blocks }] }), stripIds({ sections: [{ blocks: b.blocks }] }))) out.push({ noun: "its parts", verb: "changed" });
  if (!same(a.v, b.v)) out.push({ text: "brought up to date" });
  const extra = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !SECTION_KNOWN.has(k));
  if (extra.some((k) => !same(a[k], b[k]))) out.push({ noun: "other details", verb: "changed" });
  return out;
}

function sectionRows(fromList, toList) {
  const pairs = matchSections(fromList, toList);
  const moved = movedPairs(pairs);
  const byTo = new Map(pairs.map(([i, j], k) => [j, { i, k }]));
  const matchedFrom = new Set(pairs.map(([i]) => i));
  const rows = [];
  toList.forEach((s, j) => {
    const name = sectionName(toList, j);
    const sectionId = validId(s);
    const row = (kind, words) => rows.push(sectionId ? { kind, sectionId, words } : { kind, words });
    const m = byTo.get(j);
    if (!m) {
      row("added", `${name}: added${isShown(s) ? "" : ", hidden"}`);
      return;
    }
    const a = fromList[m.i];
    if (isShown(a) !== isShown(s)) row(isShown(s) ? "shown" : "hidden", `${name}: ${isShown(s) ? "shown" : "hidden"}`);
    if (moved.has(m.k)) row("moved", `${name}: ${moved.get(m.k)}`);
    if (isObj(a) && isObj(s)) {
      const phrases = sectionEditPhrases(a, s);
      if (phrases.length) row("edited", `${name}: ${joinPhrases(phrases)}`);
    } else if (!same(a, s)) row("edited", `${name}: changed`);
  });
  fromList.forEach((s, i) => {
    if (matchedFrom.has(i)) return;
    const sectionId = validId(s);
    const words = `${sectionName(fromList, i)}: removed`;
    rows.push(sectionId ? { kind: "removed", sectionId, words } : { kind: "removed", words });
  });
  return rows;
}

// ---- the two exports ------------------------------------------------------------------

const GENERIC_TYPE = Object.freeze({ type: null, label: "Settings", noun: "this document", route: false, sections: true, settings: Object.freeze([]) });
const typeOf = (type, ...bodies) => documentType(type) || documentType(bodies.find(isObj)?.type) || GENERIC_TYPE;

export function diffBodies(type, fromBody, toBody) {
  const a = upgradeBody(isObj(fromBody) ? fromBody : {});
  const b = upgradeBody(isObj(toBody) ? toBody : {});
  if (canonical(a) === canonical(b)) return [];
  const t = typeOf(type, toBody, fromBody);
  const rows = [];
  if (t.route || isObj(a.meta) || isObj(b.meta)) {
    if (!same(a.meta, b.meta)) rows.push(...metaRows(t, a.meta, b.meta));
  }
  if (!same(a.settings, b.settings)) rows.push(...documentSettingRows(t, a.settings, b.settings));
  // Sections that differ only by ids pair by content and give no row.
  if (Array.isArray(a.sections) || Array.isArray(b.sections)) rows.push(...sectionRows(Array.isArray(a.sections) ? a.sections : [], Array.isArray(b.sections) ? b.sections : []));
  // The bodies differ but nothing above names how (a body-level field no
  // declaration covers). Never answer "no changes" for a body that changed.
  if (!rows.length) rows.push({ kind: "settings", words: `${t.label}: some details changed` });
  return rows;
}

const TITLE_MAX = 60;
const quoteTitle = (s) => `"${s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX).trimEnd()}…` : s}"`;

export function firstPublishRows(type, body) {
  const b = upgradeBody(isObj(body) ? body : {});
  const t = typeOf(type, body);
  const rows = [];
  if (t.route && isObj(b.meta) && typeof b.meta.title === "string" && b.meta.title.trim()) rows.push({ words: `${t.label} title: ${quoteTitle(b.meta.title.trim())}` });
  if (t.sections && Array.isArray(b.sections)) {
    const list = b.sections;
    list.forEach((s, i) => {
      if (isShown(s)) rows.push({ words: sectionName(list, i) });
    });
  } else if (!t.sections) rows.push({ words: t.label });
  return rows;
}

// for the tests: the words each piece uses
export const __diffInternals = { TOKEN_GROUPS, ITEM_NOUNS, matchSections, movedPairs, joinPhrases };
