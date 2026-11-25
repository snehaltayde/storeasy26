// The merchant console routes rebuilt on the new UI (docs/plans/phase-2.md,
// "Line 0"). On these the shell puts the page straight into `main`, with no
// [data-legacy] region around it; every other route keeps the old region.
// Each Phase 2 line appends its own prefix (one row per line; keep both sides
// when appends conflict). Line 10 deletes this once every route is listed.
export const NEW_UI_ROUTES = Object.freeze([
  "/admin/dashboard", // Phase 2 line 1
  "/admin/offers", // line 4
  "/admin/bundles", // line 4
  "/admin/media", // Phase 2 line 5
  "/admin/orders", // Phase 2 line 2
]);

// A prefix matches itself and anything below it at a "/" (the same rule as
// activeItem in lib/admin/nav.js): /admin/orders matches /admin/orders/ord_1,
// never /admin/ordersx.
export function isNewUiRoute(pathname, routes = NEW_UI_ROUTES) {
  if (typeof pathname !== "string") return false;
  return routes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
