// Phase 4 line 3: custom apps (external plugins) and their webhook endpoint.
// SERVER-ONLY, tenant-scoped (withTenant); Node-only through the egress
// guard's save-time check, so only admin routes import it.
//
// A custom app is a plugin_installs row (kind 'custom', plugin_id
// 'custom:<16 hex>', its name) plus a plugin_endpoints row (its HTTPS address,
// the single host approved with it, its topics and its signing secret). The
// secret leaves here exactly twice: in the answer to create and to rotate.
// Nothing returns secret_enc. Every write records an audit row on app:<id>.
//
//   createCustomApp({ name, url, topics, scopes }, { actor }) → { install, secret }
//   saveEndpoint(id, url)       re-validated; a host change is audited as an
//                               allowlist change (apps.endpoint_allowlist_changed)
//   rotateSecret(id)            → { secret }; the old one keeps signing for 24 h
//   pauseEndpoint / resumeEndpoint
//   sendTestEvent(id)           a ping delivery to this app only
//   webhooksView(id, { role, status, topic })  endpoint + the last 50 deliveries
import { db, libsql } from "../db.js";
import { audit } from "../platform/audit.js";
import { encryptSecret } from "../platform/crypto.js";
import { newId } from "../platform/sessions.js";
import { APP_PERMISSIONS } from "../platform/authz.js";
import { redactsPii } from "../admin/order-view.js";
import { AppError, getInstall } from "./installs.js";
import { PAUSE_REASONS, SUBSCRIBABLE, TOPICS, requiredScope } from "./topics.js";
import { newSigningSecret } from "./sign.js";
import { checkEndpointUrl } from "./egress.js";
import { enqueueDelivery } from "./events.js";


export const MAX_CUSTOM_APPS = 10;
export const ROTATION_OVERLAP_MS = 24 * 60 * 60_000;
export const DELIVERIES_SHOWN = 50;
export const DELIVERY_STATUSES = Object.freeze(["delivered", "retrying", "failed", "skipped", "pending"]);

const nowIso = () => new Date().toISOString();
const actorString = (actor) => `${actor?.kind ?? "system"}:${actor?.id ?? ""}`;
const resourceOf = (id) => `app:${id}`;
const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const asStatement = (q) => {
  const { sql, parameters } = q.compile();
  return { sql, args: parameters };
};
const NOT_FOUND = () => new AppError(404, "NOT_FOUND", "This app isn't installed on your store. It may have been uninstalled.");

// The topics and permissions asked for, checked. → { topics, scopes }
function checkAsk({ topics, scopes }) {
  const t = Array.isArray(topics) ? [...new Set(topics.map(String))] : [];
  if (!t.length) throw new AppError(422, "TOPICS_INVALID", "Choose at least one event to send.", { errors: { topics: "Choose at least one event to send." } });
  if (t.some((x) => !SUBSCRIBABLE.includes(x))) throw new AppError(422, "TOPICS_INVALID", "One of those events isn't offered.", { errors: { topics: "One of those events isn't offered." } });
  const s = Array.isArray(scopes) ? [...new Set(scopes.map(String))] : [];
  if (s.some((x) => !Object.hasOwn(APP_PERMISSIONS, x))) throw new AppError(422, "SCOPES_INVALID", "One of those permissions isn't offered.", { errors: { scopes: "One of those permissions isn't offered." } });
  const missing = [...new Set(t.map(requiredScope))].filter((x) => x && !s.includes(x));
  if (missing.length) throw new AppError(422, "SCOPES_INVALID", `These events need the "${APP_PERMISSIONS[missing[0]]}" permission.`, { errors: { scopes: `These events need the "${APP_PERMISSIONS[missing[0]]}" permission.` } });
  return { topics: t.sort(), scopes: s.sort() };
}

async function checkedUrl(url) {
  const c = await checkEndpointUrl(url);
  if (!c.ok) throw new AppError(422, "ENDPOINT_INVALID", c.reason, { errors: { url: c.reason } });
  return c;
}

async function customRow(id) {
  if (typeof id !== "string" || !/^pin_[0-9a-f]{16}$/.test(id)) return null;
  const row = await db.selectFrom("plugin_installs").selectAll().where("id", "=", id).executeTakeFirst();
  return row && row.status !== "uninstalled" ? row : null;
}

async function endpointOf(id) {
  const row = await customRow(id);
  if (!row) throw NOT_FOUND();
  if (row.kind !== "custom") throw new AppError(409, "NOT_CUSTOM", `${row.name || "This app"} isn't a custom app, so it has no webhook address.`);
  const ep = await db.selectFrom("plugin_endpoints").selectAll().where("install_id", "=", id).executeTakeFirst();
  if (!ep) throw new AppError(409, "NO_ENDPOINT", `${row.name || "This app"} has no webhook address.`);
  return { row, ep };
}

export async function createCustomApp({ name, url, topics, scopes } = {}, { actor }) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || n.length > 60) throw new AppError(422, "NAME_INVALID", "Give the app a name of up to 60 characters.", { errors: { name: "Give the app a name of up to 60 characters." } });
  const ask = checkAsk({ topics, scopes });
  const live = await db.selectFrom("plugin_installs").select(({ fn }) => fn.countAll().as("n")).where("kind", "=", "custom").where("status", "<>", "uninstalled").executeTakeFirst();
  if (Number(live?.n ?? 0) >= MAX_CUSTOM_APPS) throw new AppError(409, "TOO_MANY", `${n} wasn't created: a store can have up to ${MAX_CUSTOM_APPS} custom apps. Uninstall one to add another.`);
  const c = await checkedUrl(url);
  const secret = newSigningSecret();
  let secretEnc;
  try {
    secretEnc = await encryptSecret(secret);
  } catch {
    throw new AppError(503, "SECRETS_UNAVAILABLE", "Custom apps can't be created on this store right now. Nothing was saved. Try again later.");
  }
  const at = nowIso();
  const by = actorString(actor);
  const id = newId("pin");
  const pluginId = `custom:${newId("x").slice(2)}`;
  // the limit is counted inside the insert, in one transaction with the
  // endpoint (written only when the install was), so two creates at 9 give one app
  const LIVE_CUSTOM = "SELECT COUNT(*) FROM plugin_installs WHERE kind = 'custom' AND status <> 'uninstalled'";
  const [inserted] = await libsql.batch(
    [
      {
        sql: `INSERT INTO plugin_installs (id, plugin_id, kind, name, version, status, granted_scopes, settings, secrets_enc, installed_by, installed_at, updated_by, updated_at)
              SELECT ?, ?, 'custom', ?, '1.0.0', 'enabled', ?, '{}', NULL, ?, ?, ?, ? WHERE (${LIVE_CUSTOM}) < ?`,
        args: [id, pluginId, n, JSON.stringify(ask.scopes), by, at, by, at, MAX_CUSTOM_APPS],
      },
      {
        sql: `INSERT INTO plugin_endpoints (id, install_id, url, host, topics, secret_enc, status, created_by, created_at, updated_by, updated_at)
              SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM plugin_installs WHERE id = ?)`,
        args: [newId("pwe"), id, c.url, c.host, JSON.stringify(ask.topics), secretEnc, by, at, by, at, id],
      },
    ],
    "write",
  );
  if (!Number(inserted?.rowsAffected ?? 0)) throw new AppError(409, "TOO_MANY", `${n} wasn't created: a store can have up to ${MAX_CUSTOM_APPS} custom apps. Uninstall one to add another.`);
  await audit({ actor, action: "apps.create_custom", resource: resourceOf(id), diff: { name: n, host: c.host, topics: ask.topics, scopes: ask.scopes } });
  return { install: (await getInstall(id)).install, secret };
}

async function updateEndpoint(ep, patch, actor) {
  const r = await db
    .updateTable("plugin_endpoints")
    .set({ ...patch, updated_at: nowIso(), updated_by: actorString(actor) })
    .where("id", "=", ep.id)
    .where("updated_at", "=", ep.updated_at)
    .executeTakeFirst();
  if (!Number(r?.numUpdatedRows ?? 0)) throw new AppError(409, "CHANGED", "The webhook was changed somewhere else. Nothing was saved. Reload the page and try again.");
}

// { url, topics? }: a new address (and optionally the events it gets)
export async function saveEndpoint(id, { url, topics } = {}, { actor }) {
  const { row, ep } = await endpointOf(id);
  const c = await checkedUrl(url);
  const patch = { url: c.url, host: c.host, failing_since: null };
  let newTopics = null;
  if (topics !== undefined) {
    newTopics = checkAsk({ topics, scopes: parse(row.granted_scopes, []) }).topics;
    patch.topics = JSON.stringify(newTopics);
  }
  await updateEndpoint(ep, patch, actor);
  const hostChanged = c.host !== ep.host;
  await audit({
    actor,
    action: hostChanged ? "apps.endpoint_allowlist_changed" : "apps.endpoint_saved",
    resource: resourceOf(id),
    diff: { ...(hostChanged ? { host: { from: ep.host, to: c.host } } : {}), ...(newTopics ? { topics: newTopics } : {}) },
  });
  return webhooksView(id, { role: actor?.role });
}

export async function rotateSecret(id, { actor }) {
  const { ep } = await endpointOf(id);
  const secret = newSigningSecret();
  let enc;
  try {
    enc = await encryptSecret(secret);
  } catch {
    throw new AppError(503, "SECRETS_UNAVAILABLE", "The secret can't be changed on this store right now. Nothing was changed. Try again later.");
  }
  const until = new Date(Date.now() + ROTATION_OVERLAP_MS).toISOString();
  await updateEndpoint(ep, { secret_enc: enc, prev_secret_enc: ep.secret_enc, prev_secret_until: until }, actor);
  await audit({ actor, action: "apps.secret_rotated", resource: resourceOf(id), diff: { old_secret_signs_until: until } });
  return { secret, oldSecretSignsUntil: until };
}

export async function pauseEndpoint(id, { actor }) {
  const { row, ep } = await endpointOf(id);
  if (ep.status === "paused") throw new AppError(409, "ALREADY_PAUSED", `${row.name}'s webhooks are already paused.`);
  await updateEndpoint(ep, { status: "paused", paused_reason: PAUSE_REASONS.manual, paused_at: nowIso() }, actor);
  await audit({ actor, action: "apps.endpoint_paused", resource: resourceOf(id) });
  return webhooksView(id, { role: actor?.role });
}

export async function resumeEndpoint(id, { actor }) {
  const { row, ep } = await endpointOf(id);
  if (ep.status !== "paused") throw new AppError(409, "NOT_PAUSED", `${row.name}'s webhooks are already on.`);
  await updateEndpoint(ep, { status: "active", paused_reason: null, paused_at: null, failing_since: null }, actor);
  await audit({ actor, action: "apps.endpoint_resumed", resource: resourceOf(id) });
  return webhooksView(id, { role: actor?.role });
}

// A ping to this app only: its own event and one delivery, written in one batch.
export async function sendTestEvent(id, { actor }) {
  const { row, ep } = await endpointOf(id);
  if (row.status !== "enabled") throw new AppError(409, "APP_OFF", `Turn ${row.name} on to send it a test event.`);
  if (ep.status === "paused") throw new AppError(409, "PAUSED", `${row.name}'s webhooks are paused. Resume them to send a test event.`);
  const at = nowIso();
  const evt = newId("evt");
  const dlv = newId("dlv");
  await libsql.batch(
    [
      asStatement(db.insertInto("plugin_events").values({ id: evt, topic: "ping", resource: resourceOf(id), idempotency_key: `ping:${id}:${evt}`, payload: JSON.stringify({ message: "A test event from Storeasy." }), created_at: at, fanned_out_at: at })),
      asStatement(db.insertInto("plugin_deliveries").values({ id: dlv, event_id: evt, install_id: id, target: "http", status: "pending", attempts: 0, next_attempt_at: at, created_at: at, updated_at: at })),
    ],
    "write",
  );
  await enqueueDelivery(dlv, id);
  await audit({ actor, action: "apps.test_event_sent", resource: resourceOf(id), diff: { delivery: dlv } });
  return { deliveryId: dlv, eventId: evt };
}

const displayStatus = (d) => (d.status === "pending" ? (Number(d.attempts) > 0 ? "retrying" : "pending") : String(d.status));

// "https://hooks.example.com/…": the host only, for roles that don't see
// customer details (a path or query can hold the app's own token)
export function maskedUrl(url) {
  try {
    const u = new URL(String(url));
    return u.pathname === "/" && !u.search ? `${u.origin}/` : `${u.origin}/…`;
  } catch {
    return "…";
  }
}

function endpointView(ep, role) {
  if (!ep) return null;
  const now = nowIso();
  return {
    id: String(ep.id),
    url: redactsPii(role) ? maskedUrl(ep.url) : String(ep.url),
    host: String(ep.host),
    topics: parse(ep.topics, []),
    status: String(ep.status),
    pausedReason: ep.paused_reason ?? null,
    pausedAt: ep.paused_at ?? null,
    failingSince: ep.failing_since ?? null,
    oldSecretSignsUntil: ep.prev_secret_until && ep.prev_secret_until > now ? String(ep.prev_secret_until) : null,
  };
}

// What support and operator support see in place of a delivery's error text.
export const SUPPORT_DELIVERY_ERROR = "This wasn't delivered. An owner, admin or staff member can see why.";

// The Webhooks card and the Deliveries table. Payloads only for roles that
// see customer details elsewhere (support and operator support get status only).
export async function webhooksView(id, { role, status = null, topic = null } = {}) {
  const row = await customRow(id);
  if (!row) throw NOT_FOUND();
  const ep = row.kind === "custom" ? await db.selectFrom("plugin_endpoints").selectAll().where("install_id", "=", id).executeTakeFirst() : null;
  let q = db
    .selectFrom("plugin_deliveries as d")
    .innerJoin("plugin_events as e", "e.id", "d.event_id")
    .select(["d.id", "d.event_id", "d.status", "d.attempts", "d.next_attempt_at", "d.last_attempt_at", "d.last_status", "d.last_error", "d.last_ms", "d.delivered_at", "d.created_at", "e.topic", "e.payload"])
    .where("d.install_id", "=", id);
  if (status === "retrying") q = q.where("d.status", "=", "pending").where("d.attempts", ">", 0);
  else if (status === "pending") q = q.where("d.status", "=", "pending").where("d.attempts", "=", 0);
  else if (DELIVERY_STATUSES.includes(status)) q = q.where("d.status", "=", status);
  if (topic && Object.hasOwn(TOPICS, topic)) q = q.where("e.topic", "=", topic);
  const rows = await q.orderBy("d.created_at", "desc").orderBy("d.id", "desc").limit(DELIVERIES_SHOWN).execute();
  const showPayload = !redactsPii(role);
  return {
    endpoint: endpointView(ep, role),
    topics: SUBSCRIBABLE.map((t) => ({ topic: t, words: TOPICS[t].words })),
    canSeePayloads: showPayload,
    deliveries: rows.map((d) => ({
      id: String(d.id),
      eventId: String(d.event_id),
      topic: String(d.topic),
      status: displayStatus(d),
      attempts: Number(d.attempts),
      lastStatus: d.last_status == null ? null : Number(d.last_status),
      lastError: d.last_error == null ? null : showPayload ? String(d.last_error) : SUPPORT_DELIVERY_ERROR,
      nextAttemptAt: d.status === "pending" ? (d.next_attempt_at ?? null) : null,
      lastMs: d.last_ms == null ? null : Number(d.last_ms),
      createdAt: String(d.created_at),
      deliveredAt: d.delivered_at ?? null,
      ...(showPayload ? { payload: parse(d.payload, null) } : {}),
    })),
  };
}
