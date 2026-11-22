// P2-PREVIEW (PV-03, spec 8.8): preview sessions for the documents editor,
// behind POST /api/admin/preview-session (app/api/admin/preview-session/route.js,
// nodejs). Kept apart from the route so scripts/test-preview-overlay.js runs
// the real dispatch, authorization and storage.
//
// Exactly ONE operation per request (the A1 rule of lib/admin/cms-api.js),
// parsed before it is authorized:
//   { create: true }                    a new session and its token
//   { showDesign: { sid, on } }         "Your new colours are not shown here.
//                                       Show them": add the design draft too
//                                       P3-FIX5 (finding D1): on: true also
//                                       turns it on in the session the
//                                       request's _preview cookie names (the
//                                       one this browser's frame renders),
//                                       when that session is live and the same
//                                       person's; the answer then carries
//                                       frameSid. on: false changes only sid,
//                                       so another tab's design preview is
//                                       never turned off from here.
//   { revoke: sid }                     end the session now
// All three need storefront.read (anyone who may look at the storefront may
// preview it) and a same-origin request (they change state).
//
// Answers, in order:
//   400 for a body that isn't exactly one known operation
//   401 / 403 from requireAdmin, 403 for a cross-origin request
//   409 STORE_USES_LEGACY on a store that isn't in documents mode: those
//       stores preview through the releases preview (today's token)
//   404 PREVIEW_SESSION_NOT_FOUND when the session is gone, expired, revoked
//       or someone else's
//   5xx with a code (failure()) when the database fails: a session that
//       couldn't be written is never reported as made
import { requireAdmin } from "../admin-auth.js";
import { sameOrigin } from "../origin-check.js";
import { failure } from "../cms/issues.js";
import { getCmsMode } from "../cms-mode.js";
import { slog } from "../log.js";
import { PREVIEW_SID_RE, readPreviewToken } from "../releases.js";
import { PREVIEW_COOKIE } from "../preview-sessions.js";
import { createPreviewSession, setShowDesign, revokePreviewSession } from "../preview-sessions.js";

const OPS = ["create", "showDesign", "revoke"];
const UNREADABLE = "The editor sent something we couldn't read, so the preview didn't change. Reload the page and try again.";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function parsePreviewSessionOperation(body) {
  const bad = (code) => ({ error: UNREADABLE, code });
  if (!isObj(body)) return bad("NO_OPERATION");
  const keys = Object.keys(body).filter((k) => body[k] !== undefined);
  if (keys.some((k) => !OPS.includes(k))) return bad("UNKNOWN_OPERATION");
  if (keys.length === 0) return bad("NO_OPERATION");
  if (keys.length > 1) return bad("AMBIGUOUS_OPERATION");
  const kind = keys[0];
  const arg = body[kind];
  if (kind === "create") return arg === true ? { op: { kind } } : bad("MALFORMED");
  if (kind === "showDesign") {
    if (!isObj(arg) || !PREVIEW_SID_RE.test(String(arg.sid || "")) || typeof arg.on !== "boolean") return bad("MALFORMED");
    return { op: { kind, sid: arg.sid, on: arg.on } };
  }
  const sid = isObj(arg) ? arg.sid : arg;
  return PREVIEW_SID_RE.test(String(sid || "")) ? { op: { kind, sid } } : bad("MALFORMED");
}

const LEGACY = {
  status: 409,
  body: {
    error: "This store still uses the current Storefront editor, so it previews from there. Use Preview in Storefront instead.",
    code: "STORE_USES_LEGACY",
  },
};
const GONE = {
  status: 404,
  body: { error: "This preview has ended. Open the preview again from the editor.", code: "PREVIEW_SESSION_NOT_FOUND" },
};

function failed(e, op) {
  const f = failure(e, { doing: "preview" });
  slog("preview_session_failure", { op: op.kind, status: f.status, code: f.body.code, error: String(e?.cause?.message || e?.message || e).slice(0, 300) });
  return { status: f.status, body: f.body };
}

// The session this browser's _preview cookie names, when it is a token this
// store signed, not expired, and not `sid` itself; else null. Never throws.
async function cookieSession(request, sid) {
  try {
    const token = request.cookies?.get?.(PREVIEW_COOKIE)?.value;
    if (!token) return null;
    const t = await readPreviewToken(token);
    return t?.sid && t.sid !== sid ? t.sid : null;
  } catch {
    return null;
  }
}

export async function handlePreviewSessionPost(request) {
  const body = await request.json().catch(() => undefined);
  const parsed = parsePreviewSessionOperation(body);
  if (parsed.error) return { status: 400, body: { error: parsed.error, code: parsed.code } };
  const op = parsed.op;
  if (!sameOrigin(request)) return { status: 403, body: { error: "Cross-origin request rejected" } };

  let auth;
  try {
    auth = await requireAdmin(request, "storefront.read");
  } catch (e) {
    return failed(e, op);
  }
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  let mode;
  try {
    mode = await getCmsMode();
  } catch (e) {
    return failed(e, op);
  }
  if (mode !== "documents") return LEGACY;

  try {
    if (op.kind === "create") {
      const s = await createPreviewSession({ actor: auth.actor });
      slog("preview_session_created", { sid: s.sid });
      return {
        status: 200,
        body: { ok: true, sid: s.sid, token: s.token, expiresAt: s.expiresAt, showDesign: false, previewUrl: `/api/preview?token=${encodeURIComponent(s.token)}&to=/` },
      };
    }
    if (op.kind === "showDesign") {
      if (!(await setShowDesign({ sid: op.sid, on: op.on, actor: auth.actor }))) return GONE;
      const frameSid = op.on ? await cookieSession(request, op.sid) : null;
      if (frameSid && (await setShowDesign({ sid: frameSid, on: true, actor: auth.actor }))) {
        slog("preview_session_design_frame", { sid: op.sid, frameSid });
        return { status: 200, body: { ok: true, sid: op.sid, showDesign: op.on, frameSid } };
      }
      return { status: 200, body: { ok: true, sid: op.sid, showDesign: op.on } };
    }
    if (!(await revokePreviewSession({ sid: op.sid, actor: auth.actor }))) return GONE;
    return { status: 200, body: { ok: true, sid: op.sid, revoked: true } };
  } catch (e) {
    return failed(e, op);
  }
}
