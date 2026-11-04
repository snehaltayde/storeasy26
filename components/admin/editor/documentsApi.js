// P3-SESSION (PUB-11, ED-02, PV-01): the console's client for the documents
// APIs. Plain JS, no React and no DOM, so node tests drive it with a stubbed
// fetch (createDocumentsApi({ fetch })). The editor's store (P3-STORE) and the
// publish panel (P3-PUBLISHUI) take one of these as an injected dependency.
//
// The response contract is lib/admin/documents-api-shapes.js; this file reads
// it (which operations exist, the words of the common answers) and does not
// restate it. The legacy editors keep components/admin/cms/api.js.
//
//   call(op, args, extra?)      PUT /api/admin/documents with { [op]: args, ...extra }
//                               (extra carries the top-level keys, e.g. { revision: 3 })
//   sendKeepalive(op, args, extra?)  the same request with fetch keepalive, for
//                               tab close; false when it can't be sent (body
//                               over 60,000 bytes, unknown op, fetch missing)
//   startDocumentsPreview({ showDesign })  a preview session and its cookie
//   setShowDesign(sid, on)      "Show them": the design draft in that preview
//
// call() never throws. It answers exactly one of:
//   { ok: true, data }                                   2xx; data is the body
//   { conflict: true, code, current, message, conflicts? }
//                                409 DOCUMENT_CHANGED or PUBLISHED_ELSEWHERE;
//                                current is the document as it is now (with
//                                updatedByName when the server sends it), or
//                                null when a set refused for several documents
//   { refused: true, code, message, other?, offer?, current? }   any other 409
//   { issues, code, message, offer?, documents? }        422
//   { needsRevision: true, code, message }               428
//   { notBuilt: true, code, message }                    501
//   { error: true, code, message }                       any other 4xx or 5xx,
//                                with the server's words (lib/cms/issues.js
//                                failure()), or the contract's words for that
//                                status when the body can't be read
//   { error: true, code: "NETWORK_ERROR", message }      fetch rejected
// `message` is always founder-facing plain words.
// P3-FIX1: every other field of an error or refusal body is kept on the
// result as the server sent it (retryable, release, reason, missing, slug,
// document, …), so the store can decide on a retry and the publish panel can
// check a publish whose result is unknown. Only the body's `error` (it
// becomes `message`) and the result's own keys above are not copied.
import { SHAPES, COMMON } from "../../../lib/admin/documents-api-shapes.js"; // relative, so plain node loads it

export const DOCUMENTS_URL = "/api/admin/documents";
export const PREVIEW_SESSION_URL = "/api/admin/preview-session";
// spec ED-03 says "about 64 KB"; phase 3 keeps a margin below the browsers' limit
export const KEEPALIVE_MAX_BYTES = 60_000;

export const OPERATIONS = Object.freeze(Object.keys(SHAPES));
const CONFLICT_CODES = new Set(["DOCUMENT_CHANGED", "PUBLISHED_ELSEWHERE"]);

const O = COMMON.outcomes;
export const NETWORK_ERROR_WORDS = "We couldn't reach Storeasy, so nothing was saved. Check your internet connection, then try again. Your changes are still here.";
const SIGNED_OUT_WORDS = "You're signed out, so nothing was saved. Sign in again in another tab, then try again. Your changes are still here.";
const NOT_ALLOWED_WORDS = "This tab isn't allowed to do that, so nothing was saved. Reload the page and try again.";
const UNREADABLE_WORDS = O.internalError.body.error;
// Server strings that are not plain words: replaced, never shown.
const TECHNICAL = new Set(["Unauthorized", "Cross-origin request rejected"]);

// The contract's words for a status, for when a body has none we can use.
function wordsForStatus(status) {
  if (status === 400) return O.malformed.body.error;
  if (status === 401) return SIGNED_OUT_WORDS;
  if (status === 403) return NOT_ALLOWED_WORDS;
  if (status === 404) return O.notFound.body.error;
  if (status === 501) return O.notBuilt.body.error;
  if (status === 503) return O.databaseUnavailable.body.error;
  return UNREADABLE_WORDS;
}
const codeForStatus = (status) =>
  ({ 400: "MALFORMED", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 501: "NOT_BUILT" })[status] || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const words = (body, status) => {
  const e = isObj(body) && typeof body.error === "string" ? body.error.trim() : "";
  return e && !TECHNICAL.has(e) ? e : wordsForStatus(status);
};
const codeOf = (body, status) => (isObj(body) && typeof body.code === "string" && body.code ? body.code : codeForStatus(status));

// The result's own keys: a body field with one of these names never
// overwrites them. `error` is the body's words, which become `message`.
const RESULT_KEYS = new Set(["ok", "data", "conflict", "refused", "issues", "needsRevision", "notBuilt", "error", "code", "message", "current", "offer", "other", "documents"]);
const withBodyFields = (out, b) => {
  for (const [k, v] of Object.entries(b)) if (!RESULT_KEYS.has(k) && v !== undefined) out[k] = v;
  return out;
};

// One HTTP answer to one result. Pure: status is a number, body the parsed
// JSON (or null when it could not be read).
export function mapResponse(status, body) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 300) {
    if (!isObj(body)) return { error: true, code: "UNREADABLE_RESPONSE", message: UNREADABLE_WORDS };
    return { ok: true, data: body };
  }
  const code = codeOf(body, s);
  const message = words(body, s);
  const b = isObj(body) ? body : {};
  if (s === 409) {
    if (CONFLICT_CODES.has(code)) {
      const out = { conflict: true, code, current: isObj(b.current) ? b.current : null, message };
      if (Array.isArray(b.conflicts)) out.conflicts = b.conflicts;
      return withBodyFields(out, b);
    }
    const out = { refused: true, code, message };
    if ("other" in b) out.other = b.other;
    // offer null (FIRST_PUBLISH_NEEDS_HOME with no home page yet) means
    // "nothing to offer", so it is kept as sent
    if (isObj(b.offer) || b.offer === null) out.offer = b.offer;
    if (isObj(b.current)) out.current = b.current;
    if (Array.isArray(b.documents)) out.documents = b.documents;
    return withBodyFields(out, b);
  }
  if (s === 422) {
    const out = { issues: Array.isArray(b.issues) ? b.issues : [], code, message };
    if (isObj(b.offer)) out.offer = b.offer;
    if (Array.isArray(b.documents)) out.documents = b.documents;
    return withBodyFields(out, b);
  }
  if (s === 428) return withBodyFields({ needsRevision: true, code, message }, b);
  if (s === 501) return withBodyFields({ notBuilt: true, code, message }, b);
  const out = { error: true, code, message };
  if (isObj(b.current)) out.current = b.current;
  if (Array.isArray(b.documents)) out.documents = b.documents;
  return withBodyFields(out, b);
}

const networkError = (message = NETWORK_ERROR_WORDS) => ({ error: true, code: "NETWORK_ERROR", message });

// Sent on the cookie fetch: /api/preview then answers JSON (200 with the
// cookie, or 403 PREVIEW_TOKEN_REFUSED) instead of a redirect.
export const PREVIEW_CONFIRM_HEADER = "x-storeasy-preview-confirm";
const PREVIEW_NOT_OPENED_WORDS = "We couldn't open the preview, so it shows nothing new yet. Check your internet connection, then try again. Your changes are still here.";

// The bytes a JSON body takes on the wire (UTF-8).
export const byteLength = (s) => new TextEncoder().encode(String(s)).length;

function requestBody(op, args, extra) {
  if (!OPERATIONS.includes(op)) return null;
  const rest = isObj(extra) ? extra : {};
  return JSON.stringify({ ...rest, [op]: args });
}

export function createDocumentsApi({ fetch: fetchImpl } = {}) {
  const doFetch = (url, init) => {
    const f = fetchImpl || globalThis.fetch;
    if (typeof f !== "function") throw new TypeError("fetch is not available");
    return f(url, init);
  };

  async function send(url, method, json) {
    let res;
    try {
      res = await doFetch(url, { method, headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: json });
    } catch {
      return networkError();
    }
    try {
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return mapResponse(res?.status, body);
    } catch {
      return { error: true, code: "UNREADABLE_RESPONSE", message: UNREADABLE_WORDS };
    }
  }

  async function call(op, args, extra) {
    let json;
    try {
      json = requestBody(op, args, extra);
    } catch {
      json = undefined; // a body JSON can't hold (a cycle, a BigInt)
    }
    if (json === null) return { error: true, code: "UNKNOWN_OPERATION", message: O.unknownOperation.body.error };
    if (json === undefined) return { error: true, code: "MALFORMED", message: O.malformed.body.error };
    return send(DOCUMENTS_URL, "PUT", json);
  }

  // Tab close: fire and forget. true when the request was handed to the
  // browser; false when it was not sent (too large for keepalive, unknown
  // op, no fetch), so the caller warns and keeps the local backup.
  function sendKeepalive(op, args, extra) {
    try {
      const json = requestBody(op, args, extra);
      if (json == null || byteLength(json) > KEEPALIVE_MAX_BYTES) return false;
      const p = doFetch(DOCUMENTS_URL, { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "same-origin", keepalive: true, body: json });
      if (p && typeof p.catch === "function") p.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  const previewPost = (body) => send(PREVIEW_SESSION_URL, "POST", JSON.stringify(body));

  // "Show them" for one preview session (P2-PREVIEW's showDesign op).
  async function setShowDesign(sid, on) {
    return previewPost({ showDesign: { sid: String(sid || ""), on: Boolean(on) } });
  }

  // A documents-mode preview: a session, the design draft when asked, then
  // the token URL fetched same-origin so the server sets the httpOnly cookie
  // in this browser. { ok: true, sid, expiresAt, showDesign } or a mapped
  // error (a legacy store answers 409 STORE_USES_LEGACY with its words). A
  // failed showDesign step is returned as it is: the preview is not reported
  // as showing the design when it does not.
  //
  // The cookie fetch (P3-FIX1) asks /api/preview to confirm in JSON
  // (PREVIEW_CONFIRM_HEADER) instead of redirecting, and never follows a
  // redirect (redirect: "manual"), so it does not render the home page just to
  // set a cookie. Only a 2xx { ok: true } counts. A refused token (403
  // PREVIEW_TOKEN_REFUSED), any other status, or a redirect (an answer that
  // did not confirm) is an error, never { ok: true }.
  async function startDocumentsPreview({ showDesign = false } = {}) {
    const made = await previewPost({ create: true });
    if (!made.ok) return made;
    const { sid, expiresAt, previewUrl } = made.data;
    // the cookie URL must be a path on this origin, never another site
    if (typeof sid !== "string" || typeof previewUrl !== "string" || !previewUrl.startsWith("/api/preview?") || /[\\]/.test(previewUrl)) {
      return { error: true, code: "UNREADABLE_RESPONSE", message: UNREADABLE_WORDS };
    }
    if (showDesign) {
      const shown = await setShowDesign(sid, true);
      if (!shown.ok) return shown;
    }
    let res;
    try {
      res = await doFetch(previewUrl, { method: "GET", credentials: "same-origin", redirect: "manual", headers: { [PREVIEW_CONFIRM_HEADER]: "1" } });
    } catch {
      return networkError(PREVIEW_NOT_OPENED_WORDS);
    }
    const status = Number(res?.status) || 0;
    if (res?.type === "opaqueredirect" || (status >= 300 && status < 400) || status === 0) {
      return { error: true, code: "PREVIEW_NOT_CONFIRMED", message: PREVIEW_NOT_OPENED_WORDS };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    // P3-FIX2: a 2xx with no readable body didn't confirm the preview: the
    // preview's words, not a save's
    if (status >= 200 && status < 300 && !isObj(body)) return { error: true, code: "PREVIEW_NOT_CONFIRMED", message: PREVIEW_NOT_OPENED_WORDS };
    const answer = mapResponse(status, body);
    if (answer.ok && answer.data.ok !== true) return { error: true, code: "PREVIEW_NOT_CONFIRMED", message: PREVIEW_NOT_OPENED_WORDS };
    if (!answer.ok) return answer;
    return { ok: true, sid, expiresAt: expiresAt ?? null, showDesign: Boolean(showDesign) };
  }

  return { call, sendKeepalive, startDocumentsPreview, setShowDesign };
}

// The browser's own fetch, looked up on each request.
const defaultApi = createDocumentsApi();
export const call = defaultApi.call;
export const sendKeepalive = defaultApi.sendKeepalive;
export const startDocumentsPreview = defaultApi.startDocumentsPreview;
export const setShowDesign = defaultApi.setShowDesign;
