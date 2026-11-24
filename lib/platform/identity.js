// Identity service (Session 26 / BE02) — NODE-ONLY: scrypt password hashing,
// TOTP (RFC 6238), users, memberships, invitations/password-resets and the
// distributed login throttle. Only login routes, CLIs and tests import this;
// per-request verification is the edge-safe lib/platform/sessions.js.
//
// Standard primitives only (handoff rule: never invent a password protocol):
// scrypt N=16384 r=8 p=1 → 32-byte key, 16-byte salt, constant-time compare.
import { randomBytes, scrypt, timingSafeEqual, createHmac } from "node:crypto";
import { platformDb } from "./control.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { sha256Hex, newId, newToken, revokeUserSessions } from "./sessions.js";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const scryptAsync = (pw, salt, opts) =>
  new Promise((resolve, reject) =>
    scrypt(pw, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p }, (e, k) => (e ? reject(e) : resolve(k))),
  );

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString("base64")}:${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || !stored) return false;
  const parts = String(stored).split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const want = Buffer.from(hashB64, "base64");
  const got = await scryptAsync(password, Buffer.from(saltB64, "base64"), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    keylen: want.length,
  });
  return got.length === want.length && timingSafeEqual(got, want);
}

// --- users -------------------------------------------------------------------

const normEmail = (email) => String(email || "").trim().toLowerCase();

// Phase 1 line 1: the rules a new password meets (8–200 characters, not the
// email). Returns the plain reason, or null when it is fine.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export function passwordProblem(password, email = "") {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (email && password.trim().toLowerCase() === normEmail(email)) return "Your password can't be your email address.";
  return null;
}

// passwordHash: an already-hashed password (a verified signup hashed it when
// the founder typed it; it is never kept in plain text). emailVerifiedAt: when
// the address was proved (signup's email code).
export async function createUser({ email, name = null, password, passwordHash = null, emailVerifiedAt = null, isOperator = false }) {
  const e = normEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("valid email required");
  if (passwordHash != null && !/^scrypt:\d+:\d+:\d+:[^:]+:[^:]+$/.test(String(passwordHash))) throw new Error("passwordHash must be a scrypt hash");
  const id = newId("u");
  const now = new Date().toISOString();
  // email_verified_at (platform migration 0011) is named only when it is set,
  // so a control plane on the bare baseline schema still takes new users
  const verified = emailVerifiedAt ? [", email_verified_at", ", ?", [emailVerifiedAt]] : ["", "", []];
  await platformDb().execute({
    sql: `INSERT INTO users (id, email, name, password_hash, is_operator, status, created_at, updated_at${verified[0]})
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?${verified[1]})`,
    args: [id, e, name, passwordHash ?? (await hashPassword(password)), isOperator ? 1 : 0, now, now, ...verified[2]],
  });
  return getUser(id);
}

export async function getUser(id) {
  const res = await platformDb().execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] });
  return res.rows[0] ? { ...res.rows[0] } : null;
}

export async function findUserByEmail(email) {
  const res = await platformDb().execute({
    sql: "SELECT * FROM users WHERE email = ?",
    args: [normEmail(email)],
  });
  return res.rows[0] ? { ...res.rows[0] } : null;
}

// Password change revokes every session — a stolen session dies with the reset.
export async function setUserPassword(userId, password) {
  await platformDb().execute({
    sql: "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
    args: [await hashPassword(password), new Date().toISOString(), userId],
  });
  await revokeUserSessions(userId);
}

export async function setUserStatus(userId, status) {
  if (!["active", "disabled"].includes(status)) throw new Error("status must be active|disabled");
  await platformDb().execute({
    sql: "UPDATE users SET status = ?, updated_at = ? WHERE id = ?",
    args: [status, new Date().toISOString(), userId],
  });
  if (status === "disabled") await revokeUserSessions(userId);
}

export async function countOwners(tenantId) {
  const res = await platformDb().execute({
    sql: "SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND role = 'owner'",
    args: [tenantId],
  });
  return Number(res.rows[0]?.n || 0);
}

// S27 (BE03): final-owner protection — a store can never lose its last owner,
// neither by demotion (here) nor by removal (removeMembership below).
export async function addMembership(userId, tenantId, role = "admin") {
  if (!["owner", "admin", "staff", "support"].includes(role)) throw new Error("bad role");
  const existing = await platformDb().execute({
    sql: "SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?",
    args: [userId, tenantId],
  });
  if (existing.rows[0]?.role === "owner" && role !== "owner" && (await countOwners(tenantId)) <= 1) {
    throw new Error("cannot demote the last owner — grant owner to someone else first");
  }
  await platformDb().execute({
    sql: `INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role`,
    args: [userId, tenantId, role, new Date().toISOString()],
  });
}

export async function removeMembership(userId, tenantId) {
  const existing = await platformDb().execute({
    sql: "SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?",
    args: [userId, tenantId],
  });
  if (!existing.rows[0]) return false;
  if (existing.rows[0].role === "owner" && (await countOwners(tenantId)) <= 1) {
    throw new Error("cannot remove the last owner — grant owner to someone else first");
  }
  await platformDb().execute({
    sql: "DELETE FROM memberships WHERE user_id = ? AND tenant_id = ?",
    args: [userId, tenantId],
  });
  // No permission cache exists to invalidate: authorization is a fresh
  // membership lookup per request, so revocation is effective immediately —
  // including in already-open tabs (MC23 verification case).
  return true;
}

// Create-or-promote an operator (bootstrap CLI; TOTP enrolls at first login).
export async function createOperator({ email, name = null, password = null }) {
  const existing = await findUserByEmail(email);
  if (existing) {
    const args = password
      ? [await hashPassword(password), new Date().toISOString(), existing.id]
      : [new Date().toISOString(), existing.id];
    await platformDb().execute({
      sql: password
        ? "UPDATE users SET is_operator = 1, password_hash = ?, updated_at = ? WHERE id = ?"
        : "UPDATE users SET is_operator = 1, updated_at = ? WHERE id = ?",
      args,
    });
    return getUser(existing.id);
  }
  if (!password) throw new Error("password required for a new operator");
  return createUser({ email, name, password, isOperator: true });
}

// --- TOTP (RFC 6238: HMAC-SHA1, 30s step, 6 digits) ---------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/=+$/, "")) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = () => base32Encode(randomBytes(20));

export function totpCode(secretBase32, { t = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Math.floor(t / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secretBase32)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code =
    (((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff)) %
    10 ** digits;
  return String(code).padStart(digits, "0");
}

export function verifyTotp(secretBase32, code, { t = Date.now(), step = 30, digits = 6, window = 1 } = {}) {
  const want = String(code || "").trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(want)) return false;
  for (let w = -window; w <= window; w++) {
    if (totpCode(secretBase32, { t: t + w * step * 1000, step, digits }) === want) return true;
  }
  return false;
}

export const totpUri = (secret, email, issuer = "Storeasy") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// Returns the user's TOTP secret (plaintext base32), creating + persisting one
// (encrypted at rest) on first call. Only the operator login flow uses this.
export async function ensureTotpSecret(userId) {
  const user = await getUser(userId);
  if (!user) throw new Error("user not found");
  if (user.totp_enc) return decryptSecret(user.totp_enc);
  const secret = generateTotpSecret();
  await platformDb().execute({
    sql: "UPDATE users SET totp_enc = ?, totp_confirmed = 0, updated_at = ? WHERE id = ?",
    args: [await encryptSecret(secret), new Date().toISOString(), userId],
  });
  return secret;
}

export async function confirmTotp(userId) {
  await platformDb().execute({
    sql: "UPDATE users SET totp_confirmed = 1, updated_at = ? WHERE id = ?",
    args: [new Date().toISOString(), userId],
  });
}

// --- invitations & password resets --------------------------------------------

export async function createInvite({
  email,
  tenantId = null,
  role = "admin",
  kind = "invite",
  invitedBy = null,
  ttlMs = 7 * 24 * 60 * 60 * 1000,
}) {
  const token = newToken();
  const id = newId("i");
  const now = Date.now();
  await platformDb().execute({
    sql: `INSERT INTO invitations (id, token_hash, kind, email, tenant_id, role, invited_by, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      await sha256Hex(token),
      kind,
      normEmail(email),
      tenantId,
      role,
      invitedBy,
      new Date(now).toISOString(),
      new Date(now + ttlMs).toISOString(),
    ],
  });
  return { id, token, expiresAt: new Date(now + ttlMs).toISOString() };
}

// Single-use consume: atomically stamps accepted_at; expired/used/missing → null.
// Merchant invites are tenant-bound and the tenant check lives INSIDE the
// UPDATE's WHERE clause, so an acceptance attempt from the wrong store host is
// rejected WITHOUT burning the token (a wrong-host probe can't invalidate a
// legitimate invitation).
export async function consumeInvite(token, { kind = "invite", tenantId = null } = {}) {
  if (!token) return null;
  const now = new Date().toISOString();
  const sql = `UPDATE invitations SET accepted_at = ?
          WHERE token_hash = ? AND kind = ? AND accepted_at IS NULL AND expires_at > ?
            AND ${tenantId ? "tenant_id = ?" : "tenant_id IS NULL"}
          RETURNING *`;
  const args = [now, await sha256Hex(token), kind, now, ...(tenantId ? [tenantId] : [])];
  const res = await platformDb().execute({ sql, args });
  return res.rows[0] ? { ...res.rows[0] } : null;
}

// Invite acceptance → user (created or existing) + membership.
export async function acceptInvite({ token, name, password, tenantId }) {
  const invite = await consumeInvite(token, { kind: "invite", tenantId });
  if (!invite) return null;
  let user = await findUserByEmail(invite.email);
  if (!user) {
    user = await createUser({ email: invite.email, name, password });
  }
  await addMembership(user.id, invite.tenant_id, invite.role || "admin");
  return user;
}

// Password reset: consume a 'reset' token (user-scoped — any tenant host),
// set the password, revoke every session.
export async function acceptReset({ token, password }) {
  if (!token) return null;
  const res = await platformDb().execute({
    sql: `UPDATE invitations SET accepted_at = ?
          WHERE token_hash = ? AND kind = 'reset' AND accepted_at IS NULL AND expires_at > ?
          RETURNING *`,
    args: [new Date().toISOString(), await sha256Hex(token), new Date().toISOString()],
  });
  const row = res.rows[0] ? { ...res.rows[0] } : null;
  if (!row) return null;
  const user = await findUserByEmail(row.email);
  if (!user) return null;
  await setUserPassword(user.id, password); // revokes all sessions
  return user;
}

// --- distributed login throttle (control-plane counters, BE02) ----------------

export async function loginThrottle(key, { limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  const resetAt = new Date(now + windowMs).toISOString();
  const nowIso = new Date(now).toISOString();
  const res = await platformDb().execute({
    sql: `INSERT INTO login_limits (key, count, reset_at) VALUES (?, 1, ?)
          ON CONFLICT(key) DO UPDATE SET
            count = CASE WHEN login_limits.reset_at < ? THEN 1 ELSE login_limits.count + 1 END,
            reset_at = CASE WHEN login_limits.reset_at < ? THEN ? ELSE login_limits.reset_at END
          RETURNING count, reset_at`,
    args: [key, resetAt, nowIso, nowIso, resetAt],
  });
  const count = Number(res.rows[0]?.count || 1);
  return { blocked: count > limit, count };
}

export async function clearThrottle(key) {
  await platformDb().execute({ sql: "DELETE FROM login_limits WHERE key = ?", args: [key] });
}

// P2-DOCS (DOC-08): the plain names of one store's team, for "who" in a
// document's earlier versions. Map<userId, name>: the user's name only.
// Phase 0 line 2 (S3): never the email, which every read-only role would see in
// history and publish labels; someone without a name, like someone who has
// left the store, reads "Someone on your team" (lib/documents/versions.js).
export async function teamMemberNames(tenantId) {
  const res = await platformDb().execute({
    sql: "SELECT u.id AS id, u.name AS name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ?",
    args: [String(tenantId ?? "")],
  });
  const names = new Map();
  for (const r of res.rows) {
    if (typeof r.name === "string" && r.name.trim()) names.set(String(r.id), r.name.trim());
  }
  return names;
}
