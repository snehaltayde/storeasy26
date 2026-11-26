// Phase 9 line 1 review fix: storefront pages that never load the third-party
// pixels (gtag, the Meta pixel), whatever the shopper's consent. A review or
// opt-out link carries its signed token in ?t=, and those tags read the page
// address, so they stay off every /reviews/ page. Pure; Pixels.js reads it.
const NO_PIXELS = /^\/reviews(?:\/|$)/;

export const pixelsAllowed = (pathname) => !NO_PIXELS.test(String(pathname ?? ""));
