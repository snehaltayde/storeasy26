// Mail the platform itself sends (Phase 1 line 1: signup codes). Node-only.
//
//   sendPlatformMail({ kind, to, subject, text, ref }) -> { id, status, ok }
//     Records a platform_mail row, sends inline through lib/mail.js, then
//     settles the row: "sent" (provider id kept, body nulled), "failed" (error
//     kept, body nulled) or "mock" (no provider configured: nothing left the
//     machine and the body stays, so the harness and the drill can read the
//     code from it). A real send never leaves a code at rest.
import { randomBytes } from "node:crypto";
import { platformDb } from "./control.js";
import { sendMail } from "../mail.js";

export const PLATFORM_MAIL_KINDS = Object.freeze(["signup_code", "signup_existing"]);
const pmlId = () => `pml_${randomBytes(8).toString("hex")}`;

export async function sendPlatformMail({ kind, to, subject, text, ref = null }) {
  if (!PLATFORM_MAIL_KINDS.includes(kind)) throw new Error(`unknown platform mail kind "${kind}"`);
  const id = pmlId();
  const now = new Date().toISOString();
  await platformDb().execute({
    sql: "INSERT INTO platform_mail (id, kind, recipient, subject, body, status, ref, created_at) VALUES (?,?,?,?,?,?,?,?)",
    args: [id, kind, String(to), String(subject), String(text), "failed", ref, now],
  });
  let r;
  try {
    r = await sendMail({ to, subject, text });
  } catch (e) {
    r = { ok: false, error: String(e?.message || e) };
  }
  const status = r.ok ? (r.mock ? "mock" : "sent") : "failed";
  await platformDb().execute({
    sql: `UPDATE platform_mail SET status = ?, provider_id = ?, error = ?, sent_at = ?,
            body = CASE WHEN ? = 'mock' THEN body ELSE NULL END
          WHERE id = ?`,
    args: [status, r.id || null, r.ok ? null : String(r.error || "send failed").slice(0, 300), r.ok ? new Date().toISOString() : null, status, id],
  });
  return { id, status, ok: Boolean(r.ok) };
}
