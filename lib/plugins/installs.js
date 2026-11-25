// Phase 4 line 1: a store's plugin installs (tenant table plugin_installs,
// migration 0030). SERVER-ONLY, tenant-scoped: every call runs inside
// withTenant() against the store's own database.
//
// Install records the scopes the admin approved; Turn off keeps settings and
// stops everything the plugin does; Uninstall archives the row (status
// 'uninstalled', nothing deleted), so installing again starts fresh. One live
// install per plugin (a unique partial index: two admins installing at once
// give one install and one "Already installed").
//
// What leaves this file for a browser is view(): settings without secrets,
// and each secret only as set or not set. secrets_enc never leaves it.
// Every write records an audit row (apps.install / enable / disable /
// uninstall / settings) and invalidates the store's "plugins" cache tag.
import { db } from "../db.js";
import { tenantId } from "../tenant-context.js";
import { invalidateTenantCache } from "../cache.js";
import { audit, listAudit, auditChanges } from "../platform/audit.js";
import { encryptJson, decryptJson } from "../platform/crypto.js";
import { flagEnabled } from "../platform/flags.js";
import { newId } from "../platform/sessions.js";
import { slog } from "../log.js";
import { infraResponse } from "../infra-response.js";
import { namesFor, plainName } from "../documents/versions.js";
import { catalog, pluginById, killFlag } from "./catalog.js";
import { checkSettings, defaultSettings, secretsSet } from "./settings.js";
import { APP_SCOPES } from "../platform/authz.js";

export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// A failure as the routes answer it: an AppError's own words (and per-field
// errors), a database failure as infraResponse says, anything else a plain
// sentence (its message may hold anything, so it is logged, not sent).
export function appErrorAnswer(e, route) {
  if (e instanceof AppError) return { status: e.status, body: { error: e.message, code: e.code, ...(e.errors ? { errors: e.errors } : {}) } };
  const infra = infraResponse(e, { route }); // DOC-04: a database failure is never a 4xx
  if (infra) return infra;
  slog("apps_failed", { route, error: String(e?.name || "Error") });
  return { status: 500, body: { error: "Something went wrong. Nothing was changed. Try again." } };
}

const nowIso = () => new Date().toISOString();
const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const resourceOf = (id) => `app:${id}`;
// "<kind>:<id>", as documents record who saved (plainName reads it back)
const actorString = (actor) => `${actor?.kind ?? "system"}:${actor?.id ?? ""}`;
const NOT_FOUND = () => new AppError(404, "NOT_FOUND", "This app isn't installed on your store. It may have been uninstalled.");

// Turned off by Storeasy: the plugin's flag is off for this store. A flag that
// doesn't exist, or a control plane that can't be read, leaves it on.
export async function isKilled(pluginId) {
  return !(await flagEnabled(killFlag(pluginId), tenantId(), { fallback: true }));
}

async function killedMap(ids) {
  const out = new Map();
  for (const id of new Set(ids)) out.set(id, await isKilled(id));
  return out;
}

// Which secrets hold a value is kept in the clear beside the encrypted blob,
// as key names only, under a reserved key of the settings JSON (a manifest key
// can't start with "_"), so a read never decrypts anything.
const SECRET_KEYS_FIELD = "__secret_keys";
function splitStored(settingsJson) {
  const all = parse(settingsJson, {});
  const keys = Array.isArray(all[SECRET_KEYS_FIELD]) ? all[SECRET_KEYS_FIELD] : [];
  delete all[SECRET_KEYS_FIELD];
  return { settings: all, secretKeys: keys };
}

function view(row, { killed, names }) {
  const manifest = pluginById(row.plugin_id);
  const { settings, secretKeys } = splitStored(row.settings);
  return {
    id: String(row.id),
    pluginId: String(row.plugin_id),
    kind: String(row.kind),
    name: manifest?.name || row.name || String(row.plugin_id),
    version: String(row.version),
    status: String(row.status),
    available: Boolean(manifest),
    killed: Boolean(killed),
    grantedScopes: parse(row.granted_scopes, []),
    settings,
    secretsSet: manifest ? secretsSet(manifest, Object.fromEntries(secretKeys.map((k) => [k, "set"]))) : {},
    installedByName: plainName(row.installed_by, names),
    installedAt: String(row.installed_at),
    updatedAt: String(row.updated_at),
  };
}

async function liveRows() {
  return db.selectFrom("plugin_installs").selectAll().where("status", "<>", "uninstalled").orderBy("installed_at", "asc").execute();
}

export async function listInstalls() {
  const rows = await liveRows();
  const [killed, names] = await Promise.all([killedMap(rows.map((r) => r.plugin_id)), namesFor(tenantId())]);
  return rows.map((r) => view(r, { killed: killed.get(r.plugin_id), names }));
}

// What Browse shows: each catalog plugin, with what it asks for in plain
// words, whether Storeasy has turned it off, and its live install if any.
export async function catalogView() {
  const rows = await liveRows();
  const all = catalog();
  const killed = await killedMap(all.map((m) => m.id));
  return all.map((m) => ({
    id: m.id,
    name: m.name,
    version: m.version,
    summary: m.summary,
    description: m.description,
    icon: m.icon,
    author: m.author.name,
    scopes: m.scopes.map((s) => ({ scope: s, words: APP_SCOPES[s] })),
    available: !killed.get(m.id),
    installId: rows.find((r) => r.plugin_id === m.id)?.id ?? null,
  }));
}

async function rowOf(id) {
  if (typeof id !== "string" || !/^pin_[0-9a-f]{16}$/.test(id)) return null;
  const row = await db.selectFrom("plugin_installs").selectAll().where("id", "=", id).executeTakeFirst();
  return row && row.status !== "uninstalled" ? row : null;
}

// One install for its page: the view, the plugin's manifest (what it does,
// its settings form) and, for audit.read holders, its Activity.
export async function getInstall(id, { withActivity = false } = {}) {
  const row = await rowOf(id);
  if (!row) return null;
  const [killed, names] = await Promise.all([isKilled(row.plugin_id), namesFor(tenantId())]);
  const install = view(row, { killed, names });
  const m = pluginById(row.plugin_id);
  const plugin = m
    ? { id: m.id, name: m.name, version: m.version, summary: m.summary, description: m.description, icon: m.icon, author: m.author.name, scopes: m.scopes.map((s) => ({ scope: s, words: APP_SCOPES[s] })), settings: m.settings }
    : null;
  if (!withActivity) return { install, plugin };
  return { install, plugin, activity: await activityOf(id, names) };
}

async function activityOf(id, names) {
  try {
    const rows = await listAudit({ tenantId: tenantId(), resource: resourceOf(id), limit: 50 });
    return rows.map((r) => ({ id: String(r.id), at: String(r.at), action: String(r.action), who: plainName(`${r.actor_kind}:${r.actor}`, names), changes: auditChanges(r.diff) }));
  } catch (e) {
    slog("apps_activity_failed", { error: String(e?.message || e).slice(0, 200) });
    return [];
  }
}

const record = (actor, action, id, diff) => audit({ actor, action, resource: resourceOf(id), diff });
const touched = () => invalidateTenantCache("plugins");

// install({ pluginId, scopes }, { actor }): scopes are what the admin saw and
// approved; they must be exactly what the plugin asks for now.
export async function installPlugin({ pluginId, scopes } = {}, { actor }) {
  const m = typeof pluginId === "string" ? pluginById(pluginId) : null;
  if (!m) throw new AppError(404, "UNKNOWN_PLUGIN", "We couldn't find that app. Reload the page and try again.");
  if (await isKilled(m.id)) throw new AppError(409, "TURNED_OFF_BY_STOREASY", `Storeasy has turned ${m.name} off for now, so it can't be installed. Try again later.`);
  const approved = Array.isArray(scopes) ? [...new Set(scopes.map(String))].sort() : null;
  if (!approved || approved.join(",") !== [...m.scopes].sort().join(",")) {
    throw new AppError(409, "SCOPES_CHANGED", `${m.name} now asks for different permissions than the ones you approved. Nothing was installed. Open it again and review what it asks for.`);
  }
  const at = nowIso();
  const id = newId("pin");
  const by = actorString(actor);
  try {
    await db
      .insertInto("plugin_installs")
      .values({
        id,
        plugin_id: m.id,
        kind: "first_party",
        name: null,
        version: m.version,
        status: "enabled",
        granted_scopes: JSON.stringify(m.scopes),
        settings: JSON.stringify(defaultSettings(m)),
        secrets_enc: null,
        installed_by: by,
        installed_at: at,
        updated_by: by,
        updated_at: at,
      })
      .execute();
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e?.message || e)) && (await liveRows()).some((r) => r.plugin_id === m.id)) {
      throw new AppError(409, "ALREADY_INSTALLED", `${m.name} is already installed on your store.`);
    }
    throw e;
  }
  await record(actor, "apps.install", id, { plugin: m.id, version: m.version, scopes: m.scopes });
  await touched();
  return (await getInstall(id)).install;
}

async function setStatus(id, { from, to, actor, action }) {
  const row = await rowOf(id);
  if (!row) throw NOT_FOUND();
  const name = pluginById(row.plugin_id)?.name || "This app";
  if (to === "enabled" && (await isKilled(row.plugin_id))) throw new AppError(409, "TURNED_OFF_BY_STOREASY", `Storeasy has turned ${name} off for now, so it can't be turned on. Its settings are kept.`);
  if (!from.includes(row.status)) {
    const words = { enabled: "already on", disabled: "already off" };
    throw new AppError(409, "STATUS_CHANGED", `${name} is ${words[row.status] || "changed"}. Reload the page to see it.`);
  }
  const at = nowIso();
  const by = actorString(actor);
  const patch = { status: to, updated_at: at, updated_by: by };
  if (to === "disabled") Object.assign(patch, { disabled_at: at, disabled_by: by });
  if (to === "enabled") Object.assign(patch, { disabled_at: null, disabled_by: null });
  if (to === "uninstalled") Object.assign(patch, { uninstalled_at: at, uninstalled_by: by });
  const r = await db.updateTable("plugin_installs").set(patch).where("id", "=", id).where("status", "=", row.status).executeTakeFirst();
  if (!Number(r?.numUpdatedRows ?? 0)) throw new AppError(409, "STATUS_CHANGED", `${name} was changed somewhere else. Reload the page to see it.`);
  await record(actor, action, id, { plugin: row.plugin_id, from: row.status, to });
  await touched();
  return to === "uninstalled" ? { id, status: "uninstalled" } : (await getInstall(id)).install;
}

export const enableInstall = (id, { actor }) => setStatus(id, { from: ["disabled"], to: "enabled", actor, action: "apps.enable" });
export const disableInstall = (id, { actor }) => setStatus(id, { from: ["enabled"], to: "disabled", actor, action: "apps.disable" });
export const uninstallInstall = (id, { actor }) => setStatus(id, { from: ["enabled", "disabled"], to: "uninstalled", actor, action: "apps.uninstall" });

// saveSettings(id, values): the whole form. Errors are per field, in plain
// words, and never quote a value.
export async function saveSettings(id, values, { actor }) {
  const row = await rowOf(id);
  if (!row) throw NOT_FOUND();
  const m = pluginById(row.plugin_id);
  if (!m) throw new AppError(409, "UNAVAILABLE", "This app is no longer offered, so its settings can't be changed. You can still turn it off or uninstall it.");
  const { settings: current, secretKeys } = splitStored(row.settings);
  const checked = checkSettings(m, values, { settings: current });
  if (!checked.ok) throw new AppError(422, "SETTINGS_INVALID", "Some settings need fixing. Nothing was saved.", { errors: checked.errors });
  let secretsEnc = row.secrets_enc;
  let keys = secretKeys;
  if (checked.hiddenChanged) {
    try {
      const secrets = row.secrets_enc ? await decryptJson(row.secrets_enc) : {};
      for (const [k, v] of Object.entries(checked.secretUpdates)) {
        if (v === null) delete secrets[k];
        else secrets[k] = v;
      }
      keys = Object.keys(secrets).sort();
      secretsEnc = keys.length ? await encryptJson(secrets) : null;
    } catch {
      throw new AppError(503, "SECRETS_UNAVAILABLE", "Private settings can't be saved on this store right now. Nothing was saved. Try again later.");
    }
  }
  const stored = keys.length ? { ...checked.settings, [SECRET_KEYS_FIELD]: keys } : checked.settings;
  const r = await db
    .updateTable("plugin_installs")
    .set({ settings: JSON.stringify(stored), secrets_enc: secretsEnc, updated_at: nowIso(), updated_by: actorString(actor) })
    .where("id", "=", id)
    .where("updated_at", "=", row.updated_at)
    .where("status", "<>", "uninstalled")
    .executeTakeFirst();
  if (!Number(r?.numUpdatedRows ?? 0)) throw new AppError(409, "CHANGED", "These settings were changed somewhere else. Nothing was saved. Reload the page and try again.");
  // changed keys only; secrets as a count, under a key redactDiff leaves alone
  await record(actor, "apps.settings", id, { changed: checked.changed, hidden_fields_changed: checked.hiddenChanged });
  await touched();
  return (await getInstall(id)).install;
}
