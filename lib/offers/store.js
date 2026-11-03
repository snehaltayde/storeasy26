import { sql } from "kysely";
import { db } from "../db.js";
import { validateOffer } from "./validate.js";

// DB-backed offer configuration (Session 19). The cart reads ACTIVE offers on
// every evaluation — one small indexed query, no cache — so an admin edit is
// live on the very next cart read, no deploy, no propagation lag.
//
// COM-03: each offer keeps the settings it had before its last change in
// `previous_config` (migration 0019), so "Go back to previous offer
// settings" is one swap, live on the next cart read like any edit. A tenant
// whose database hasn't run 0019 yet still saves offers; it just has nothing
// to go back to until it does.

const now = () => new Date().toISOString();

const rowToOffer = (row) => {
  try {
    const cfg = JSON.parse(row.config);
    return { ...cfg, id: row.id, type: row.type };
  } catch {
    return null;
  }
};

// Same keys in the same order, so two configs that only differ in key order
// count as the same settings.
const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
};
const settingsKey = (s) => stable({ type: s.type, label: s.label, starts_at: s.starts_at || null, ends_at: s.ends_at || null, config: s.config });

// The stored snapshot → { type, label, starts_at, ends_at, config, replaced_at }
// with config as the engine-shaped offer. Null when there is nothing to go
// back to, including a snapshot equal to the current settings.
function previousOf(row, current) {
  // A bundle's offer row follows its bundle record (lib/bundles.js); going
  // back here would leave the two disagreeing, so bundles have no way back
  // in the offer console.
  if (!row.previous_config || row.type === "BUNDLE") return null;
  try {
    const snap = JSON.parse(row.previous_config);
    const cfg = JSON.parse(snap.config);
    const prev = {
      type: snap.type,
      label: snap.label,
      starts_at: snap.starts_at ?? null,
      ends_at: snap.ends_at ?? null,
      config: { ...cfg, id: row.id, type: snap.type },
      replaced_at: snap.replaced_at ?? null,
    };
    if (current && settingsKey(prev) === settingsKey(current)) return null;
    return prev;
  } catch {
    return null;
  }
}

const rowView = (r) => {
  const view = {
    id: r.id,
    type: r.type,
    label: r.label,
    enabled: !!r.enabled,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    config: rowToOffer(r),
    updated_at: r.updated_at,
  };
  view.previous = previousOf(r, view);
  return view;
};

export async function getActiveOffers(at = new Date()) {
  const t = at.toISOString();
  const rows = await db
    .selectFrom("offers")
    .selectAll()
    .where("enabled", "=", 1)
    .execute();
  return rows
    .filter((r) => (!r.starts_at || r.starts_at <= t) && (!r.ends_at || r.ends_at > t))
    .map(rowToOffer)
    .filter(Boolean);
}

export async function listOffers() {
  const rows = await db.selectFrom("offers").selectAll().orderBy("created_at", "asc").execute();
  return rows.map(rowView);
}

export async function getOfferRow(id) {
  const r = await db.selectFrom("offers").selectAll().where("id", "=", id).executeTakeFirst();
  if (!r) return null;
  const { updated_at, ...view } = rowView(r);
  return view;
}

export async function offerExists(id) {
  const r = await db.selectFrom("offers").select("id").where("id", "=", id).executeTakeFirst();
  return Boolean(r);
}

const missingPreviousColumn = (e) => /previous_config/i.test(String(e?.message || e));

// The settings as they stand, captured by the database in the same statement
// that replaces them (bare column names are the row being replaced).
const SNAPSHOT_SQL = (at) =>
  sql`json_object('type', offers.type, 'label', offers.label, 'starts_at', offers.starts_at, 'ends_at', offers.ends_at, 'config', offers.config, 'replaced_at', ${at})`;

// Create or update. `offer` is the engine-shaped object; scheduling/enabled
// ride alongside. Validation throws with a list of human errors.
export async function upsertOffer({ offer, enabled = true, startsAt = null, endsAt = null }) {
  const errors = validateOffer(offer);
  if (startsAt && endsAt && startsAt >= endsAt) errors.push("Schedule: start must be before end");
  if (errors.length) {
    const e = new Error(errors.join(" · "));
    e.code = "OFFER_INVALID";
    e.errors = errors;
    throw e;
  }
  const ts = now();
  const values = {
    type: offer.type,
    label: offer.title || offer.id,
    enabled: enabled ? 1 : 0,
    starts_at: startsAt,
    ends_at: endsAt,
    config: JSON.stringify(offer),
  };
  const write = (keepPrevious) =>
    db
      .insertInto("offers")
      .values({ id: offer.id, ...values, created_at: ts, updated_at: ts })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          ...values,
          updated_at: ts,
          // A save that changes nothing keeps the snapshot it had, so saving
          // twice can't wipe out the way back.
          ...(keepPrevious
            ? {
                previous_config: sql`CASE WHEN offers.type IS excluded.type AND offers.label IS excluded.label
                  AND offers.starts_at IS excluded.starts_at AND offers.ends_at IS excluded.ends_at
                  AND offers.config IS excluded.config
                  THEN offers.previous_config ELSE ${SNAPSHOT_SQL(ts)} END`,
              }
            : {}),
        }),
      )
      .execute();
  try {
    await write(true);
  } catch (e) {
    if (!missingPreviousColumn(e)) throw e;
    await write(false); // pre-0019 database: save without the way back
  }
  return getOfferRow(offer.id);
}

// "Go back to previous offer settings": the snapshot becomes the live
// settings and the settings it replaces become the snapshot, in one
// statement, so going back twice returns to where the founder started. The
// on/off switch is left as it is. Live on the next cart read.
// Throws { code: "NOT_FOUND" | "NOT_HERE" | "NO_PREVIOUS" | "CHANGED" | "OFFER_INVALID" }.
export async function revertOffer(id) {
  const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
  let row;
  try {
    row = await db.selectFrom("offers").select(["id", "type", "label", "starts_at", "ends_at", "config", "previous_config"]).where("id", "=", id).executeTakeFirst();
  } catch (e) {
    if (missingPreviousColumn(e)) throw fail("NO_PREVIOUS", "There are no earlier settings for this offer.");
    throw e;
  }
  if (!row) throw fail("NOT_FOUND", "This offer no longer exists.");
  if (row.type === "BUNDLE") throw fail("NOT_HERE", "This offer belongs to a bundle. Change it where you edit the bundle.");
  const current = { type: row.type, label: row.label, starts_at: row.starts_at, ends_at: row.ends_at, config: rowToOffer(row) };
  const prev = previousOf(row, current);
  if (!prev) throw fail("NO_PREVIOUS", "There are no earlier settings for this offer.");
  // The snapshot passed validation when it was live; check again rather than
  // put something the cart can't read back in front of shoppers.
  const errors = validateOffer(prev.config);
  if (errors.length) throw fail("OFFER_INVALID", "The earlier settings can't be used any more.", { errors });

  const ts = now();
  const res = await db
    .updateTable("offers")
    .set({
      type: sql`json_extract(previous_config, '$.type')`,
      label: sql`json_extract(previous_config, '$.label')`,
      starts_at: sql`json_extract(previous_config, '$.starts_at')`,
      ends_at: sql`json_extract(previous_config, '$.ends_at')`,
      config: sql`json_extract(previous_config, '$.config')`,
      previous_config: SNAPSHOT_SQL(ts),
      updated_at: ts,
    })
    .where("id", "=", id)
    // only if nobody changed it since we read it
    .where("previous_config", "=", row.previous_config)
    .where("config", "=", row.config)
    .executeTakeFirst();
  if (!Number(res?.numUpdatedRows)) throw fail("CHANGED", "This offer changed while you were looking at it. Reload and try again.");
  return getOfferRow(id);
}

// For PUB-04's "Recently published" (phase 3): the latest offer changes,
// newest first, each with the settings before and after and the time of the
// change. `before` is what "Go back to previous offer settings" restores
// (POST /api/admin/offers/:id/revert).
export async function listRecentOfferChanges({ limit = 20 } = {}) {
  let rows;
  try {
    rows = await db.selectFrom("offers").selectAll().where("previous_config", "is not", null).execute();
  } catch (e) {
    if (missingPreviousColumn(e)) return [];
    throw e;
  }
  return rows
    .map(rowView)
    .filter((v) => v.previous)
    .map((v) => ({
      id: v.id,
      type: v.type,
      label: v.label,
      enabled: v.enabled,
      changedAt: v.previous.replaced_at || v.updated_at,
      before: v.previous.config,
      after: v.config,
    }))
    .sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt)) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export async function setOfferEnabled(id, enabled) {
  await db
    .updateTable("offers")
    .set({ enabled: enabled ? 1 : 0, updated_at: now() })
    .where("id", "=", id)
    .execute();
  return getOfferRow(id);
}

export async function deleteOffer(id) {
  await db.deleteFrom("offers").where("id", "=", id).execute();
  return { deleted: id };
}
