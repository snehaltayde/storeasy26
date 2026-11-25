// Phase 4 line 2: where a plugin's blocks show on the storefront (tenant table
// plugin_placements, migration 0031). Tenant-scoped: every call runs inside
// withTenant() against the store's own database. Edge-safe: the storefront's
// <PluginSlot> reaches slotBlocks() through this file, and test:plugin-slots
// scans its imports.
//
// One placement per (install, manifest block). It starts Off, in the block's
// first allowed slot, with the block's default settings. A founder picks the
// slot, the order within it, the settings, and turns it Live. An install made
// before this table existed has no rows; its blocks list with those defaults
// and the first save creates the row.
//
// The storefront read (slotBlocks) is one query a request: every placement of
// an enabled install, behind React cache() (not the tagged data cache: see
// storePlacements below).
// Every install and placement write invalidates that tag, so turning a
// plugin or a block off hides it at once. The operator kill switch is a flag
// (ff_plugin-<id>), read only when a slot has something to show, so it takes
// effect within the flag cache window (FLAG_CACHE_MS, 30 s). It fails CLOSED
// for rendering (owner decision, Phase 4 line 2 review): when the flags can't
// be read, no plugin block renders on that slot, because a block is
// decoration and a page without it is still whole. A store without the
// control plane (legacy mode) has no flags, so nothing is hidden there.
//
// The console's reads and writes count only placements of installs that are
// still installed (enabled or off): an uninstalled install's rows are kept,
// but they never hold a place, a position or a live count in a slot.
import { cache } from "react";
import { db, libsql } from "../db.js";
import { tenantId } from "../tenant-context.js";
import { invalidateTenantCache } from "../cache.js";
import { audit } from "../platform/audit.js";
import { flagState } from "../platform/flags.js";
import { newId } from "../platform/sessions.js";
import { notMigratedYet } from "../schema-shape.js";
import { slog } from "../log.js";
import { pluginById, killFlag } from "./catalog.js";
import { checkSettings, defaultSettings } from "./settings.js";
import { validateBlockProps } from "./blocks.js";
import { SLOTS, SLOT_MAX_BLOCKS, isSlot, slotContext } from "./slots.js";

export const DATA_BUDGET_MS = 300;

// How the kill switch is read: true when Storeasy turned the plugin off for
// this store; throws when the control plane can't be read. A test seam swaps it.
const readKilled = async (pluginId) => (await flagState(killFlag(pluginId), tenantId())) === false;
let killedReader = readKilled;
export const __setKillReader = (fn) => {
  killedReader = fn || readKilled;
};
export const PLACEMENT_STATES = Object.freeze(["off", "live"]);

export class PlacementError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const nowIso = () => new Date().toISOString();
const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const actorString = (actor) => `${actor?.kind ?? "system"}:${actor?.id ?? ""}`;
const missingTable = (e) => notMigratedYet(e, { table: "plugin_placements" }) || notMigratedYet(e, { table: "plugin_installs" });
// an install's plain settings, without line 1's reserved secret-key list
const installSettingsOf = (json) => {
  const all = parse(json, {});
  delete all.__secret_keys;
  return all;
};
// a block's settings form as checkSettings reads a manifest
const blockForm = (block) => ({ settings: block.settings || [] });
const stmt = (q) => {
  const { sql, parameters } = q.compile();
  return { sql, args: parameters };
};

// ---- the storefront read ----------------------------------------------------------

async function loadPlacementRows() {
  try {
    const rows = await db
      .selectFrom("plugin_placements as p")
      .innerJoin("plugin_installs as i", "i.id", "p.install_id")
      .select(["p.id", "p.block_id", "p.slot", "p.state", "p.settings", "p.position", "i.plugin_id", "i.settings as install_settings"])
      .where("i.status", "=", "enabled")
      .orderBy("p.slot")
      .orderBy("p.position")
      .orderBy("p.id")
      .execute();
    return rows.map((r) => ({
      id: String(r.id),
      pluginId: String(r.plugin_id),
      blockId: String(r.block_id),
      slot: String(r.slot),
      state: String(r.state),
      settings: parse(r.settings, {}),
      installSettings: installSettingsOf(r.install_settings),
    }));
  } catch (e) {
    if (missingTable(e)) return []; // a database one migration behind: no blocks
    throw e;
  }
}

// One read per request (React cache). Not behind the tagged data cache
// (cachedTenantRead): drill:apps found a turned-off block still showing on
// the next page after the write, so the read stays per request: one indexed
// query on a small table of the store's own database.
const storePlacements = cache(loadPlacementRows);

function withBudget(fn, ms) {
  let timer;
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// The blocks one slot shows: [{ key, pluginId, blockId, primitive, props, live }].
// Shoppers get live placements only; a founder's preview also gets those
// switched off (live: false), for a "Turned off" note. A placement whose
// plugin Storeasy turned off, whose block or slot the manifest no longer
// has, whose resolver throws or runs past DATA_BUDGET_MS, or whose props
// fail validateBlockProps is skipped and logged. Never more than
// SLOT_MAX_BLOCKS live blocks.
export async function slotBlocks(slot, rawCtx, { preview = false } = {}) {
  if (!isSlot(slot)) return [];
  const here = (await storePlacements()).filter((r) => r.slot === slot && (preview || r.state === "live"));
  if (!here.length) return [];
  const ctx = slotContext(slot, rawCtx);
  const killed = new Map();
  try {
    for (const id of new Set(here.map((r) => r.pluginId))) killed.set(id, await killedReader(id));
  } catch (e) {
    // fails closed: no plugin block renders while the kill switch can't be read
    slog("plugin_kill_switch_unreadable", { slot, error: String(e?.name || "Error") });
    return [];
  }
  const out = [];
  let live = 0;
  for (const r of here) {
    if (killed.get(r.pluginId)) continue;
    if (r.state === "live" && live >= SLOT_MAX_BLOCKS) continue;
    const block = pluginById(r.pluginId)?.blocks?.find((b) => b.id === r.blockId);
    if (!block || !block.slots.includes(slot)) continue;
    let data = {};
    if (block.data) {
      try {
        data = await withBudget(() => block.data(ctx, { installSettings: r.installSettings }), DATA_BUDGET_MS);
      } catch (e) {
        slog("plugin_block_data_failed", { plugin: r.pluginId, block: r.blockId, slot, error: e?.name === "TimeoutError" ? "timeout" : String(e?.name || "Error") });
        continue;
      }
    }
    const checked = validateBlockProps(block.primitive, { ...r.settings, ...(data && typeof data === "object" ? data : {}) });
    if (!checked.ok) {
      slog("plugin_block_invalid", { plugin: r.pluginId, block: r.blockId, slot, fields: Object.keys(checked.errors) });
      continue;
    }
    if (r.state === "live") live++;
    out.push({ key: r.id, pluginId: r.pluginId, blockId: r.blockId, primitive: block.primitive, props: checked.props, live: r.state === "live" });
  }
  return out;
}

// ---- the console -----------------------------------------------------------------

// placements of installs that are still installed, as a query to add to
const installedOnly = (q) => q.innerJoin("plugin_installs as i", "i.id", "p.install_id").where("i.status", "<>", "uninstalled");

async function installRow(installId) {
  if (typeof installId !== "string" || !/^pin_[0-9a-f]{16}$/.test(installId)) return null;
  const row = await db.selectFrom("plugin_installs").selectAll().where("id", "=", installId).executeTakeFirst();
  return row && row.status !== "uninstalled" ? row : null;
}

async function placementRows(installId) {
  try {
    return await db.selectFrom("plugin_placements").selectAll().where("install_id", "=", installId).execute();
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
}

// Where "Preview on store" opens for each slot: a product page (the store's
// first product by handle), the home page for the footer, none for the order
// page (it needs a shopper's own link).
async function previewPaths() {
  let handle = null;
  try {
    // a product shoppers can open: synced products are the published ones
    // (lib/shopify-admin-catalog.js keeps ACTIVE only); an in-stock one first
    handle = (await db.selectFrom("products").select("handle").orderBy("available", "desc").orderBy("handle").limit(1).executeTakeFirst())?.handle ?? null;
  } catch {
    handle = null;
  }
  const out = {};
  for (const [id, s] of Object.entries(SLOTS)) out[id] = s.page === "product" ? (handle ? `/products/${handle}` : null) : s.page === "any" ? "/" : null;
  return out;
}

// listPlacements(installId) → { placements: [...], slots, previewPaths } or null
// One entry per manifest block, its row or the defaults a first save writes.
export async function listPlacements(installId) {
  const install = await installRow(installId);
  if (!install) return null;
  const m = pluginById(install.plugin_id);
  const rows = await placementRows(installId);
  const placements = (m?.blocks || []).map((b) => {
    const row = rows.find((r) => r.block_id === b.id);
    return {
      blockId: b.id,
      label: b.label,
      primitive: b.primitive,
      slots: b.slots.map((s) => ({ id: s, label: SLOTS[s].label, page: SLOTS[s].page })),
      form: b.settings || [],
      slot: row?.slot && b.slots.includes(row.slot) ? String(row.slot) : b.slots[0],
      state: row ? String(row.state) : "off",
      settings: row ? parse(row.settings, {}) : defaultSettings(blockForm(b)),
      position: row ? Number(row.position) : 0,
      updatedAt: row ? String(row.updated_at) : null,
    };
  });
  // position within its slot among every placement of the store, for the up/down buttons
  let all = [];
  try {
    all = await db.selectFrom("plugin_placements as p").$call(installedOnly).select(["p.install_id", "p.block_id", "p.slot", "p.position", "p.id"]).orderBy("p.position").orderBy("p.id").execute();
  } catch (e) {
    if (!missingTable(e)) throw e;
  }
  for (const p of placements) {
    const inSlot = all.filter((r) => r.slot === p.slot);
    const i = inSlot.findIndex((r) => r.install_id === installId && r.block_id === p.blockId);
    p.first = i <= 0;
    p.last = i === -1 || i === inSlot.length - 1;
  }
  return { installStatus: String(install.status), placements, previewPaths: await previewPaths() };
}

const nextPosition = async (slot) => {
  const r = await db.selectFrom("plugin_placements as p").$call(installedOnly).select((eb) => eb.fn.max("p.position").as("max")).where("p.slot", "=", slot).executeTakeFirst();
  return r?.max == null ? 0 : Number(r.max) + 1;
};

// live placements of installed apps in a slot, other than `exceptId`
const liveIn = async (slot, exceptId) =>
  Number((await db.selectFrom("plugin_placements as p").$call(installedOnly).select((eb) => eb.fn.countAll().as("n")).where("p.slot", "=", slot).where("p.state", "=", "live").where("p.id", "<>", exceptId).executeTakeFirst())?.n ?? 0);

// Called when a plugin is installed: one Off placement per block. A database
// without the table (one migration behind) is skipped.
export async function ensurePlacements(installId) {
  try {
    const install = await installRow(installId);
    const m = install && pluginById(install.plugin_id);
    if (!m?.blocks?.length) return;
    const at = nowIso();
    for (const b of m.blocks) {
      await db
        .insertInto("plugin_placements")
        .values({ id: newId("ppl"), install_id: installId, block_id: b.id, slot: b.slots[0], state: "off", settings: JSON.stringify(defaultSettings(blockForm(b))), position: await nextPosition(b.slots[0]), created_at: at, updated_by: install.installed_by, updated_at: at })
        .onConflict((oc) => oc.columns(["install_id", "block_id"]).doNothing())
        .execute();
    }
    await invalidateTenantCache("plugins");
  } catch (e) {
    if (missingTable(e)) return;
    throw e;
  }
}

// updatePlacement(installId, { block, slot?, state?, settings?, move? }, { actor })
// One change at a time besides the block: slot, state ("off" | "live"),
// settings (the block's whole form) or move ("up" | "down" within its slot).
// Settings and a turn to Live are checked against the block's primitive, so a
// block that couldn't show is never saved Live. Audited as apps.placement.
export async function updatePlacement(installId, body, { actor }) {
  const install = await installRow(installId);
  if (!install) throw new PlacementError(404, "NOT_FOUND", "This app isn't installed on your store. It may have been uninstalled.");
  const m = pluginById(install.plugin_id);
  const block = m?.blocks?.find((b) => b.id === body?.block);
  if (!block) throw new PlacementError(404, "UNKNOWN_BLOCK", "This app doesn't have that block any more. Reload the page.");
  const ops = ["slot", "state", "settings", "move"].filter((k) => body[k] !== undefined);
  if (ops.length !== 1) throw new PlacementError(400, "BAD_REQUEST", "Choose one thing to change.");
  const op = ops[0];

  let row = (await placementRows(installId)).find((r) => r.block_id === block.id) || null;
  if (!row) {
    await ensurePlacements(installId);
    row = (await placementRows(installId)).find((r) => r.block_id === block.id) || null;
    if (!row) throw new PlacementError(503, "NOT_READY", "Placements can't be saved on this store yet. Try again in a few minutes.");
  }
  const at = nowIso();
  const by = actorString(actor);
  const patch = { updated_at: at, updated_by: by };
  let settings = parse(row.settings, {});

  if (op === "slot") {
    if (!block.slots.includes(body.slot)) throw new PlacementError(422, "SLOT_NOT_ALLOWED", `${block.label} can't go there. Choose one of the places listed.`);
    if (body.slot === row.slot) throw new PlacementError(409, "UNCHANGED", `${block.label} is already there.`);
    Object.assign(patch, { slot: body.slot, position: await nextPosition(body.slot) });
  } else if (op === "settings") {
    const checked = checkSettings(blockForm(block), body.settings, { settings });
    if (!checked.ok) throw new PlacementError(422, "SETTINGS_INVALID", "Some settings need fixing. Nothing was saved.", { errors: checked.errors });
    settings = checked.settings;
    patch.settings = JSON.stringify(settings);
  } else if (op === "state") {
    if (!PLACEMENT_STATES.includes(body.state)) throw new PlacementError(400, "BAD_REQUEST", "Choose Live or Off.");
    if (body.state === row.state) throw new PlacementError(409, "UNCHANGED", `${block.label} is already ${body.state === "live" ? "live" : "off"}.`);
    patch.state = body.state;
  } else if (op === "move") {
    if (!["up", "down"].includes(body.move)) throw new PlacementError(400, "BAD_REQUEST", "Choose up or down.");
  }

  // a slot shows at most SLOT_MAX_BLOCKS live blocks
  const goingLiveIn = op === "state" && body.state === "live" ? row.slot : op === "slot" && row.state === "live" ? body.slot : null;
  if (goingLiveIn && (await liveIn(goingLiveIn, row.id)) >= SLOT_MAX_BLOCKS) {
    throw new PlacementError(409, "SLOT_FULL", `${SLOTS[goingLiveIn].label} already shows ${SLOT_MAX_BLOCKS} blocks, the most it can hold. Turn one of them off or choose another place. Nothing was saved.`);
  }

  // what the storefront would show must pass the primitive's checks before it can be Live
  if (op === "settings" || (op === "state" && body.state === "live")) {
    let data = {};
    if (block.data) {
      try {
        data = await withBudget(() => block.data({}, { installSettings: installSettingsOf(install.settings) }), DATA_BUDGET_MS);
      } catch {
        throw new PlacementError(503, "DATA_FAILED", `${block.label} couldn't be checked just now. Nothing was saved. Try again.`);
      }
    }
    const v = validateBlockProps(block.primitive, { ...settings, ...(data && typeof data === "object" ? data : {}) });
    if (!v.ok) {
      const fromData = Object.keys(v.errors).some((k) => !(block.settings || []).some((s) => k === s.key || k.startsWith(`${s.key}.`)));
      const message = fromData ? `${block.label} has nothing to show yet. Fill in this app's settings first. Nothing was saved.` : "Some settings need fixing. Nothing was saved.";
      throw new PlacementError(422, "BLOCK_INVALID", message, { errors: v.errors });
    }
  }

  if (op === "move") {
    const inSlot = await db.selectFrom("plugin_placements as p").$call(installedOnly).select(["p.id", "p.position"]).where("p.slot", "=", row.slot).orderBy("p.position").orderBy("p.id").execute();
    const i = inSlot.findIndex((r) => r.id === row.id);
    const j = body.move === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= inSlot.length) throw new PlacementError(409, "UNCHANGED", `${block.label} is already ${body.move === "up" ? "first" : "last"} there.`);
    // renumber the slot 0..n-1 with the two swapped, in one batch
    const order = inSlot.map((r) => r.id);
    [order[i], order[j]] = [order[j], order[i]];
    await libsql.batch(
      order.map((id, n) => stmt(db.updateTable("plugin_placements").set(id === row.id ? { position: n, ...patch } : { position: n }).where("id", "=", id))),
      "write",
    );
  } else {
    const r = await db.updateTable("plugin_placements").set(patch).where("id", "=", row.id).where("updated_at", "=", row.updated_at).executeTakeFirst();
    if (!Number(r?.numUpdatedRows ?? 0)) throw new PlacementError(409, "CHANGED", "This block was changed somewhere else. Nothing was saved. Reload the page and try again.");
  }
  const after = await db.selectFrom("plugin_placements").select(["slot", "state"]).where("id", "=", row.id).executeTakeFirst();
  await audit({ actor, action: "apps.placement", resource: `app:${installId}`, diff: { block: block.id, slot: String(after.slot), state: String(after.state), ...(op === "move" ? { move: body.move } : {}), ...(op === "settings" ? { changed: "settings" } : {}) } });
  await invalidateTenantCache("plugins");
  return listPlacements(installId);
}
