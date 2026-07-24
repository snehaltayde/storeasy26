import { db } from "../db.js";
import { validateOffer } from "./validate.js";

// DB-backed offer configuration (Session 19). The cart reads ACTIVE offers on
// every evaluation — one small indexed query, no cache — so an admin edit is
// live on the very next cart read, no deploy, no propagation lag.

const now = () => new Date().toISOString();

const rowToOffer = (row) => {
  try {
    const cfg = JSON.parse(row.config);
    return { ...cfg, id: row.id, type: row.type };
  } catch {
    return null;
  }
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
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    label: r.label,
    enabled: !!r.enabled,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    config: rowToOffer(r),
    updated_at: r.updated_at,
  }));
}

export async function getOfferRow(id) {
  const r = await db.selectFrom("offers").selectAll().where("id", "=", id).executeTakeFirst();
  if (!r) return null;
  return { id: r.id, type: r.type, label: r.label, enabled: !!r.enabled, starts_at: r.starts_at, ends_at: r.ends_at, config: rowToOffer(r) };
}

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
  await db
    .insertInto("offers")
    .values({
      id: offer.id,
      type: offer.type,
      label: offer.title || offer.id,
      enabled: enabled ? 1 : 0,
      starts_at: startsAt,
      ends_at: endsAt,
      config: JSON.stringify(offer),
      created_at: ts,
      updated_at: ts,
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        type: offer.type,
        label: offer.title || offer.id,
        enabled: enabled ? 1 : 0,
        starts_at: startsAt,
        ends_at: endsAt,
        config: JSON.stringify(offer),
        updated_at: ts,
      }),
    )
    .execute();
  return getOfferRow(offer.id);
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
