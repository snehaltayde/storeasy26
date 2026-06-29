import Link from "next/link";

export default function Footer({ collections = [] }) {
  return (
    <footer className="mt-20 border-t border-zinc-100 bg-zinc-50">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <p className="text-xl font-extrabold">
              BEAST<span className="text-lime-600">LIFE</span>
            </p>
            <p className="mt-3 max-w-sm text-sm text-zinc-500">
              Science-backed sports nutrition. Browse the real catalog — blazing fast.
            </p>
          </div>

          <div>
            <p className="mb-3 text-sm font-semibold text-zinc-900">Shop</p>
            <ul className="space-y-2 text-sm text-zinc-500">
              <li>
                <Link href="/collections" className="hover:text-zinc-900">
                  All collections
                </Link>
              </li>
              {collections.slice(0, 5).map((c) => (
                <li key={c.handle}>
                  <Link href={`/collections/${c.handle}`} className="hover:text-zinc-900">
                    {c.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-3 text-sm font-semibold text-zinc-900">Built with</p>
            <ul className="space-y-2 text-sm text-zinc-500">
              <li>Next.js · App Router</li>
              <li>Turso / libSQL · Kysely</li>
              <li>Typesense search</li>
              <li>Shopify Storefront API</li>
            </ul>
          </div>
        </div>

        <p className="mt-10 border-t border-zinc-200 pt-6 text-xs text-zinc-400">
          Demo storefront · catalog synced from the live Shopify store · not affiliated checkout
        </p>
      </div>
    </footer>
  );
}
