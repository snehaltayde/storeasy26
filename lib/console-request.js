import { tfetch as tenantFetch } from "./tenant-request.js";

// The console's data path (P1-FIX-C): lib/tenant-request.js's tfetch, reading
// the store's row (settings, brand, theme, identity) fresh on every request.
// A founder who saves and reloads must see the save, on whichever server
// instance the reload lands; the 30-second instance cache can't promise that.
//
// Console pages import tfetch from here, never from lib/tenant-request.js.
// The console's API gets
// the same through tenantHandler, which reads fresh for every /api/admin/ path.
export const tfetch = (fn) => tenantFetch(fn, { fresh: true });
