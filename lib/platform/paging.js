// Operator list paging (Phase 3 audit P3-F): a limit is a whole number from 1
// to 200 (the fallback when it is missing or not a number; Infinity is the cap) and an offset a
// whole number from 0 to MAX_OFFSET, so ?limit=-1 never means "every row" and
// a huge page or offset never reaches the SQL as 1e+21 or Infinity.
export const MAX_LIMIT = 200;
export const MAX_OFFSET = 1_000_000;

export function clampLimit(value, fallback = 50, max = MAX_LIMIT) {
  const n = Math.floor(Number(value));
  if (Number.isNaN(n)) return Math.min(fallback, max);
  return Math.min(Math.max(1, n), max);
}

export function clampOffset(value) {
  const n = Math.floor(Number(value));
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.min(n, MAX_OFFSET);
}
