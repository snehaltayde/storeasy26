// Notification service (Session 39 / BE23). SERVER-ONLY (imports db).
//
// THE one send path for tenant-scoped messages: every message is a durable
// intent row FIRST (status queued), delivered by the jobs queue (type
// send_notification → lib/mail.js), so a provider blip retries with backoff
// and the row always tells the truth: queued | sent | failed. Dedupe via
// idempotency_key (a replayed trigger returns the existing intent). Marketing
// is separated at the schema level: consent_class='marketing' REQUIRES a
// consent reference or notify() refuses — transactional mail never mixes with
// it. (Control-plane identity mail — invites/password resets — predates this
// service and stays on lib/mail.js directly: it is platform-scoped, not
// tenant-scoped, and has no tenant DB to record intents in. Recorded in BE23.)
import { db } from "./db.js";
import { enqueueJob } from "./platform/jobs.js";
import { platformConfigured } from "./platform/control.js";
import { tenantId } from "./tenant-context.js";
import { slog } from "./log.js";

const ntfId = () => "ntf_" + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");

// Create the durable intent + enqueue delivery. Returns the row (existing one
// when the idempotency key has been seen). `to` may be empty — the intent is
// then recorded FAILED immediately with an honest error instead of silently
// dropping the message.
export async function notify({ type, to, subject, text, idempotencyKey = null, consentClass = "transactional", consentRef = null }) {
  if (!type) throw new Error("notification type required");
  if (consentClass === "marketing" && !consentRef) throw new Error("marketing messages require a consent reference");
  if (!["transactional", "marketing"].includes(consentClass)) throw new Error(`unknown consent class "${consentClass}"`);

  if (idempotencyKey) {
    const existing = await db.selectFrom("notifications").selectAll().where("idempotency_key", "=", idempotencyKey).executeTakeFirst();
    if (existing) return { ...existing, deduped: true };
  }

  const recipient = String(to || "").trim();
  const row = {
    id: ntfId(),
    type,
    recipient,
    subject: String(subject || "").slice(0, 300),
    body: String(text || "").slice(0, 20000),
    status: recipient ? "queued" : "failed",
    error: recipient ? null : "no recipient configured (set a support email in site settings)",
    provider_id: null,
    consent_class: consentClass,
    consent_ref: consentRef,
    idempotency_key: idempotencyKey,
    created_at: new Date().toISOString(),
    sent_at: null,
  };
  await db.insertInto("notifications").values(row).execute();
  let jobId = null;
  if (row.status === "queued") {
    if (platformConfigured()) {
      const job = await enqueueJob({
        type: "send_notification",
        tenantId: tenantId() === "_default" ? null : tenantId(),
        payload: { notificationId: row.id },
        idempotencyKey: `notif_${row.id}`,
      });
      jobId = job?.id ?? null;
    } else {
      // legacy mode has no jobs queue — deliver inline, row still records truth
      await deliverNotification(row.id).catch(() => {});
    }
  }
  slog("notification_queued", { id: row.id, type, status: row.status });
  return { ...row, deduped: false, jobId };
}

// Worker entry (idempotent — the queue is at-least-once). Sent rows complete
// without re-sending; failures throw so the job's backoff governs retries,
// with the row's status/error always reflecting the latest attempt.
export async function deliverNotification(notificationId) {
  const row = await db.selectFrom("notifications").selectAll().where("id", "=", notificationId).executeTakeFirst();
  if (!row) throw new Error(`notification ${notificationId} not found`);
  if (row.status === "sent") return { already: true };
  if (!row.recipient) return { skipped: "no recipient" }; // recorded failed at intent time

  const { sendMail } = await import("./mail.js");
  const r = await sendMail({ to: row.recipient, subject: row.subject, text: row.body });
  if (r.ok) {
    await db
      .updateTable("notifications")
      .set({ status: "sent", provider_id: r.mock ? "mock" : r.id || null, error: r.mock ? "mail provider not configured — dev mock, nothing was sent" : null, sent_at: new Date().toISOString() })
      .where("id", "=", row.id)
      .execute();
    return { sent: true, mock: !!r.mock };
  }
  await db.updateTable("notifications").set({ status: "failed", error: String(r.error || "send failed").slice(0, 300) }).where("id", "=", row.id).execute();
  throw new Error(r.error || "send failed"); // job backoff retries; row already says failed
}

export async function listNotifications({ limit = 30 } = {}) {
  try {
    const rows = await db
      .selectFrom("notifications")
      .select(["id", "type", "recipient", "subject", "status", "error", "provider_id", "consent_class", "created_at", "sent_at"])
      .orderBy("created_at", "desc")
      .limit(Math.min(limit, 100))
      .execute();
    return rows.map((r) => ({ ...r }));
  } catch {
    return []; // pre-migration tenant
  }
}

// ---- contact messages (SF15) -------------------------------------------------

const msgId = () => "msg_" + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");

export function validateContact({ name, email, message }) {
  const errors = [];
  const n = String(name || "").trim().slice(0, 120);
  const e = String(email || "").trim().slice(0, 200);
  const m = String(message || "").trim().slice(0, 4000);
  if (!n) errors.push("Please tell us your name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) errors.push("That email doesn't look right.");
  if (m.length < 10) errors.push("Please write a few words more (at least 10 characters).");
  return { ok: !errors.length, errors, value: { name: n, email: e, message: m } };
}

// Store the message + queue the merchant notification. supportEmail may be
// empty — the message is still stored (the console inbox shows it) and the
// notification records failed/no-recipient honestly.
export async function submitContactMessage({ name, email, message }, { supportEmail, storeName = "your store" }) {
  const v = validateContact({ name, email, message });
  if (!v.ok) {
    const err = new Error(v.errors.join(" "));
    err.code = "CONTACT_INVALID";
    err.errors = v.errors;
    throw err;
  }
  const id = msgId();
  const ntf = await notify({
    type: "contact_message",
    to: supportEmail,
    subject: `[${storeName}] New message from ${v.value.name}`,
    text: `From: ${v.value.name} <${v.value.email}>\n\n${v.value.message}\n\n— sent from the ${storeName} contact page; reply directly to the shopper's address above.`,
    idempotencyKey: `contact_${id}`,
  });
  await db
    .insertInto("contact_messages")
    .values({ id, name: v.value.name, email: v.value.email, message: v.value.message, notification_id: ntf.id, created_at: new Date().toISOString() })
    .execute();
  return { id, notificationId: ntf.id, jobId: ntf.jobId ?? null };
}

export async function listContactMessages({ limit = 30 } = {}) {
  try {
    const rows = await db
      .selectFrom("contact_messages as m")
      .leftJoin("notifications as n", "n.id", "m.notification_id")
      .select(["m.id", "m.name", "m.email", "m.message", "m.created_at", "n.status as notify_status", "n.error as notify_error"])
      .orderBy("m.created_at", "desc")
      .limit(Math.min(limit, 100))
      .execute();
    return rows.map((r) => ({ ...r }));
  } catch {
    return [];
  }
}
