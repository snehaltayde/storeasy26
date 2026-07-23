import Link from "next/link";

export default function Footer({ collections = [] }) {
  return (
    <footer className="mt-20 border-t border-zinc-100 bg-zinc-50">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xl font-extrabold">
              BEAST<span className="text-lime-600">LIFE</span>
            </p>
            <p className="mt-3 max-w-sm text-sm text-zinc-500">
              Science-backed sports nutrition. Train harder. Recover stronger. Go Beast Mode.
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
              <li>
                <a href="mailto:care@beastlife.in" className="hover:text-zinc-900">
                  care@beastlife.in
                </a>
              </li>
              <li>
                <a href="tel:+919599339358" className="hover:text-zinc-900">
                  +91-9599339358
                </a>
              </li>
            </ul>
          </div>
        </div>

        <p className="mt-10 border-t border-zinc-200 pt-6 text-xs text-zinc-400">
          © RAK Fitness Consumer Pvt. Ltd. · Catalog synced from the live Shopify store
        </p>
      </div>
    </footer>
  );
}
