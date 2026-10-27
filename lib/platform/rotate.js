// Re-encrypt every stored secret blob under the current WRITE key (S28 / BE13).
// Dual-read makes this safe to run at any time: blobs under either configured
// key decrypt, and everything is written back under configuredSecrets()[0]
// (PLATFORM_SECRET_NEXT while a rotation is open). Nothing is ever orphaned —
// the quirk where swapping PLATFORM_SECRET stranded old ciphertext is gone.
//
// Covered blob stores: tenants.db_token_enc, tenants.secrets_enc,
// users.totp_enc. New stores MUST be added here when they appear.
import { platformDb } from "./control.js";
import { decryptSecret, encryptSecret, keyIds } from "./crypto.js";
import { audit } from "./audit.js";

export async function rotateStoredSecrets({ log = () => {} } = {}) {
  const db = platformDb();
  const [writeFp] = await keyIds();
  const summary = { writeKey: writeFp, tenants: 0, users: 0, skipped: 0, failures: [] };

  const reenc = async (blob) => {
    if (!blob) return null;
    if (String(blob).startsWith(`k1:${writeFp}:`)) return undefined; // already current
    return encryptSecret(await decryptSecret(blob));
  };

  const tenants = await db.execute("SELECT id, db_token_enc, secrets_enc FROM tenants");
  for (const row of tenants.rows) {
    try {
      const token = await reenc(row.db_token_enc);
      const secrets = await reenc(row.secrets_enc);
      if (token === undefined && secrets === undefined) {
        summary.skipped++;
        continue;
      }
      await db.execute({
        sql: "UPDATE tenants SET db_token_enc = ?, secrets_enc = ?, updated_at = ? WHERE id = ?",
        args: [
          token === undefined ? row.db_token_enc : token,
          secrets === undefined ? row.secrets_enc : secrets,
          new Date().toISOString(),
          row.id,
        ],
      });
      summary.tenants++;
      log(`✓ tenant ${row.id}`);
    } catch (e) {
      summary.failures.push({ kind: "tenant", id: row.id, error: String(e?.message || e).slice(0, 200) });
    }
  }

  let users = { rows: [] };
  try {
    users = await db.execute("SELECT id, totp_enc FROM users WHERE totp_enc IS NOT NULL");
  } catch {
    // pre-S26 control plane without a users table — nothing to rotate there
  }
  for (const row of users.rows) {
    try {
      const totp = await reenc(row.totp_enc);
      if (totp === undefined) {
        summary.skipped++;
        continue;
      }
      await db.execute({
        sql: "UPDATE users SET totp_enc = ?, updated_at = ? WHERE id = ?",
        args: [totp, new Date().toISOString(), row.id],
      });
      summary.users++;
      log(`✓ user ${row.id}`);
    } catch (e) {
      summary.failures.push({ kind: "user", id: row.id, error: String(e?.message || e).slice(0, 200) });
    }
  }

  await audit({
    actor: { kind: "cli", id: "cli" },
    action: "platform.secret_rotation",
    tenantId: null,
    diff: { write_key_fp: writeFp, tenants: summary.tenants, users: summary.users, skipped: summary.skipped, failures: summary.failures.length },
  });
  return summary;
}
