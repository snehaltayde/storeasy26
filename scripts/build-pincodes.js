// Phase 8 line 1 (decision 8): turn India Post's "All India Pincode Directory"
// CSV (data.gov.in, Government Open Data License – India) into the compact
// data/in-pincodes.json that lib/pincode/offline.js reads.
//
//   node scripts/build-pincodes.js <path-to.csv> [out.json]
//
// The download is an owner step (docs/cms-reviews/MANUAL-CHECKS.md); this
// script never fetches anything. Output:
//   { source, license, attribution, built, count,
//     districts: [name], states: [name], pins: { "560001": [districtIdx, stateIdx] } }
// One row per post office: a pin with offices in two districts takes the most
// common district (ties: the first seen). Names are title-cased, and states
// are today's (Ladakh, Telangana, Odisha …) even when the CSV is older.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ATTRIBUTION =
  "Contains pincode data from India Post, All India Pincode Directory (data.gov.in), published under the Government Open Data License – India (GODL).";

// One CSV line → fields (quoted fields, doubled quotes inside them).
export function csvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

export const titleCase = (s) =>
  String(s)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s\-(./])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());

// Old or variant spellings → today's state or union territory.
const STATE_ALIASES = {
  "jammu & kashmir": "Jammu And Kashmir",
  "jammu and kashmir": "Jammu And Kashmir",
  "andaman & nicobar islands": "Andaman And Nicobar Islands",
  "andaman and nicobar islands": "Andaman And Nicobar Islands",
  "dadra & nagar haveli": "Dadra And Nagar Haveli And Daman And Diu",
  "dadra and nagar haveli": "Dadra And Nagar Haveli And Daman And Diu",
  "daman & diu": "Dadra And Nagar Haveli And Daman And Diu",
  "daman and diu": "Dadra And Nagar Haveli And Daman And Diu",
  "the dadra and nagar haveli and daman and diu": "Dadra And Nagar Haveli And Daman And Diu",
  "pondicherry": "Puducherry",
  "orissa": "Odisha",
  "uttaranchal": "Uttarakhand",
  "chattisgarh": "Chhattisgarh",
  "delhi": "Delhi",
  "new delhi": "Delhi",
};
// Districts that moved state: Ladakh (2019) and Telangana (2014).
const LADAKH = new Set(["leh", "leh ladakh", "leh (ladakh)", "kargil"]);
const TELANGANA = new Set([
  "adilabad", "hyderabad", "karimnagar", "khammam", "mahabubnagar", "mahbubnagar", "medak",
  "nalgonda", "nizamabad", "rangareddy", "ranga reddy", "k.v.rangareddy", "k.v. rangareddy", "warangal",
]);

export function currentState(state, district) {
  const s = String(state).trim().toLowerCase();
  const d = String(district).trim().toLowerCase();
  if (LADAKH.has(d)) return "Ladakh";
  if (s === "andhra pradesh" && TELANGANA.has(d)) return "Telangana";
  return STATE_ALIASES[s] || titleCase(state);
}

// CSV text → the compact dataset object.
export function buildPincodes(text, { built = new Date().toISOString() } = {}) {
  const [header, ...rows] = csvRows(text.replace(/^﻿/, ""));
  const col = (names) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const iPin = col(["pincode", "pin code", "pin"]);
  const iDistrict = col(["district", "districtname", "district name"]);
  const iState = col(["statename", "state name", "state"]);
  if (iPin < 0 || iDistrict < 0 || iState < 0) throw new Error(`build-pincodes: the CSV needs pincode, district and state columns (got: ${header.join(", ")})`);

  const counts = new Map(); // pin → Map("district|state" → count), insertion order = first seen
  for (const r of rows) {
    const pin = String(r[iPin] ?? "").trim();
    const district = String(r[iDistrict] ?? "").trim();
    if (!/^[1-9]\d{5}$/.test(pin) || !district || /^na$/i.test(district)) continue;
    const key = `${titleCase(district)}|${currentState(r[iState] ?? "", district)}`;
    if (!counts.has(pin)) counts.set(pin, new Map());
    const m = counts.get(pin);
    m.set(key, (m.get(key) || 0) + 1);
  }

  const districts = [];
  const states = [];
  const idx = (list, name) => {
    let i = list.indexOf(name);
    if (i < 0) i = list.push(name) - 1;
    return i;
  };
  const pins = {};
  for (const pin of [...counts.keys()].sort()) {
    let best = null;
    for (const [key, n] of counts.get(pin)) if (!best || n > best[1]) best = [key, n];
    const [district, state] = best[0].split("|");
    pins[pin] = [idx(districts, district), idx(states, state)];
  }
  return {
    source: "India Post, All India Pincode Directory (data.gov.in)",
    license: "Government Open Data License – India (GODL)",
    attribution: ATTRIBUTION,
    built,
    count: Object.keys(pins).length,
    districts,
    states,
    pins,
  };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [csv, out = join(ROOT, "data", "in-pincodes.json")] = process.argv.slice(2);
  if (!csv) {
    console.error("Use: node scripts/build-pincodes.js <path-to.csv> [out.json]");
    process.exit(2);
  }
  const data = buildPincodes(await readFile(csv, "utf8"));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(data)}\n`);
  console.log(`✓ ${data.count} pins, ${data.districts.length} districts, ${data.states.length} states → ${out}`);
}
