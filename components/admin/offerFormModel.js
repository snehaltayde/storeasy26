// The offer form's model (COM-03): form state ↔ the engine-shaped offer the
// API saves. No JSX and only relative imports, so plain node runs the same
// code the console does (scripts/test-offer-form.js). The founder never types
// an identifier: products, sizes, tags, types and the gift come from pickers,
// the offer's id is made here, and a code is suggested.
import { defaultOfferTitle, offerTerms, plainErrors, suggestCode } from "../../lib/offers/plain.js";
import { validateOffer } from "../../lib/offers/validate.js";
import { isoToLocalInput, localInputToIso, offerScheduleStatus } from "../../lib/admin/schedule.js";

// What an offer can be for, in the founder's words. A saved "handle" target
// (older offers) shows as One product; picking again saves the product id.
export const TARGET_CHOICES = [
  { key: "product", kinds: ["productId", "handle"], label: "One product", hint: "Every size or option of it counts." },
  { key: "variant", kinds: ["variantId"], label: "One size or option", hint: "Only that size or option counts." },
  { key: "tag", kinds: ["tag"], label: "Products with a tag", hint: "Every product with the tag you set in Shopify counts." },
  { key: "type", kinds: ["productType"], label: "Products of one type", hint: "Every product of the type you set in Shopify counts." },
  // Phase 8 line 5: membership is the store's synced Shopify collection
  { key: "collection", kinds: ["collection"], label: "Products in a collection", hint: "Every product in the collection, as it is in Shopify, counts." },
];
export const choiceOf = (target) => TARGET_CHOICES.find((c) => c.kinds.includes(target?.kind))?.key || "product";

const SCOPE = { BXGY: "line", TIERED_QTY: "line", FREE_GIFT: "gift", COUPON: "order" };
const PRIORITY = { COUPON: 50, FREE_GIFT: 40, BXGY: 30, TIERED_QTY: 30 };
const TYPE_SLUG = { BXGY: "bxgy", TIERED_QTY: "tiered", FREE_GIFT: "gift", COUPON: "coupon" };

const str = (v) => (v == null ? "" : String(v));
const num = (v) => (str(v).trim() === "" ? NaN : Number(str(v).trim()));

// Was the saved name made for the founder (the field was left blank)? Saves
// from this form mark it (`titleAuto`); an older save counts when its name is
// exactly the default, with the catalog's current name or the one saved at
// the pick. An automatic name is shown as a blank field, so it is rebuilt
// from the rules on every save and never keeps numbers the rules no longer have.
export function isAutoTitle(cfg, { names = {}, currency = "INR" } = {}) {
  if (!cfg?.title) return false;
  if (cfg.titleAuto === true) return true;
  return [names, {}].some((n) => defaultOfferTitle(cfg, { names: n, currency }) === cfg.title);
}

export function formFromOffer(existing, { names = {}, currency = "INR" } = {}) {
  const cfg = existing?.config || {};
  return {
    type: existing?.type || null,
    title: isAutoTitle(cfg, { names, currency }) ? "" : cfg.title || "",
    target: cfg.target ? { ...cfg.target } : null,
    choice: choiceOf(cfg.target),
    buy: str(cfg.buy ?? 2),
    free: str(cfg.free ?? 1),
    tiers: (cfg.tiers?.length ? cfg.tiers : [{ minQty: 2, percent: 10 }]).map((t) => ({ minQty: str(t.minQty), percent: str(t.percent) })),
    threshold: str(cfg.threshold),
    gift: cfg.gift ? { ...cfg.gift } : null,
    code: cfg.code || suggestCode(cfg.discount?.kind || "percent", cfg.discount?.value ?? 10),
    codeAuto: !cfg.code, // follows the discount until the founder types one
    discKind: cfg.discount?.kind || "percent",
    discValue: str(cfg.discount?.value ?? 10),
    minSubtotal: str(cfg.minSubtotal),
    combinable: cfg.combinable !== false,
    startsAt: isoToLocalInput(existing?.starts_at),
    endsAt: isoToLocalInput(existing?.ends_at),
    priority: cfg.priority,
  };
}

// One change to the form, with the knock-on rules in one place.
export function updateForm(form, patch) {
  const next = { ...form, ...patch };
  if ("choice" in patch && patch.choice !== form.choice) next.target = null; // a new kind of pick starts empty
  if ("code" in patch) next.codeAuto = false;
  if (next.codeAuto && ("discKind" in patch || "discValue" in patch)) next.code = suggestCode(next.discKind, next.discValue) || next.code;
  return next;
}

// The engine-shaped offer, exactly as the API stores it. A blank title
// becomes the plain default (what shoppers see in the cart), marked
// `titleAuto` so the next edit rebuilds it from the rules (the engine and the
// validator ignore the mark).
export function offerFromForm(form, { id, names = {}, currency = "INR" } = {}) {
  const type = form.type;
  const base = { id, type, scope: SCOPE[type], priority: form.priority ?? PRIORITY[type] };
  let rules = {};
  if (type === "BXGY") rules = { target: form.target || undefined, buy: num(form.buy), free: num(form.free) };
  else if (type === "TIERED_QTY") rules = { target: form.target || undefined, tiers: form.tiers.map((t) => ({ minQty: num(t.minQty), percent: num(t.percent) })) };
  else if (type === "FREE_GIFT") rules = { threshold: num(form.threshold), gift: form.gift ? { ...form.gift, value: Number(form.gift.value) || 0 } : undefined };
  else if (type === "COUPON")
    rules = {
      code: str(form.code).trim().toUpperCase(),
      discount: { kind: form.discKind, value: num(form.discValue) },
      ...(str(form.minSubtotal).trim() !== "" ? { minSubtotal: num(form.minSubtotal) } : {}),
      combinable: Boolean(form.combinable),
    };
  const offer = { ...base, ...rules };
  const typed = str(form.title).trim();
  offer.title = typed || defaultOfferTitle(offer, { names, currency });
  if (!typed) offer.titleAuto = true;
  return offer;
}

export const schedulePayload = (form) => ({ startsAt: localInputToIso(form.startsAt), endsAt: localInputToIso(form.endsAt) });

// What still stops the offer from saving, in plain words — the real
// validator's verdict, translated, plus the schedule rule the store adds.
export function formProblems(form, offer, { currency = "INR" } = {}) {
  if (!form.type) return ["Choose what kind of offer this is."];
  let errors = validateOffer(offer);
  // a blank title fills itself in once the rules are complete
  if (!str(form.title).trim() && !offerTerms(offer)) errors = errors.filter((e) => !e.startsWith("title:"));
  const { startsAt, endsAt } = schedulePayload(form);
  if (startsAt && endsAt && startsAt >= endsAt) errors.push("Schedule: start must be before end");
  return plainErrors(errors, { currency });
}

export const randomSuffix = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("");

// The next 6-hex ending after `suffix` (wraps at ffffff): a clash retries
// with it, so the id stays the same on every render for the same offer.
const nextSuffix = (suffix) => ((parseInt(suffix, 16) + 1) % 0x1000000).toString(16).padStart(6, "0");

// A new offer's id: its kind, a few words from what it's for, and a random
// ending so two similar offers never share one (the create route refuses a
// taken id rather than replace a live offer). P4-FIX5: `taken` holds the ids
// the store's offers already use; an id among them retries with the next
// ending until it is free, so a new id never repeats an existing one.
export function newOfferId(offer, { names = {}, suffix = randomSuffix(), taken = [] } = {}) {
  const t = offer?.target;
  const words =
    offer?.type === "COUPON"
      ? offer.code
      : offer?.type === "FREE_GIFT"
        ? offer.gift?.title
        : t && ["productId", "handle", "variantId"].includes(t.kind)
          ? names[t.value] || t.label
          : t?.value;
  const slug =
    str(words)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "offer";
  const stem = `${TYPE_SLUG[offer?.type] || "offer"}-${slug}-`;
  const used = taken instanceof Set ? taken : new Set(Array.isArray(taken) ? taken.map(String) : []);
  let end = /^[0-9a-f]{6}$/.test(String(suffix)) ? String(suffix) : randomSuffix();
  for (let tries = 0; used.has(stem + end) && tries < 0x1000000; tries++) end = nextSuffix(end);
  return stem + end;
}

// Same settings? Key order doesn't count, and a value left out means what the
// engine reads it as (scope and priority defaults, a code works with other
// offers unless it says it doesn't). The automatic-name mark isn't a setting:
// the name itself is compared.
const comparable = (o) =>
  o && typeof o === "object"
    ? {
        ...o,
        scope: o.scope ?? SCOPE[o.type],
        priority: o.priority ?? PRIORITY[o.type],
        ...(o.type === "COUPON" ? { combinable: o.combinable !== false } : {}),
        titleAuto: undefined,
      }
    : o;
const stable = (v) =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v ?? null);
export const sameSettings = (a, b) => stable(comparable(a)) === stable(comparable(b));

export const when = (iso) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;

// Will shoppers get these settings, and from when? For a saved row or the
// earlier settings: { enabled, starts_at, ends_at }. Null when they get it on
// their next cart; otherwise the reason they don't (yet).
export function reachOf({ enabled, starts_at = null, ends_at = null }, now = new Date()) {
  const status = offerScheduleStatus({ enabled, starts_at, ends_at }, now);
  if (status === "expired") return { why: "ended", text: `Its dates ended ${when(ends_at)}, so shoppers don't get it. Change the dates to run it again.` };
  if (status === "draft" || status === "paused") return { why: "off", text: "This offer is off, so shoppers don't get it until you turn it on." };
  if (status === "scheduled") return { why: "later", text: `Shoppers get it from ${when(starts_at)}.` };
  return null;
}

// The message after a save or going back, true to when shoppers get it.
export function doneMessage({ offer, created = false, reverted = false } = {}, now = new Date()) {
  const name = offer?.label || "Your offer";
  const reach = offer ? reachOf(offer, now) : null;
  if (reverted) {
    if (!reach) return "Back to the earlier settings. Shoppers get them on their next cart.";
    if (reach.why === "ended") return `Back to the earlier settings. Their dates ended ${when(offer.ends_at)}, so shoppers don't get the offer.`;
    if (reach.why === "off") return "Back to the earlier settings. The offer is off, so shoppers don't get it.";
    return `Back to the earlier settings. Shoppers get them from ${when(offer.starts_at)}.`;
  }
  if (created) {
    if (!reach) return `“${name}” has started.`;
    if (reach.why === "ended") return `“${name}” is saved, but its dates have already ended, so shoppers don't get it.`;
    if (reach.why === "off") return `“${name}” is saved and off.`;
    return `“${name}” starts ${when(offer.starts_at)}.`;
  }
  if (!reach) return "Updated. Shoppers get it on their next cart.";
  if (reach.why === "ended") return `Saved. Its dates ended ${when(offer.ends_at)}, so shoppers don't get it.`;
  if (reach.why === "off") return "Saved. The offer is off, so shoppers don't get it.";
  return `Saved. Shoppers get it from ${when(offer.starts_at)}.`;
}
