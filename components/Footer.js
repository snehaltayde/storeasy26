import Link from "next/link";

// Session 23: brand, support and the Shop column come from tenant config/CMS.
// `nav` null = top-5 collections (pre-CMS behavior); an array replaces it.
export default function Footer({
  collections = [],
  logo = { text1: "Store", text2: "" },
  nav = null,
  tagline = "",
  support = {},
  legalName = "",
}) {
  const shopItems = Array.isArray(nav)
    ? nav.map((i) => ({ key: i.href + i.label, href: i.href, label: i.label }))
    : collections.slice(0, 5).map((c) => ({ key: c.handle, href: `/collections/${c.handle}`, label: c.title }));

  return (
    <footer className="mt-20 border-t border-zinc-100 bg-zinc-50">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xl font-extrabold">
              {logo.text1}
              {logo.text2 ? <span className="text-lime-600">{logo.text2}</span> : null}
            </p>
            {tagline ? <p className="mt-3 max-w-sm text-sm text-zinc-500">{tagline}</p> : null}
          </div>

          <div>
            <p className="mb-3 text-sm font-semibold text-zinc-900">Shop</p>
            <ul className="space-y-2 text-sm text-zinc-500">
              <li>
                <Link href="/collections" className="hover:text-zinc-900">
                  All collections
                </Link>
              </li>
              {shopItems.map((i) => (
                <li key={i.key}>
                  <Link href={i.href} className="hover:text-zinc-900">
                    {i.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-3 text-sm font-semibold text-zinc-900">Company</p>
            <ul className="space-y-2 text-sm text-zinc-500">
              <li>
                <Link href="/about" className="hover:text-zinc-900">
                  About us
                </Link>
              </li>
              <li>
                <Link href="/contact" className="hover:text-zinc-900">
                  Contact
                </Link>
              </li>
              <li>
                <Link href="/policies/terms" className="hover:text-zinc-900">
                  Terms of service
                </Link>
              </li>
              <li>
                <Link href="/policies/privacy" className="hover:text-zinc-900">
                  Privacy policy
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className="mb-3 text-sm font-semibold text-zinc-900">Support</p>
            <ul className="space-y-2 text-sm text-zinc-500">
              <li>
                <Link href="/policies/shipping" className="hover:text-zinc-900">
                  Shipping policy
                </Link>
              </li>
              <li>
                <Link href="/policies/returns" className="hover:text-zinc-900">
                  Returns &amp; refunds
                </Link>
              </li>
              {support.email ? (
                <li>
                  <a href={`mailto:${support.email}`} className="hover:text-zinc-900">
                    {support.email}
                  </a>
                </li>
              ) : null}
              {support.phone ? (
                <li>
                  <a href={`tel:${support.phone.replace(/[^+\d]/g, "")}`} className="hover:text-zinc-900">
                    {support.phone}
                  </a>
                </li>
              ) : null}
            </ul>
          </div>
        </div>

        <p className="mt-10 border-t border-zinc-200 pt-6 text-xs text-zinc-400">
          © {legalName} · Catalog synced from the live Shopify store
        </p>
      </div>
    </footer>
  );
}
