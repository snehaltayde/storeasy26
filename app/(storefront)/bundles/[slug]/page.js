import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getBundle } from "@/lib/bundles";
import { formatMoney } from "@/lib/format";
import BundleAddButton from "@/components/BundleAddButton";
import { tfetch } from "@/lib/tenant-request";

// Bundle detail (S46 / SF18): the set, its components, the honest math
// (components sum vs bundle price) and one-tap add — priced by the offers
// engine, so the cart shows exactly this saving.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const b = await tfetch(() => getBundle(slug));
  if (!b) notFound();
  return { title: b.title, description: b.description?.slice(0, 160) || `${b.components.length}-piece set`, alternates: { canonical: `/bundles/${slug}` } };
}

export default async function BundlePage({ params }) {
  const { slug } = await params;
  const b = await tfetch(() => getBundle(slug));
  if (!b) notFound();
  const cur = "INR";

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <nav className="mb-4 text-sm text-zinc-400">
        <Link href="/" className="hover:text-zinc-600">Home</Link> / <span className="text-zinc-600">{b.title}</span>
      </nav>
      <p className="text-xs font-bold uppercase tracking-wide text-accent-700">{b.components.length}-piece set</p>
      <h1 className="mt-1 text-3xl font-extrabold tracking-tight">{b.title}</h1>
      {b.description && <p className="mt-3 max-w-2xl text-zinc-600">{b.description}</p>}

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <ul className="space-y-3">
          {b.components.map((c, i) => (
            <li key={i} className={`flex items-center gap-4 rounded-2xl border p-4 ${c.available ? "border-zinc-200" : "border-zinc-100 opacity-60"}`}>
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-zinc-100">
                {c.image && <Image src={c.image} alt={c.title || ""} fill sizes="64px" className="object-cover" />}
              </div>
              <div className="min-w-0 flex-1">
                {c.handle ? (
                  <Link href={`/products/${c.handle}`} className="text-sm font-semibold hover:underline">{c.title}</Link>
                ) : (
                  <p className="text-sm font-semibold">{c.title || "Unavailable item"}</p>
                )}
                <p className="text-xs text-zinc-400">
                  {c.variant_title && c.variant_title !== "Default Title" ? `${c.variant_title} · ` : ""}×{c.quantity}
                  {!c.available && <span className="ml-2 font-bold text-zinc-500">{c.state === "missing" ? "NO LONGER AVAILABLE" : "SOLD OUT"}</span>}
                </p>
              </div>
              {c.price != null && <span className="shrink-0 text-sm text-zinc-500 line-through">{formatMoney(c.price * c.quantity, cur)}</span>}
            </li>
          ))}
        </ul>

        <div className="h-fit rounded-2xl border border-zinc-200 p-6 lg:sticky lg:top-24">
          <p className="flex items-baseline gap-3">
            <span className="text-3xl font-extrabold">{formatMoney(b.bundle_price, cur)}</span>
            <span className="text-lg text-zinc-400 line-through">{formatMoney(b.componentsSum, cur)}</span>
            {b.saving > 0 && (
              <span className="rounded-md bg-accent-100 px-2 py-0.5 text-sm font-bold text-accent-800">
                Save {formatMoney(b.saving, cur)}
              </span>
            )}
          </p>
          <p className="mt-2 text-xs text-zinc-400">
            Everything is added as normal items — the set price applies automatically in your cart.
          </p>
          <div className="mt-5">
            <BundleAddButton components={b.components} disabled={!b.available} />
          </div>
          {!b.available && <p className="mt-2 text-xs text-zinc-400">A component is out of stock — the set comes back when it does.</p>}
        </div>
      </div>
    </div>
  );
}
