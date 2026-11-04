"use client";

// P4-PICKER (OVL-04, MED-03): a product's images, the overlay of kind
// gallery (lib/registry/settings.js):
//   null                         follow Shopify's images
//   { value: [{ media, alt }], base_hash?, base_value? }
//                                the founder's own ordered list; the service
//                                sets the base (P4-LIVEROW), so this control
//                                only ever changes `value`
// What it offers, every action a labelled button or text box:
//   - add an image from the library (context.pickImage, the editor's
//     MediaPicker: { media: "/api/media/<id>", alt }) or one of Shopify's
//   - copy all of Shopify's images to start from them
//   - move each image up or down, remove it, and edit its alt text
//   - Shopify's images, read-only, beside the list
//   - "Use Shopify's images": clears the overlay (null), so the product
//     follows Shopify again
// From context: pickImage({ path }) -> Promise<{ media, alt } | null>, and
// shopify: { gallery: [{ media, alt }] } (what Shopify sends now; null when
// the product is no longer in Shopify or isn't loaded yet).
import { ArrowDown, ArrowUp, ImagePlus, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button, IconButton } from "../../../console/Button.js";
import { Input } from "../../../console/fields.js";
import { Notes } from "./controls.js";
import { idOf, notesId, notesAt, blocks, moveIn, removeAt } from "./inspectorModel.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const described = (anchor, notes) => (notes.length ? notesId(anchor) : undefined);
const textOf = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

// An image address without its query or fragment: two sizes of one Shopify
// image are the same image.
export const sameImage = (a, b) => typeof a === "string" && typeof b === "string" && a.replace(/[?#].*$/, "") === b.replace(/[?#].*$/, "");

// The founder's list, or null while the product follows Shopify.
export const galleryList = (value) => (isObj(value) && Array.isArray(value.value) ? value.value : null);

// The overlay after a change of the list: the rest of the overlay is kept as
// it was (the service owns the base; P4-LIVEROW).
export function withList(value, list) {
  const rest = isObj(value) ? value : {};
  return { ...rest, value: list };
}

// The list after adding one image: refused (the same list) when it is full or
// the image is already in it.
export function addImage(list, item, max = null) {
  const cur = Array.isArray(list) ? list : [];
  if (!isObj(item) || typeof item.media !== "string" || !item.media.trim()) return cur;
  if (max != null && cur.length >= max) return cur;
  if (cur.some((x) => isObj(x) && sameImage(x.media, item.media))) return cur;
  return [...cur, { media: item.media, alt: typeof item.alt === "string" ? item.alt : "" }];
}

export const GALLERY_WORDS = Object.freeze({
  following: "Shoppers see Shopify's images. Add an image to use your own list instead.",
  own: "Shoppers see your images, in this order.",
  shopifyGone: "Shopify's images can't be shown: this product isn't in your Shopify catalog now.",
  shopifyLoading: "Loading Shopify's images…",
  useShopify: "Use Shopify's images",
  copyShopify: "Start from Shopify's images",
  fromLibrary: "Add from your library",
});

export default function GalleryControl({ field, value, onChange, issues, owner = null, context = {}, readOnly = false }) {
  const id = idOf(owner, field.path);
  const notes = notesAt(issues, id);
  const list = galleryList(value);
  const max = field.setting?.max ?? null;
  const shopify = isObj(context.shopify) ? (Array.isArray(context.shopify.gallery) ? context.shopify.gallery : []) : null;
  const items = list || [];
  const full = max != null && items.length >= max;
  const set = (next) => onChange(withList(value, next));
  const add = (item) => {
    const next = addImage(list, item, max);
    if (next.length !== items.length) set(next);
  };
  const pick = async () => {
    if (typeof context.pickImage !== "function") return;
    const picked = await context.pickImage({ path: field.path });
    if (isObj(picked) && typeof picked.media === "string") add(picked);
  };
  const shopifyLabel = context.shopifyMissing ? GALLERY_WORDS.shopifyGone : GALLERY_WORDS.shopifyLoading;

  return (
    <div id={id} role="group" tabIndex={-1} aria-labelledby={`${id}--label`} aria-describedby={described(id, notes)} className="min-w-0 rounded-ctl border border-edge p-3 focus-ring" data-gallery-control="" data-following={list ? undefined : ""}>
      <p id={`${id}--label`} className="mb-1 text-xs font-medium text-fg-muted">
        {field.label}
      </p>
      <p className="mb-3 text-xs text-fg-subtle" data-gallery-state="">
        {list ? GALLERY_WORDS.own : GALLERY_WORDS.following}
      </p>
      <div className="space-y-4">
        <section aria-label="Your images" className="min-w-0 space-y-2" data-gallery-own="">
          <p className="text-xs font-medium text-fg">Your images</p>
          {items.length === 0 && <p className="text-xs text-fg-subtle">{list ? "No images in your list." : "None yet."}</p>}
          {items.length > 0 && (
            <ol className="space-y-2">
              {items.map((it, j) => {
                const at = `${field.path}.value.${j}`;
                const iid = idOf(owner, at);
                const mid = idOf(owner, `${at}.media`);
                const aid = idOf(owner, `${at}.alt`);
                const inotes = notesAt(issues, iid);
                const mnotes = notesAt(issues, mid);
                const anotes = notesAt(issues, aid);
                const v = isObj(it) ? it : {};
                const name = `image ${j + 1}`;
                return (
                  <li key={j} id={iid} tabIndex={-1} aria-describedby={described(iid, inotes)} className="rounded-ctl border border-edge p-2" data-gallery-item={textOf(v.media)}>
                    <div className="flex items-center gap-2">
                      <span id={mid} tabIndex={-1} aria-describedby={described(mid, mnotes)} className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-ctl border border-edge bg-surface-sunken">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {v.media ? <img src={v.media} alt={textOf(v.alt)} className="h-full w-full object-cover" loading="lazy" /> : <span className="text-[10px] text-fg-subtle">No image</span>}
                      </span>
                      <span className="min-w-0 flex-1 text-xs text-fg-muted">{`Image ${j + 1}`}</span>
                      <span className="flex shrink-0 items-center">
                        <IconButton label={`Move ${name} up`} icon={<ArrowUp size={14} aria-hidden />} disabled={readOnly || j === 0} onClick={() => set(moveIn(items, j, -1))} />
                        <IconButton label={`Move ${name} down`} icon={<ArrowDown size={14} aria-hidden />} disabled={readOnly || j === items.length - 1} onClick={() => set(moveIn(items, j, 1))} />
                        <IconButton label={`Remove ${name}`} icon={<Trash2 size={14} aria-hidden />} disabled={readOnly} onClick={() => set(removeAt(items, j))} />
                      </span>
                    </div>
                    <div className="mt-2 min-w-0">
                      <label htmlFor={aid} className="mb-1 block text-xs font-medium text-fg-muted">
                        {`Alt text for image ${j + 1}`}
                      </label>
                      <Input
                        id={aid}
                        value={textOf(v.alt)}
                        disabled={readOnly}
                        invalid={blocks(anotes)}
                        aria-describedby={described(aid, anotes)}
                        placeholder="What a screen reader says about it"
                        onChange={(e) => set(items.map((x, k) => (k === j ? { ...(isObj(x) ? x : {}), alt: e.target.value } : x)))}
                      />
                      <Notes anchor={aid} notes={anotes} />
                    </div>
                    <Notes anchor={mid} notes={mnotes} />
                    <Notes anchor={iid} notes={inotes} />
                  </li>
                );
              })}
            </ol>
          )}
          <div className="flex flex-wrap gap-2">
            {typeof context.pickImage === "function" && (
              <Button size="sm" icon={<ImagePlus size={13} aria-hidden />} disabled={readOnly || full} onClick={pick} data-gallery-library="">
                {GALLERY_WORDS.fromLibrary}
              </Button>
            )}
            {!list && shopify && shopify.length > 0 && (
              <Button size="sm" disabled={readOnly} onClick={() => set(shopify.slice(0, max ?? shopify.length).map((s) => ({ media: s.media, alt: textOf(s.alt) })))}>
                {GALLERY_WORDS.copyShopify}
              </Button>
            )}
            {list && (
              <Button size="sm" variant="ghost" icon={<RotateCcw size={13} aria-hidden />} disabled={readOnly} onClick={() => onChange(null)} data-gallery-use-shopify="">
                {GALLERY_WORDS.useShopify}
              </Button>
            )}
          </div>
          {max != null && <p className="text-xs text-fg-subtle">{`${items.length} of ${max} images${full ? ". The list is full: remove one to add another." : ""}`}</p>}
        </section>
        <section aria-label="Shopify's images" className="min-w-0 space-y-2" data-gallery-shopify="">
          <p className="text-xs font-medium text-fg">Shopify&rsquo;s images</p>
          {!shopify && <p className="text-xs text-fg-subtle">{shopifyLabel}</p>}
          {shopify && shopify.length === 0 && <p className="text-xs text-fg-subtle">Shopify has no images for this product.</p>}
          {shopify && shopify.length > 0 && (
            <ol className="space-y-2">
              {shopify.map((s, j) => {
                const inList = items.some((x) => isObj(x) && sameImage(x.media, s.media));
                return (
                  <li key={j} className="flex items-center gap-2" data-shopify-image={textOf(s.media)}>
                    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-ctl border border-edge bg-surface-sunken">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.media} alt={textOf(s.alt)} className="h-full w-full object-cover" loading="lazy" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{textOf(s.alt) || `Shopify image ${j + 1}`}</span>
                    <IconButton
                      label={inList ? `Shopify image ${j + 1} is in your list` : `Add Shopify image ${j + 1} to your list`}
                      icon={<Plus size={14} aria-hidden />}
                      variant="secondary"
                      disabled={readOnly || inList || full}
                      onClick={() => add({ media: s.media, alt: textOf(s.alt) })}
                    />
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
      <Notes anchor={id} notes={notes} />
    </div>
  );
}
GalleryControl.paths = (field, value) => {
  const list = galleryList(value) || [];
  return [field.path, ...list.flatMap((_, j) => [`${field.path}.value.${j}`, `${field.path}.value.${j}.media`, `${field.path}.value.${j}.alt`])];
};
