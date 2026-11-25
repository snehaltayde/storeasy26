// The shell drill's read-POST matcher (scripts/drills/shell/run.mjs), here so
// test-drills runs it on real bodies (Phase 2 line 6 review).
//   bodyOp(body)   the body's single top-level key, or null (two keys, none,
//                  or not JSON): a body that isn't one plain op is never a read
//   readPost(page, method, path, body, status, rows = READ_POSTS)
//                  true when a READ_POSTS row lets this request through:
//                  - a row without ops: page (a route pattern), method and path match
//                  - a row with ops, seen by the browser (status undefined):
//                    bodyOp(body) is one of the row's ops (saveDraft never is)
//                  - a row with ops, seen in the server log (a status, no
//                    body): only a 2xx is a read; a 400, a 403, a 0 or a
//                    missing status (the caller passes 0) is a write
//                  - a row with a body rule (r.body) needs the browser's body to
//                    match it; a server-log line has no body, so never does
import { READ_POSTS, routeMatches, bodyMatches } from "./read-controls.js";

export const bodyOp = (body) => {
  try {
    const parsed = JSON.parse(body ?? "");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed);
    return keys.length === 1 ? keys[0] : null;
  } catch {
    return null;
  }
};

const ok2xx = (status) => Number.isInteger(status) && status >= 200 && status < 300;

export const readPost = (page, method, path, body, status, rows = READ_POSTS) =>
  rows.some((r) => routeMatches(r.page, page) && r.method === method && r.path === path && (!r.body || (body !== undefined && bodyMatches(r, body))) && (!Array.isArray(r.ops) || (status !== undefined ? ok2xx(status) : r.ops.includes(bodyOp(body)))));
