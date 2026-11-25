// The dashboard's date ranges (Phase 2 line 1): ?days= is 7, 30 or 90; 30 is
// the plain /admin/dashboard. Pure, so the range links and the shell drill
// (one support pass per range) share it without loading the database.
export const RANGES = Object.freeze([7, 30, 90]);
export const DEFAULT_RANGE = 30;
export const rangeHref = (days) => (days === DEFAULT_RANGE ? "/admin/dashboard" : `/admin/dashboard?days=${days}`);
