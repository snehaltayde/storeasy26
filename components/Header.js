import Link from "next/link";
import SearchBox from "./SearchBox";
import CartButton from "./cart/CartButton";

// Session 23: brand + nav come from tenant config/CMS. `nav` null = the
// pre-CMS behavior (scroller of all collections); an array replaces it.
export default function Header({ collections = [], logo = { text1: "Store", text2: "" }, nav = null, announcement = null }) {
  const stripItems = Array.isArray(nav)
    ? nav.map((i) => ({ key: i.href + i.label, href: i.href, label: i.label, children: i.children || null }))
    : collections.map((c) => ({ key: c.handle, href: `/collections/${c.handle}`, label: c.title }));

  return (
    <header className="sticky top-0 z-30 bg-header text-header-fg">
      {announcement?.enabled && announcement.text ? (
        <div className="bg-accent-400 px-4 py-1.5 text-center text-xs font-semibold text-accent-label">
          {announcement.href ? (
            <Link href={announcement.href} className="hover:underline">
              {announcement.text}
            </Link>
          ) : (
            announcement.text
          )}
        </div>
      ) : null}

      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="shrink-0 text-xl font-extrabold tracking-tight">
          {logo.text1}
          {logo.text2 ? <span className="text-accent-400">{logo.text2}</span> : null}
        </Link>

        <div className="hidden flex-1 md:block">
          <SearchBox />
        </div>

        <nav className="ml-auto hidden items-center gap-6 text-sm font-medium md:flex">
          <Link href="/collections" className="text-header-muted transition hover:text-header-fg">
            Shop all
          </Link>
        </nav>

        <CartButton />
      </div>

      {/* Search drops to its own row on mobile */}
      <div className="px-4 pb-3 md:hidden">
        <SearchBox />
      </div>

      {stripItems.length > 0 && (
        <nav className="border-t border-header-fg/10">
          <div className="no-scrollbar mx-auto flex max-w-7xl gap-1 overflow-x-auto px-3 sm:px-5">
            {stripItems.map((i) =>
              i.children?.length ? (
                // S39 (MC11): one-level dropdown — native <details> keeps it
                // keyboard- and screen-reader-friendly with zero client JS.
                <details key={i.key} className="group relative">
                  <summary className="flex cursor-pointer list-none items-center gap-1 whitespace-nowrap rounded-full px-3 py-2 text-sm text-header-muted transition hover:text-header-fg [&::-webkit-details-marker]:hidden">
                    {i.label}
                    <span aria-hidden="true" className="text-xs transition group-open:rotate-180">
                      ▾
                    </span>
                  </summary>
                  <div className="absolute left-0 top-full z-40 mt-1 min-w-44 rounded-xl border border-zinc-200 bg-white py-1 shadow-xl">
                    <Link href={i.href} className="block px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50">
                      {i.label}
                    </Link>
                    {i.children.map((c) => (
                      <Link key={c.href + c.label} href={c.href} className="block px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900">
                        {c.label}
                      </Link>
                    ))}
                  </div>
                </details>
              ) : (
                <Link
                  key={i.key}
                  href={i.href}
                  className="whitespace-nowrap rounded-full px-3 py-2 text-sm text-header-muted transition hover:text-header-fg"
                >
                  {i.label}
                </Link>
              ),
            )}
          </div>
        </nav>
      )}
    </header>
  );
}
