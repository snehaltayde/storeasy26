// Phase 4 line 2: the block primitives a plugin may put in a storefront slot,
// and the one check every block's props pass. Pure and Edge-safe: no React,
// no Next, no node: imports.
//
// A plugin never ships markup or JavaScript to the storefront. Its manifest
// names a primitive Storeasy owns (components/plugins/blocks/index.js draws
// it), and the props it hands over are checked here against that
// primitive's declared shape:
//   text   plain words, control characters stripped, at most `max` long
//          (React escapes it when it renders)
//   href   a storefront path (isStorefrontHref), never another site or a
//          javascript: address
//   icon   one of BLOCK_ICONS
//   number a whole number from min to max
//   list   up to `max` items, each an object of the fields above
// Unknown keys are dropped; there is no className, style or attribute
// passthrough. validateBlockProps runs when a founder saves a placement (a
// refusal in plain words) and again when the storefront renders it (a block
// that fails is skipped and logged, the page carries on).
import { isStorefrontHref } from "../registry/settings.js";

export const BLOCK_ICONS = Object.freeze(["truck", "shield", "return", "leaf", "award", "heart"]);

const text = (max, extra = {}) => Object.freeze({ kind: "text", max, ...extra });
export const PRIMITIVES = Object.freeze({
  badge_row: Object.freeze({
    label: "A row of badges",
    props: Object.freeze({
      badges: Object.freeze({ kind: "list", max: 4, required: true, label: "Badges", fields: Object.freeze({ icon: Object.freeze({ kind: "icon", required: true, label: "Icon" }), label: text(40, { required: true, label: "Label" }) }) }),
    }),
  }),
  notice: Object.freeze({
    label: "A short note",
    props: Object.freeze({
      title: text(80, { label: "Title" }),
      text: text(400, { required: true, label: "Text" }),
      link_label: text(40, { label: "Link text" }),
      link: Object.freeze({ kind: "href", label: "Store link" }),
    }),
  }),
  // Phase 9 lines add their primitives at their own anchor (one per line).
  // p9: reviews
  // Phase 9 line 1: the Reviews plugin's three blocks. average is display text
  // ("4.3"); every count is a whole number; review words are plain text.
  rating_summary: Object.freeze({
    label: "A star rating",
    props: Object.freeze({
      average: text(3, { label: "Average" }),
      count: Object.freeze({ kind: "number", min: 0, max: 10_000_000, label: "Count" }),
      link: Object.freeze({ kind: "href", label: "Link" }),
    }),
  }),
  review_list: Object.freeze({
    label: "A list of reviews",
    props: Object.freeze({
      average: text(3, { label: "Average" }),
      count: Object.freeze({ kind: "number", min: 0, max: 10_000_000, label: "Count" }),
      distribution: Object.freeze({
        kind: "list",
        max: 5,
        label: "Distribution",
        fields: Object.freeze({ stars: Object.freeze({ kind: "number", min: 1, max: 5, required: true, label: "Stars" }), count: Object.freeze({ kind: "number", min: 0, max: 10_000_000, required: true, label: "Count" }) }),
      }),
      reviews: Object.freeze({
        kind: "list",
        max: 50,
        label: "Reviews",
        fields: Object.freeze({
          rating: Object.freeze({ kind: "number", min: 1, max: 5, required: true, label: "Rating" }),
          title: text(80, { label: "Title" }),
          body: text(2000, { required: true, label: "Review" }),
          name: text(40, { required: true, label: "Name" }),
          reply: text(1000, { label: "Reply" }),
          date: text(10, { label: "Date" }),
        }),
      }),
      see_all: Object.freeze({ kind: "href", label: "See all link" }),
    }),
  }),
  link_list: Object.freeze({
    label: "A list of links",
    props: Object.freeze({
      links: Object.freeze({ kind: "list", max: 20, label: "Links", fields: Object.freeze({ label: text(120, { required: true, label: "Label" }), href: Object.freeze({ kind: "href", required: true, label: "Link" }) }) }),
    }),
  }),
  // p9: subscriptions
  // p9: whatsapp
  // p9: shiprocket
  tracking_timeline: Object.freeze({
    label: "A parcel's tracking",
    // every prop may be empty: an order with no parcel yet draws nothing
    props: Object.freeze({
      status: text(30, { label: "Status" }),
      headline: text(60, { label: "Headline" }),
      expected: text(80, { label: "Expected date" }),
      courier: text(60, { label: "Courier" }),
      awb: text(40, { label: "Tracking number" }),
      steps: Object.freeze({ kind: "list", max: 50, label: "Steps", fields: Object.freeze({ at: text(40, { label: "Time" }), hub: text(80, { label: "Place" }), activity: text(120, { label: "Activity" }) }) }),
    }),
  }),
  // p9: ai-copilot
});
export const PRIMITIVE_IDS = Object.freeze(Object.keys(PRIMITIVES));

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const isEmpty = (v) => v == null || (typeof v === "string" && !v.replace(CONTROL, "").trim());

function checkValue(spec, value, path, errors) {
  const label = lower(spec.label);
  if (isEmpty(value)) {
    if (spec.required) errors[path] = `The ${label} is empty. Fill it in.`;
    return undefined;
  }
  switch (spec.kind) {
    case "text": {
      if (typeof value !== "string") {
        errors[path] = `The ${label} must be words.`;
        return undefined;
      }
      const clean = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
      if (clean.length > spec.max) {
        errors[path] = `The ${label} is ${clean.length} characters, and the limit is ${spec.max}. Shorten it.`;
        return undefined;
      }
      return clean;
    }
    case "href":
      if (typeof value !== "string" || !isStorefrontHref(value)) {
        errors[path] = `The ${label} must be a page on your store, starting with / (like /policies/refund-policy). Other sites can't be linked here.`;
        return undefined;
      }
      return value;
    case "icon":
      if (!BLOCK_ICONS.includes(value)) {
        errors[path] = `The ${label} must be one of: ${BLOCK_ICONS.join(", ")}.`;
        return undefined;
      }
      return value;
    case "number":
      if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
        errors[path] = `The ${label} must be a whole number from ${spec.min} to ${spec.max}.`;
        return undefined;
      }
      return value;
    case "list": {
      if (!Array.isArray(value)) {
        errors[path] = `The ${label} couldn't be read.`;
        return undefined;
      }
      if (value.length > spec.max) {
        errors[path] = `The ${label} list has ${value.length} items, and the limit is ${spec.max}.`;
        return undefined;
      }
      const items = [];
      value.forEach((item, i) => {
        if (!isObj(item)) {
          errors[`${path}.${i}`] = "This item couldn't be read.";
          return;
        }
        const out = {};
        for (const [k, f] of Object.entries(spec.fields)) {
          const v = checkValue(f, item[k], `${path}.${i}.${k}`, errors);
          if (v !== undefined) out[k] = v;
        }
        items.push(out);
      });
      if (spec.required && !items.length) errors[path] = `The ${label} list is empty. Add at least one.`;
      return items;
    }
    default:
      errors[path] = `The ${label} can't be shown.`;
      return undefined;
  }
}

// validateBlockProps(primitive, props) → { ok, errors: { field: message }, props }
// props holds only the declared keys, cleaned; unknown keys are dropped.
export function validateBlockProps(primitive, props) {
  const shape = Object.hasOwn(PRIMITIVES, primitive) ? PRIMITIVES[primitive] : null;
  if (!shape) return { ok: false, errors: { _: "This block can't be shown on your store." }, props: {} };
  const errors = {};
  const out = {};
  const input = isObj(props) ? props : {};
  for (const [k, spec] of Object.entries(shape.props)) {
    const v = checkValue(spec, input[k], k, errors);
    if (v !== undefined) out[k] = v;
  }
  return { ok: Object.keys(errors).length === 0, errors, props: out };
}
