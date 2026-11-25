// P7-FACETS (docs/plans/phase-7.md line 2, decisions 3, 7, 8, 12): search
// filters. Edge-safe: Kysely over lib/db.js, no node: imports.
//
//   parseFacetParams(searchParams) -> the validated filter state (the only
//                                     input any query below takes)
//   facetHref(state, patch)        -> a /search link for that state
//   toggled(state, group, value)   -> the state with one value on or off
//   activeCount(state)             -> how many filters are on ("Filters (3)")
//   typesenseFilter(state, opts)   -> Typesense filter_by, every value in backticks
//   facetSearchDb(state)           -> the SQL engine: results, total and counts
//   shapeFacets(state, counts)     -> the groups the page shows (both engines)
//
// Rules: OR within a group, AND across groups; a group's counts use every
// filter except its own (disjunctive). Values and counts come only from this
// store's products table (active products only) and their EFFECTIVE published
// values: display_type and display_vendor, never a draft. Shopify's tags are
// never a facet (logic tags can be internal). Option facets are product-level
// (`size:M` with the name lowercased); with "In stock" on, only in-stock
// variants' values count and match.
import { sql } from "kysely";
import { db } from "../db.js";
import { readEffective, effectiveExpr, searchTerms, optionName, OPTION_SPACE } from "./effective.js";

export const PER_PAGE = 24;
export const MAX_VALUES = 20; // per group
export const MAX_OPTION_GROUPS = 6;
// selected type, brand and option groups together: each needs its own
// Typesense count query, and one multi_search holds at most 7 (decision 7)
export const MAX_SELECTED_GROUPS = 6;
export const MAX_VALUE_CHARS = 80;
export const MAX_PAGE = 100;
export const SHOWN_VALUES = 8; // "Show all" past this
export const SORTS = Object.freeze(["relevance", "price-asc", "price-desc", "new"]);

const all = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
// backticks, backslashes and control characters out, trimmed, capped
export function cleanValue(v) {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return v.replace(/[`\\\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_VALUE_CHARS).trim();
}
const cleanList = (v) => {
  const out = [];
  for (const x of all(v).slice(0, 200)) {
    const c = cleanValue(x);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= MAX_VALUES) break;
  }
  return out;
};
const money = (v) => {
  if (typeof v !== "string" || !/^\s*\d+(\.\d+)?\s*$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null;
};
const one = (v) => (Array.isArray(v) ? v[0] : v);

// The filter state from the page's searchParams (strings or string arrays).
// Anything else (unknown keys, bad numbers, too many values) is dropped here,
// so no query ever sees a raw value. Unknown values stay and match nothing.
export function parseFacetParams(sp = {}) {
  const q = cleanValue(typeof one(sp.q) === "string" ? one(sp.q).slice(0, 200) : "");
  const types = cleanList(sp.type);
  const vendors = cleanList(sp.vendor);
  let room = MAX_SELECTED_GROUPS - (types.length ? 1 : 0) - (vendors.length ? 1 : 0);
  const groups = new Map();
  for (const raw of all(sp.o).slice(0, 200)) {
    if (typeof raw !== "string") continue;
    const at = raw.indexOf(":");
    if (at <= 0) continue;
    const name = optionName(cleanValue(raw.slice(0, at)));
    const value = cleanValue(raw.slice(at + 1));
    if (!name || !value) continue;
    if (!groups.has(name)) {
      if (groups.size >= Math.min(MAX_OPTION_GROUPS, room)) continue;
      groups.set(name, []);
    }
    const list = groups.get(name);
    if (!list.includes(value) && list.length < MAX_VALUES) list.push(value);
  }
  room -= groups.size;
  let min = money(one(sp.min));
  let max = money(one(sp.max));
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const sort = SORTS.includes(one(sp.sort)) ? one(sp.sort) : "relevance";
  const page = /^\d{1,3}$/.test(String(one(sp.page) ?? "")) ? Math.min(Math.max(1, Number(one(sp.page))), MAX_PAGE) : 1;
  return {
    q,
    types,
    vendors,
    options: [...groups].map(([name, values]) => ({ name, values })),
    min,
    max,
    instock: one(sp.instock) === "1",
    sort,
    page,
  };
}

export const activeCount = (s) => s.types.length + s.vendors.length + s.options.reduce((n, g) => n + g.values.length, 0) + (s.min != null || s.max != null ? 1 : 0) + (s.instock ? 1 : 0);

// The state as query parameters, in one fixed order.
export function facetParams(s) {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  for (const v of s.types) p.append("type", v);
  for (const v of s.vendors) p.append("vendor", v);
  for (const g of s.options) for (const v of g.values) p.append("o", `${g.name}:${v}`);
  if (s.min != null) p.set("min", String(s.min));
  if (s.max != null) p.set("max", String(s.max));
  if (s.instock) p.set("instock", "1");
  if (s.sort && s.sort !== "relevance") p.set("sort", s.sort);
  if (s.page > 1) p.set("page", String(s.page));
  return p;
}

// A link to this state with `patch` applied; the page goes back to 1 unless
// the patch names one.
export function facetHref(s, patch = {}) {
  const qs = facetParams({ ...s, page: 1, ...patch }).toString();
  return qs ? `/search?${qs}` : "/search";
}

// group: "type" | "vendor" | "o:<name>"
export function toggled(s, group, value) {
  const flip = (list) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  if (group === "type") return { ...s, types: flip(s.types) };
  if (group === "vendor") return { ...s, vendors: flip(s.vendors) };
  const name = group.slice(2);
  const has = s.options.some((g) => g.name === name);
  const options = has ? s.options.map((g) => (g.name === name ? { name, values: flip(g.values) } : g)) : [...s.options, { name, values: [value] }];
  return { ...s, options: options.filter((g) => g.values.length) };
}

export const clearedFilters = (s) => ({ ...s, types: [], vendors: [], options: [], min: null, max: null, instock: false });

// ---- Typesense ------------------------------------------------------------------------

const tick = (v) => `\`${cleanValue(v)}\``;
const list = (field, values) => `${field}:=[${values.map(tick).join(", ")}]`;
export const optionField = (s) => (s.instock ? "options_available" : "options");

// filter_by for this state; `exclude` leaves one group out ("type", "vendor"
// or "o:<name>") for that group's own counts. "" when nothing is on.
export function typesenseFilter(s, { exclude = null } = {}) {
  const parts = [];
  if (s.types.length && exclude !== "type") parts.push(list("product_type", s.types));
  if (s.vendors.length && exclude !== "vendor") parts.push(list("vendor", s.vendors));
  for (const g of s.options) if (exclude !== `o:${g.name}`) parts.push(list(optionField(s), g.values.map((v) => `${g.name}:${v}`)));
  if (s.min != null) parts.push(`price:>=${Number(s.min)}`);
  if (s.max != null) parts.push(`price:<=${Number(s.max)}`);
  if (s.instock) parts.push("available:=true");
  return parts.join(" && ");
}

// The groups the selected filters need their own counts for, in order.
export const selectedGroups = (s) => [...(s.types.length ? ["type"] : []), ...(s.vendors.length ? ["vendor"] : []), ...s.options.map((g) => `o:${g.name}`)];

// ---- the groups the page shows ------------------------------------------------------------

const label = (name) => name.charAt(0).toUpperCase() + name.slice(1);
const byCount = (a, b) => b.count - a.count || a.value.localeCompare(b.value);
// selected values are always listed (a count of 0 when nothing has them)
function withSelected(values, selected) {
  const out = values.filter((v) => v.value && v.count > 0);
  for (const v of selected) if (!out.some((x) => x.value === v)) out.push({ value: v, count: 0 });
  return out.sort(byCount).map((v) => ({ ...v, selected: selected.includes(v.value) }));
}

// counts: { type: [{value, count}], vendor: [...], options: [{key: "size:M",
// label?, count}], price: {min, max} }. A group shows with two or more values
// or when one of its values is selected; at most six option groups (selected
// ones first, then the ones covering the most products).
//
// Once MAX_SELECTED_GROUPS groups are selected, a value in another group would
// be dropped by parseFacetParams, so groups with nothing selected are left out
// and `full` is true (the rail says to remove a filter first).
export function shapeFacets(s, counts) {
  const groups = [];
  const full = selectedGroups(s).length >= MAX_SELECTED_GROUPS;
  const push = (key, title, values, selected) => {
    if (full && !selected.length) return;
    const vs = withSelected(values, selected);
    if (vs.length >= 2 || selected.length) groups.push({ key, title, values: vs, selectedCount: selected.length });
  };
  push("type", "Product type", counts.type || [], s.types);
  push("vendor", "Brand", counts.vendor || [], s.vendors);
  const byName = new Map();
  for (const o of counts.options || []) {
    const at = String(o.key).indexOf(":");
    if (at <= 0) continue;
    const name = o.key.slice(0, at);
    if (!byName.has(name)) byName.set(name, { label: o.label || label(name), values: [] });
    byName.get(name).values.push({ value: o.key.slice(at + 1), count: Number(o.count) || 0 });
  }
  for (const g of s.options) if (!byName.has(g.name)) byName.set(g.name, { label: label(g.name), values: [] });
  const sel = new Map(s.options.map((g) => [g.name, g.values]));
  const ranked = [...byName].sort(([a, x], [b, y]) => (sel.has(b) ? 1 : 0) - (sel.has(a) ? 1 : 0) || y.values.reduce((n, v) => n + v.count, 0) - x.values.reduce((n, v) => n + v.count, 0) || a.localeCompare(b));
  let optionGroups = 0;
  for (const [name, g] of ranked) {
    if (optionGroups >= MAX_OPTION_GROUPS) break;
    const before = groups.length;
    push(`o:${name}`, g.label, g.values, sel.get(name) || []);
    if (groups.length > before) optionGroups++;
  }
  const price = counts.price && Number.isFinite(counts.price.min) && Number.isFinite(counts.price.max) ? { min: counts.price.min, max: counts.price.max } : null;
  return { groups, price, full };
}

// ---- SQL ----------------------------------------------------------------------------------

const ORDER = {
  "price-asc": sql`m.price ASC, m.handle ASC`,
  "price-desc": sql`m.price DESC, m.handle ASC`,
  new: sql`m.created_at DESC, m.handle ASC`,
};
const values = (vs) => sql.join(vs.map((v) => sql`${v}`));

// The SQL engine (decision 12): computed live from products, the published
// overlay and variants' selected options (json_each), no extra table. One
// statement: the page of results and every count in one UNION ALL. Every
// value is a bound parameter. Returns { source, found, hits, counts }.
export async function facetSearchDb(s) {
  const terms = searchTerms(s.q);
  const first = terms.length ? `${terms[0].toLowerCase()}%` : "";
  const whole = terms.length ? `%${terms.join(" ").toLowerCase()}%` : "";
  return readEffective(async (live) => {
    const title = effectiveExpr("title", live);
    const type = effectiveExpr("display_type", live);
    const vendor = effectiveExpr("display_vendor", live);
    const image = effectiveExpr("featured_image", live);
    const join = live ? sql`LEFT JOIN product_content_live c ON c.product_id = p.id` : sql``;
    const match = terms.length ? sql.join(terms.map((t) => sql`(${title} LIKE ${`%${t}%`} OR ${type} LIKE ${`%${t}%`} OR ${vendor} LIKE ${`%${t}%`} OR p.tags LIKE ${`%${t}%`})`), sql` AND `) : sql`1 = 1`;
    const avail = s.instock ? sql` AND o.avail = 1` : sql``;
    const ctes = sql`WITH m AS MATERIALIZED (
        SELECT p.id, p.handle, ${title} AS title, ${type} AS type, ${vendor} AS vendor, ${image} AS featured_image, p.price_min AS price, p.currency, p.available, p.created_at
        FROM products p ${join} WHERE ${match}
      ), o AS MATERIALIZED (
        SELECT pid, lower(label) AS name, value, label, avail FROM (
          SELECT v.product_id AS pid, trim(j.value ->> 'name', ${OPTION_SPACE}) AS label, trim(j.value ->> 'value', ${OPTION_SPACE}) AS value, v.available AS avail
          FROM variants v JOIN m ON m.id = v.product_id, json_each(CASE WHEN json_valid(v.selected_options) THEN v.selected_options ELSE '[]' END) j
        ) WHERE label <> '' AND value <> '' AND NOT (lower(label) = 'title' AND value = 'Default Title')
        -- lower() and trim() here are ASCII-only; effective.js optionName and
        -- optionText do exactly the same in JS (Typesense keys, the URL)
      )`;
    // every filter except `exclude`
    const where = (exclude = null) => {
      const parts = [];
      if (s.types.length && exclude !== "type") parts.push(sql`m.type IN (${values(s.types)})`);
      if (s.vendors.length && exclude !== "vendor") parts.push(sql`m.vendor IN (${values(s.vendors)})`);
      for (const g of s.options) if (exclude !== `o:${g.name}`) parts.push(sql`EXISTS (SELECT 1 FROM o WHERE o.pid = m.id AND o.name = ${g.name} AND o.value IN (${values(g.values)})${avail})`);
      if (s.min != null) parts.push(sql`m.price >= ${s.min}`);
      if (s.max != null) parts.push(sql`m.price <= ${s.max}`);
      if (s.instock) parts.push(sql`m.available = 1`);
      return parts.length ? sql.join(parts, sql` AND `) : sql`1 = 1`;
    };
    const order = ORDER[s.sort] || sql`m.available DESC, CASE WHEN lower(m.title) LIKE ${first} THEN 0 WHEN lower(m.title) LIKE ${whole} THEN 1 ELSE 2 END ASC, m.title ASC, m.handle ASC`;
    const selected = s.options.map((g) => g.name);
    const unselected = selected.length ? sql` AND o.name NOT IN (${values(selected)})` : sql``;
    const offset = (s.page - 1) * PER_PAGE;
    // the page of results rides in the same statement (one build of m and o):
    // one row per hit, its position in n
    const hit = sql`json_object('handle', m.handle, 'title', m.title, 'type', m.type, 'image', m.featured_image, 'price', m.price, 'currency', m.currency, 'available', m.available)`;
    const parts = [
      sql`SELECT 'hit' AS g, k, NULL AS label, rn AS n FROM (SELECT ${hit} AS k, row_number() OVER (ORDER BY ${order}) AS rn FROM m WHERE ${where()}) WHERE rn > ${offset} AND rn <= ${offset + PER_PAGE}`,
      sql`SELECT 'total' AS g, NULL AS k, NULL AS label, count(*) AS n FROM m WHERE ${where()}`,
      sql`SELECT 'min', NULL, NULL, min(m.price) FROM m WHERE ${where()}`,
      sql`SELECT 'max', NULL, NULL, max(m.price) FROM m WHERE ${where()}`,
      sql`SELECT 'type', m.type, NULL, count(*) FROM m WHERE ${where("type")} AND m.type IS NOT NULL AND m.type <> '' GROUP BY m.type`,
      sql`SELECT 'vendor', m.vendor, NULL, count(*) FROM m WHERE ${where("vendor")} AND m.vendor IS NOT NULL AND m.vendor <> '' GROUP BY m.vendor`,
      sql`SELECT 'o', o.name || ':' || o.value, min(o.label), count(DISTINCT m.id) FROM m JOIN o ON o.pid = m.id WHERE ${where()}${avail}${unselected} GROUP BY o.name, o.value`,
      ...selected.map((name) => sql`SELECT 'o', o.name || ':' || o.value, min(o.label), count(DISTINCT m.id) FROM m JOIN o ON o.pid = m.id WHERE ${where(`o:${name}`)}${avail} AND o.name = ${name} GROUP BY o.name, o.value`),
    ];
    const tally = await sql`${ctes} ${sql.join(parts, sql` UNION ALL `)}`.execute(db);
    const hits = [];
    const counts = { type: [], vendor: [], options: [], price: { min: null, max: null } };
    let found = 0;
    for (const r of tally.rows) {
      const n = Number(r.n);
      if (r.g === "hit") hits.push([n, JSON.parse(r.k)]);
      else if (r.g === "total") found = n;
      else if (r.g === "min" || r.g === "max") counts.price[r.g] = r.n == null ? null : n;
      else if (r.g === "type" || r.g === "vendor") counts[r.g].push({ value: String(r.k), count: n });
      else if (r.g === "o") counts.options.push({ key: String(r.k), label: r.label == null ? null : String(r.label), count: n });
    }
    return {
      source: "database",
      found,
      hits: hits.sort((a, b) => a[0] - b[0]).map(([, r]) => ({
        handle: r.handle,
        title: r.title,
        image: r.image,
        price: r.price,
        currency: r.currency || "INR",
        display_type: r.type,
        available: !!r.available,
      })),
      counts,
    };
  });
}
