import Link from "next/link";
import Image from "@/components/StoreImage";
import BundleAddButton from "@/components/BundleAddButton";
import { formatMoney } from "@/lib/format";
import { stateLine } from "@/lib/commerce/bundle-words";
import { settingsOf, MediaFallback } from "./parts";

// P5-BLOCKS (COM-01, COM-02): one bundle on the home page (registry kind
// "bundle_card"). Server component, edge-safe. Its data is the bundle entry
// lib/commerce/bundle-read.js bundlesByIds gives (through the bundle_by_id
// source), read live at render: the version body holds only { id }.
//
// The state contract (plan 1.8), for shoppers:
//   available            shown, "Add the set to cart" on
//   sold_out, not_ready  shown, each unavailable product marked "Sold out" or
//                        "No longer available" (as the bundle page marks
//                        them), the button says "Currently unavailable" and
//                        is off
//   no_saving            hidden (OQ-B, the owner's answer of 2026-11-05), and
//                        so is any bundle whose reasons include no_saving,
//                        even when its state is sold_out or not_ready
//   disabled, missing    hidden (no entry at all counts as missing)
// When it is hidden, hiddenReason gives the founder the bundle-words sentence
// (components/sections/index.js hiddenNote shows it in a documents preview
// only). Money is formatMoney(amount, bundle.currency ?? undefined): never a
// written currency sign or code.
//
// The add button is components/BundleAddButton.js with the props the bundle
// page gives it: per product only variantId, quantity and available.

// The states a shopper may see a bundle in. A bundle that saves nothing is
// hidden whatever its state says: bundle-compat ranks sold_out and not_ready
// above no_saving, so a bundle with a sold-out product AND no saving has state
// sold_out, and its reasons are what tell (OQ-B, fix round 1).
export const SHOWN_STATES = Object.freeze(["available", "sold_out", "not_ready"]);
const reasonsOf = (b) => (Array.isArray(b?.reasons) ? b.reasons : []);
export const savesNothing = (b) => reasonsOf(b).some((r) => r?.kind === "no_saving");
export const isShown = (b) => b !== null && typeof b === "object" && SHOWN_STATES.includes(b.state) && !savesNothing(b);

// Why a bundle is not shown (or "" when it is), in bundle-words' sentences.
// Turned off and deleted keep their own words; any other hidden bundle that
// saves nothing gets the no-saving words.
export function bundleReason(b) {
  if (isShown(b)) return "";
  if (b === null || typeof b !== "object" || typeof b.state !== "string") return stateLine("missing");
  const opts = { currency: b.currency ?? undefined };
  if (b.state !== "disabled" && b.state !== "missing" && savesNothing(b)) return stateLine("no_saving", reasonsOf(b), opts);
  return stateLine(b.state, reasonsOf(b), opts) || stateLine("missing");
}

// What BundleAddButton gets for each product: the bundle page's props, no more.
export const addProps = (components) =>
  (Array.isArray(components) ? components : []).map((c) => ({ variantId: c?.variantId ?? null, quantity: Math.max(1, Number(c?.quantity) || 1), available: c?.available === true }));

const isText = (v) => typeof v === "string" && v.trim() !== "";

// One bundle: its products, price, saving, add button and link. The grid
// renders one per cell.
export function BundleBox({ bundle, Heading = "h3" }) {
  const cur = bundle.currency ?? undefined;
  const components = Array.isArray(bundle.components) ? bundle.components : [];
  const href = isText(bundle.slug) ? `/bundles/${bundle.slug}` : null;
  const price = Number(bundle.bundle_price);
  const sum = Number(bundle.componentsSum);
  const saving = Number(bundle.saving);
  return (
    <div data-bundle={bundle.id} data-bundle-state={bundle.state} className="flex h-full flex-col rounded-sf-card border border-sf-border p-5">
      <p className="text-xs font-bold uppercase tracking-wide text-sf-accent-text">{`${components.length}-piece set`}</p>
      <Heading className="mt-1 break-words text-xl font-extrabold tracking-tight">
        {href ? (
          <Link href={href} className="hover:underline">
            {bundle.title}
          </Link>
        ) : (
          bundle.title
        )}
      </Heading>
      <ul className="mt-4 space-y-3">
        {components.map((c, i) => (
          <li key={i} data-bundle-item={c.state || (c.available ? "ok" : "sold_out")} className={`flex items-center gap-3 ${c.available ? "" : "opacity-60"}`}>
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-sf-control bg-sf-surface-sunken">
              {isText(c.image) ? <Image src={c.image} alt={c.title || ""} fill sizes="56px" className="object-cover" /> : <MediaFallback alt={c.title || ""} className="h-full w-full" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-semibold">{c.title || "Unavailable item"}</p>
              <p className="text-xs text-sf-text-faint">
                {`×${Math.max(1, Number(c.quantity) || 1)}`}
                {!c.available ? <span className="ml-2 font-bold uppercase text-sf-text-subtle">{c.state === "missing" ? "No longer available" : "Sold out"}</span> : null}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-5">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-2xl font-extrabold">{formatMoney(price, cur)}</span>
          {sum > price ? <span className="text-base text-sf-text-faint line-through">{formatMoney(sum, cur)}</span> : null}
          {saving > 0 ? <span className="rounded-sf-xs bg-sf-sale-soft px-2 py-0.5 text-sm font-bold text-sf-on-sale-soft">{`You save ${formatMoney(saving, cur)}`}</span> : null}
        </p>
        <div className="mt-4">
          <BundleAddButton components={addProps(components)} disabled={bundle.state !== "available"} />
        </div>
        {href ? (
          <Link href={href} className="mt-3 inline-block text-sm font-medium text-sf-accent-text hover:underline">
            See the set →
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function BundleCardSection({ section, data = {}, ctx = {}, attrs = {} }) {
  if (!BundleCardSection.shows(section, data)) return null;
  const s = settingsOf(section);
  return (
    <section data-sec={ctx.secKey} {...attrs} className="py-sf-section">
      {isText(s.title) ? <h2 className="mb-6 text-2xl font-bold tracking-tight">{s.title}</h2> : null}
      <div className="max-w-xl">
        <BundleBox bundle={data.bundle} />
      </div>
    </section>
  );
}
BundleCardSection.shows = (section, data = {}) => isShown(data?.bundle);
BundleCardSection.hiddenReason = (section, data = {}) => (isShown(data?.bundle) ? null : bundleReason(data?.bundle));

export default BundleCardSection;
