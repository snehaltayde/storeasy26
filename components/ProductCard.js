import Link from "next/link";
import Image from "next/image";
import { formatMoney, discountPercent } from "@/lib/format";

export default function ProductCard({ product, priority = false }) {
  const {
    handle,
    title,
    product_type,
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
    <Link href={`/products/${handle}`} className="group block">
      <div className="relative aspect-square overflow-hidden rounded-2xl bg-zinc-100">
        {featured_image ? (
          <Image
            src={featured_image}
            alt={featured_image_alt || title}
            fill
            priority={priority}
            sizes="(min-width:1024px) 25vw, (min-width:640px) 33vw, 50vw"
            className="object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-zinc-400">
            No image
          </div>
        )}

        {!available && (
          <span className="absolute left-3 top-3 rounded-full bg-zinc-900/85 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
            Sold out
          </span>
        )}
        {available && pct > 0 && (
          <span className="absolute left-3 top-3 rounded-full bg-lime-400 px-2.5 py-1 text-[11px] font-bold text-zinc-900">
            -{pct}%
          </span>
        )}
      </div>

      <div className="mt-3 space-y-1">
        {product_type ? (
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            {product_type}
          </p>
        ) : null}
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-zinc-900 transition-colors group-hover:text-lime-700">
          {title}
        </h3>
        <p className="text-sm">
          {ranged && <span className="text-zinc-500">from </span>}
          <span className="font-semibold text-zinc-900">{formatMoney(price_min, currency)}</span>
          {onSale && (
            <span className="ml-2 text-xs text-zinc-400 line-through">
              {formatMoney(compare_at_min, currency)}
            </span>
          )}
        </p>
      </div>
    </Link>
  );
}
