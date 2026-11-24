// SF-STYLES: the pure half of the storefront render comparison (Phase 0
// line 7). No browser, no files: run.mjs captures, this serialises, hashes and
// diffs. A capture is one page at one width:
//
//   { page, width, url, status, shot, elements: [{ k, s, b }] }
//     k  the element's path ("html>body:2>div:1", "…::before")
//     s  its full getComputedStyle, { property: value }
//     b  its bounding box [x, y, width, height] rounded to 0.5px (null for
//        ::before / ::after, which have no box of their own)
//     shot  sha256 of the full-page screenshot
//
// diffRuns(base, next) → { totals, pages, missing, customAdded }: the
// computed-style, box and element differences per page and width, with a few
// samples each. Custom properties (--*) are counted apart: one that appears
// (absent before) is a new token, reported by name; one whose value changed
// fails like any other property. A console-only change adds tokens a
// storefront element carries but never reads (tw-animate-css's registered
// @property --tw-*, theme variables on :root); it must not change any.
//
// Options (Phase 0 line 8, the console set):
//   ignoreProps  property names left out of the style count ("--*" style
//                entries ending in * match a prefix); each one skipped is
//                counted in `ignored` instead, so the report still shows it
//   ignoreBoxes  box differences are counted in `boxReported`, not `box`:
//                reported and expected (a wider content column moves boxes),
//                never a failure
//   limit        samples kept per capture (default 20)
import { createHash } from "node:crypto";

export const round = (n) => Math.round(Number(n) * 2) / 2;
export const roundBox = (r) => (r ? [round(r.x), round(r.y), round(r.width), round(r.height)] : null);

// One element as a canonical string: properties sorted, so the order Chrome
// lists them in never matters.
export function serialise({ k, s, b }) {
  const props = Object.keys(s || {})
    .sort()
    .map((p) => `${p}:${s[p]}`);
  return `${k}\n${b ? b.join(",") : "-"}\n${props.join(";")}`;
}

export const hashOf = (text) => createHash("sha256").update(text).digest("hex");
export const elementHash = (el) => hashOf(serialise(el));
export const captureKey = (c) => `${c.page}@${c.width}`;

// ignoreProps → (prop) → true when the property is left out of the count.
export function ignoreMatcher(ignoreProps = []) {
  const exact = new Set(ignoreProps.filter((p) => !p.endsWith("*")));
  const prefixes = ignoreProps.filter((p) => p.endsWith("*")).map((p) => p.slice(0, -1));
  return (p) => exact.has(p) || prefixes.some((x) => p.startsWith(x));
}

// Two captures of the same page and width → { style, box, added, removed, shot, samples }.
export function diffCapture(base, next, { limit = 20, ignoreProps = [], ignoreBoxes = false } = {}) {
  const skip = ignoreMatcher(ignoreProps);
  const a = new Map(base.elements.map((e) => [e.k, e]));
  const b = new Map(next.elements.map((e) => [e.k, e]));
  const out = { page: next.page, width: next.width, style: 0, box: 0, added: 0, removed: 0, customChanged: 0, customAdded: 0, ignored: 0, boxReported: 0, shot: base.shot === next.shot ? "same" : "differs", samples: [], customNames: [] };
  const names = new Set();
  const sample = (row) => out.samples.length < limit && out.samples.push(row);
  for (const [k, e] of a) {
    const f = b.get(k);
    if (!f) {
      out.removed++;
      sample({ k, kind: "removed" });
      continue;
    }
    if (JSON.stringify(e.b) !== JSON.stringify(f.b)) {
      if (ignoreBoxes) out.boxReported++;
      else {
        out.box++;
        sample({ k, kind: "box", before: e.b, after: f.b });
      }
    }
    if (elementHash({ ...e, b: null }) === elementHash({ ...f, b: null })) continue;
    for (const p of new Set([...Object.keys(e.s), ...Object.keys(f.s)])) {
      if (e.s[p] === f.s[p]) continue;
      if (skip(p)) {
        out.ignored++;
        continue;
      }
      if (p.startsWith("--") && e.s[p] === undefined) {
        out.customAdded++;
        names.add(p);
        continue;
      }
      if (p.startsWith("--")) out.customChanged++;
      else out.style++;
      sample({ k, kind: p.startsWith("--") ? "custom" : "style", prop: p, before: e.s[p] ?? null, after: f.s[p] ?? null });
    }
  }
  for (const k of b.keys()) {
    if (a.has(k)) continue;
    out.added++;
    sample({ k, kind: "added" });
  }
  out.customNames = [...names].sort();
  return out;
}

// Every capture of a baseline run against the same page and width of the next run.
export function diffRuns(base, next, opts) {
  const byKey = new Map(base.map((c) => [captureKey(c), c]));
  const pages = [];
  const missing = [];
  for (const c of next) {
    const b = byKey.get(captureKey(c));
    if (!b) missing.push(`${captureKey(c)} (not in the baseline)`);
    else pages.push(diffCapture(b, c, opts));
    byKey.delete(captureKey(c));
  }
  for (const k of byKey.keys()) missing.push(`${k} (not in this run)`);
  const sum = (f) => pages.reduce((n, p) => n + p[f], 0);
  const totals = { style: sum("style"), box: sum("box"), added: sum("added"), removed: sum("removed"), customChanged: sum("customChanged"), customAdded: sum("customAdded"), ignored: sum("ignored"), boxReported: sum("boxReported"), shots: pages.filter((p) => p.shot !== "same").length, missing: missing.length };
  const customAdded = [...new Set(pages.flatMap((p) => p.customNames))].sort();
  return { totals, pages, missing, customAdded };
}

// The pass rule: no computed-style, box or element difference, no changed
// custom property and no missing capture (new custom properties are reported).
export const isClean = (t) => t.style === 0 && t.box === 0 && t.added === 0 && t.removed === 0 && t.customChanged === 0 && t.missing === 0;
