// The newest signup code mailed to an address, for the signup drill and local
// testing (Phase 1 line 1). A helper, not a suite: nothing runs on import.
//
//   latestSignupCode({ platformUrl, email }) -> { code, at, id } or null
//     Reads the control plane's platform_mail: only a "mock" row (mail not
//     configured, so the body was kept); a real send nulls its body and is
//     never readable here. platformUrl must be a local database (file:<path>
//     or http://127.0.0.1:<port>, as assertSeedDbUrl allows); anything else
//     is refused before a connection is made. Read only.
//   latestPlatformMail({ platformUrl, kind, recipient }) -> { body, at, id, ref } or null
//     The newest mock platform_mail of that kind to that address (line 8:
//     the operator's sign-in help, owner invite and start-again mails).
import { assertSeedDbUrl } from "../seed-roles-store.js";

export async function latestSignupCode({ platformUrl, email } = {}) {
  const url = assertSeedDbUrl("The platform database URL", platformUrl);
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url });
  try {
    const r = await c.execute({
      sql: "SELECT id, body, created_at FROM platform_mail WHERE kind = 'signup_code' AND status = 'mock' AND recipient = lower(?) ORDER BY created_at DESC, rowid DESC LIMIT 1",
      args: [String(email || "").trim()],
    });
    const row = r.rows[0];
    const code = row ? String(row.body || "").match(/\b(\d{6})\b/)?.[1] : null;
    return code ? { code, at: row.created_at, id: row.id } : null;
  } finally {
    c.close();
  }
}

export async function latestPlatformMail({ platformUrl, kind, recipient } = {}) {
  const url = assertSeedDbUrl("The platform database URL", platformUrl);
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url });
  try {
    const r = await c.execute({
      sql: "SELECT id, body, ref, created_at FROM platform_mail WHERE kind = ? AND status = 'mock' AND recipient = lower(?) ORDER BY created_at DESC, rowid DESC LIMIT 1",
      args: [String(kind || ""), String(recipient || "").trim()],
    });
    const row = r.rows[0];
    return row ? { body: String(row.body || ""), at: row.created_at, id: row.id, ref: row.ref } : null;
  } finally {
    c.close();
  }
}
