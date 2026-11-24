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
// diffRuns(base, next) → { totals, pages, missing }: the computed-style,
// box and element differences per page and width, with a few samples each.
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

// Two captures of the same page and width → { style, box, added, removed, shot, samples }.
export function diffCapture(base, next, { limit = 20 } = {}) {
  const a = new Map(base.elements.map((e) => [e.k, e]));
  const b = new Map(next.elements.map((e) => [e.k, e]));
  const out = { page: next.page, width: next.width, style: 0, box: 0, added: 0, removed: 0, shot: base.shot === next.shot ? "same" : "differs", samples: [] };
  const sample = (row) => out.samples.length < limit && out.samples.push(row);
  for (const [k, e] of a) {
    const f = b.get(k);
    if (!f) {
      out.removed++;
      sample({ k, kind: "removed" });
      continue;
    }
    if (JSON.stringify(e.b) !== JSON.stringify(f.b)) {
      out.box++;
      sample({ k, kind: "box", before: e.b, after: f.b });
    }
    if (elementHash({ ...e, b: null }) === elementHash({ ...f, b: null })) continue;
    for (const p of new Set([...Object.keys(e.s), ...Object.keys(f.s)])) {
      if (e.s[p] === f.s[p]) continue;
      out.style++;
      sample({ k, kind: "style", prop: p, before: e.s[p] ?? null, after: f.s[p] ?? null });
    }
  }
  for (const k of b.keys()) {
    if (a.has(k)) continue;
    out.added++;
    sample({ k, kind: "added" });
  }
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
  const totals = { style: sum("style"), box: sum("box"), added: sum("added"), removed: sum("removed"), shots: pages.filter((p) => p.shot !== "same").length, missing: missing.length };
  return { totals, pages, missing };
}

// The pass rule: no computed-style, box or element difference and no missing capture.
export const isClean = (t) => t.style === 0 && t.box === 0 && t.added === 0 && t.removed === 0 && t.missing === 0;
