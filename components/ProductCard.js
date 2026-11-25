import Link from "next/link";
import FadeImage from "./FadeImage";
import { formatMoney, discountPercent } from "@/lib/format";
import Price from "@/components/Price";

export default function ProductCard({ product, priority = false }) {
  const {
    handle,
    title,
    // P4-EFFECTIVE (OVL-03): the type label the store shows (the founder's
    // display type, else Shopify's), never the raw type used for logic
    display_type,
    featured_image,
    featured_image_alt,
    price_min,
    price_max,
    compare_at_min,
    currency = "INR",
    available = true,
  } = product;

  const onSale = compare_at_min != null && Number(compare_at_min) > Number(price_min);
  const pct = onSale ? discountPercent(price_min, compare_at_min) : 0;
  const ranged = price_max != null && Number(price_max) > Number(price_min);

  return (
    <Link href={`/products/${handle}`} data-part="product-card" className="group block">
      <div className="relative aspect-square overflow-hidden rounded-sf-card bg-sf-surface-sunken">
        {featured_image ? (
          <FadeImage
            src={featured_image}
            alt={featured_image_alt || title}
            fill
            priority={priority}
            sizes="(min-width:1024px) 25vw, (min-width:640px) 33vw, 50vw"
            className="object-cover group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-sf-text-faint">
            No image
          </div>
        )}

        {!available && (
          <span data-part="badge" className="absolute left-3 top-3 rounded-full bg-sf-inverse/85 px-2.5 py-1 text-sf-2xs font-semibold uppercase tracking-wide text-sf-on-inverse">
            Sold out
          </span>
        )}
        {available && pct > 0 && (
          <span data-part="badge" className="absolute left-3 top-3 rounded-full bg-sf-sale px-2.5 py-1 text-sf-2xs font-bold text-sf-on-sale">
            -{pct}%
          </span>
        )}
      </div>

      <div className="mt-3 space-y-1">
        {display_type ? (
          <p className="text-sf-2xs font-medium uppercase tracking-wide text-sf-text-faint">
            {display_type}
          </p>
        ) : null}
        <h3 data-part="product-card-title" className="line-clamp-2 text-sm font-medium leading-snug text-sf-text transition-colors group-hover:text-sf-accent-text">
          {title}
        </h3>
        <p data-part="product-card-price" className="text-sm">
          {ranged && <span className="text-sf-text-subtle">from </span>}
          <span className="font-semibold text-sf-text"><Price amount={price_min} currency={currency} /></span>
          {onSale && (
            <span className="ml-2 text-xs text-sf-text-faint line-through">
              <Price amount={compare_at_min} currency={currency} />
            </span>
          )}
        </p>
      </div>
    </Link>
  );
}
