// Mail the platform itself sends (Phase 1 line 1: signup codes). Node-only.
//
//   sendPlatformMail({ kind, to, subject, text, ref }) -> { id, status, ok }
//     Records a platform_mail row with no body, sends inline through
//     lib/mail.js, then settles the row: "sent" (provider id kept), "failed"
//     (error kept) or "mock" (no provider configured, never in production:
//     nothing left the machine, and only now is the body written, so the
//     harness and the drill can read the code from it). A real send never
//     leaves a code at rest, not even while it is in flight.
import { randomBytes } from "node:crypto";
import { platformDb } from "./control.js";
import { sendMail } from "../mail.js";

// line 8: an operator's help mails (sign-in help with a reset link, an owner
// invite, a "start again" note); each goes only to an address on file.
// line 9: the owner invite for a store an operator created ("operator_store_invite").
// Phase 2 line 8: a merchant's team invite ("team_invite"), sent only when mail is set up.
// Phase 3 line 2: the owner's notice of a suspend or resume ("store_suspended", "store_resumed").
export const PLATFORM_MAIL_KINDS = Object.freeze(["signup_code", "signup_existing", "operator_signin_help", "operator_owner_invite", "operator_start_again", "operator_store_invite", "team_invite", "store_suspended", "store_resumed"]);
const pmlId = () => `pml_${randomBytes(8).toString("hex")}`;

export async function sendPlatformMail({ kind, to, subject, text, ref = null }) {
  if (!PLATFORM_MAIL_KINDS.includes(kind)) throw new Error(`unknown platform mail kind "${kind}"`);
  const id = pmlId();
  const now = new Date().toISOString();
  await platformDb().execute({
    sql: "INSERT INTO platform_mail (id, kind, recipient, subject, body, status, ref, created_at) VALUES (?,?,?,?,?,?,?,?)",
    args: [id, kind, String(to), String(subject), null, "failed", ref, now],
  });
  let r;
  try {
    r = await sendMail({ to, subject, text });
  } catch (e) {
    r = { ok: false, error: String(e?.message || e) };
  }
  // a mock is only ever a non-production result; production treats it as failed
  const mock = r.ok && r.mock && process.env.NODE_ENV !== "production";
  const status = r.ok ? (mock ? "mock" : r.mock ? "failed" : "sent") : "failed";
  await platformDb().execute({
    sql: "UPDATE platform_mail SET status = ?, provider_id = ?, error = ?, sent_at = ?, body = ? WHERE id = ?",
    args: [status, r.id || null, status === "failed" ? String(r.error || "send failed").slice(0, 300) : null, status === "failed" ? null : new Date().toISOString(), mock ? String(text) : null, id],
  });
  return { id, status, ok: Boolean(r.ok) };
}
