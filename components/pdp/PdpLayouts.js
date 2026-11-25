import Link from "next/link";
import ProductGallery from "@/components/ProductGallery";
import ProductPurchase from "@/components/ProductPurchase";
import WishlistButton from "@/components/WishlistButton";
import ProductCard from "@/components/ProductCard";
import { sanitizeHtml } from "@/lib/sanitize";
import PluginSlot from "@/components/plugins/PluginSlot";

// PDP template variants (S56 / audit slices 3-4): materially different
// LAYOUTS over the SAME functional components — ProductPurchase (variants,
// price, availability, add-to-cart), ProductGallery and WishlistButton are
// reused untouched; commerce behavior never forks per template.
//   classic   — the original two-column gallery/purchase (moved verbatim)
//   editorial — full-bleed lead image, centered story flow, sticky buy panel
// The family default is picked in Theme → Page templates (draft → publish).

// P4-EFFECTIVE (OVL-03): the vendor line shows the effective display_vendor.
function VendorBadge({ product, override, center = false }) {
  if (!product.display_vendor && !override?.badge) return null;
  return (
    <p className={`flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-sf-accent-text ${center ? "justify-center" : ""}`}>
      {product.display_vendor}
      {override?.badge ? (
        <span className="rounded-full bg-sf-accent-soft px-2.5 py-0.5 text-sf-2xs font-bold normal-case tracking-normal text-sf-on-accent-soft">
          {override.badge}
        </span>
      ) : null}
    </p>
  );
}

function DetailsBlock({ product }) {
  if (product.description_html) {
    return (
      <div className="mt-8 border-t border-sf-border-soft pt-8">
        <h2 className="mb-3 text-lg font-bold">Details</h2>
        {/* Merchant-authored HTML from the store's own Shopify catalog —
            allowlist-sanitized (S35): a compromised catalog must not XSS shoppers. */}
        <div className="rte" dangerouslySetInnerHTML={{ __html: sanitizeHtml(product.description_html) }} />
      </div>
    );
  }
  if (product.description) {
    return (
      <div className="mt-8 border-t border-sf-border-soft pt-8">
        <h2 className="mb-3 text-lg font-bold">Details</h2>
        <p className="whitespace-pre-line text-sf-text-body">{product.description}</p>
      </div>
    );
  }
  return null;
}

function Accordions({ override, extras }) {
  if (!(override?.modules?.length > 0 || extras?.length > 0)) return null;
  return (
    // data-sec: S59 surface designer click-target (PreviewBridge select)
    <div data-sec="pdp-modules" className="mt-6 divide-y divide-sf-border-soft border-t border-sf-border-soft">
      {[...(override?.modules || []), ...(extras || [])].map((x) => (
        <details key={x.title} className="group py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-sf-text-soft [&::-webkit-details-marker]:hidden">
            {x.title}
            <span className="text-sf-text-faint transition group-open:rotate-45">+</span>
          </summary>
          <div className="rte mt-2 text-sm text-sf-text-muted" dangerouslySetInnerHTML={{ __html: x.html }} />
        </details>
      ))}
    </div>
  );
}

export function PairsSection({ pairs }) {
  if (!(pairs?.products?.length > 0)) return null;
  return (
    <section data-sec="pdp-pairs" className="mt-16 border-t border-sf-border-soft pt-10">
      <h2 className="mb-6 text-2xl font-bold tracking-tight">{pairs.title}</h2>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {pairs.products.map((p) => (
          <ProductCard key={p.handle} product={p} />
        ))}
      </div>
    </section>
  );
}

// Phase 4 line 2: the three product-page plugin slots, the same in both layouts.
// Phase 5 line 2: the buy box is Storeasy's own (data-protected): an uploaded
// theme's styles target data-part hooks, and none is inside it.
const Purchase = ({ product }) => (
  <div data-protected="buy-box">
    <ProductPurchase
      product={product}
      underPrice={<PluginSlot name="storefront.pdp.under_price" ctx={product} className="mt-4" />}
      underAtc={<PluginSlot name="storefront.pdp.under_atc" ctx={product} className="mt-5" />}
    />
  </div>
);
const BelowFold = ({ product }) => <PluginSlot name="storefront.pdp.below_fold" ctx={product} className="mt-8" />;

// ---- classic: the original layout, moved verbatim ---------------------------
export function PdpClassic({ product, override, extras, pairs }) {
  return (
    <div data-pdp-template="classic">
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <ProductGallery images={product.images} title={product.title} />

        <div>
          <VendorBadge product={product} override={override} />
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight">{product.title}</h1>

          <Purchase product={product} />
          <div className="mt-3">
            <WishlistButton handle={product.handle} />
          </div>

          <DetailsBlock product={product} />
          <Accordions override={override} extras={extras} />
          <BelowFold product={product} />
        </div>
      </div>

      <PairsSection pairs={pairs} />
    </div>
  );
}

// ---- editorial: story-led, sticky buy panel ---------------------------------
export function PdpEditorial({ product, override, extras, pairs }) {
  const lead = product.images?.[0] || null;
  return (
    <div data-pdp-template="editorial">
      {lead ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={lead.url}
          alt={lead.alt || product.title}
          className="aspect-[16/7] w-full rounded-brand object-cover"
          fetchPriority="high"
        />
      ) : null}
      <div className="mx-auto mt-8 max-w-2xl text-center">
        <VendorBadge product={product} override={override} center />
        <h1 className="mt-1 font-display text-4xl font-extrabold tracking-tight sm:text-5xl">{product.title}</h1>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <DetailsBlock product={product} />
          <Accordions override={override} extras={extras} />
          <BelowFold product={product} />
          {product.images?.length > 1 ? (
            <div className="mt-10 grid grid-cols-2 gap-4">
              {product.images.slice(1, 5).map((img, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={img.url} alt={img.alt || `${product.title} ${i + 2}`} loading="lazy" className="w-full rounded-brand object-cover" />
              ))}
            </div>
          ) : null}
        </div>
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-brand border border-sf-border p-5 shadow-sm">
            <Purchase product={product} />
            <div className="mt-3">
              <WishlistButton handle={product.handle} />
            </div>
          </div>
        </aside>
      </div>

      <PairsSection pairs={pairs} />
    </div>
  );
}
