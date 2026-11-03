// P2-REG (DOC-01, DOC-03): ids, hashing and upgrades of a document body.
// Pure and edge-safe: Web Crypto only.
//
//   ensureIds(body)        every section gets a sec_ id and every block a blk_
//                          id: valid, unique incoming ids are kept, the rest
//                          minted. The client mints at add time (spec 8.5);
//                          this is the server's safety net at save.
//   stripIds(body)         a copy with every section and block id removed
//   documentHash(body)     sha256 of the canonical, id-stripped body, so two
//                          bodies that differ only in their ids hash the same
//   upgradeBody(body)      runs each section's pure `migrate` steps up to its
//                          kind's current version. Unknown kinds, missing steps
//                          and sections already current are left as they are;
//                          validation reports what is still out of date.
import { sectionType } from "./index.js";

export const SECTION_ID_RE = /^sec_[a-z0-9]{2,16}$/;
export const BLOCK_ID_RE = /^blk_[a-z0-9]{2,16}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const mintSectionId = () => `sec_${hex(crypto.getRandomValues(new Uint8Array(4)))}`;
export const mintBlockId = () => `blk_${hex(crypto.getRandomValues(new Uint8Array(4)))}`;

function stampList(list, re, mint, seen) {
  return list.map((item) => {
    if (!isObj(item)) return item;
    let id = typeof item.id === "string" && re.test(item.id) && !seen.has(item.id) ? item.id : null;
    while (!id || seen.has(id)) id = mint();
    seen.add(id);
    const out = { ...item, id };
    if (Array.isArray(item.blocks)) out.blocks = stampList(item.blocks, BLOCK_ID_RE, mintBlockId, seen);
    return out;
  });
}

export function ensureIds(body) {
  if (!isObj(body) || !Array.isArray(body.sections)) return body;
  return { ...body, sections: stampList(body.sections, SECTION_ID_RE, mintSectionId, new Set()) };
}

function stripList(list) {
  return list.map((item) => {
    if (!isObj(item)) return item;
    const { id: _id, ...rest } = item;
    if (Array.isArray(rest.blocks)) rest.blocks = stripList(rest.blocks);
    return rest;
  });
}

export function stripIds(body) {
  if (!isObj(body) || !Array.isArray(body.sections)) return body;
  return { ...body, sections: stripList(body.sections) };
}

// The canonical form of lib/releases.js (sorted keys, no spaces), except that
// a key holding undefined is left out, as JSON.stringify does.
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export async function documentHash(body) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(stripIds(body))));
  return hex(new Uint8Array(digest));
}

export function upgradeBody(body) {
  if (!isObj(body) || !Array.isArray(body.sections)) return body;
  let changed = false;
  const sections = body.sections.map((s) => {
    const d = isObj(s) ? sectionType(s.kind) : null;
    if (!d || !Number.isInteger(s.v) || s.v >= d.version) return s;
    let cur = s;
    while (cur.v < d.version && d.migrate[cur.v]) {
      const next = d.migrate[cur.v](cur);
      cur = { ...next, v: cur.v + 1 };
    }
    changed = changed || cur !== s;
    return cur;
  });
  return changed ? { ...body, sections } : body;
}
