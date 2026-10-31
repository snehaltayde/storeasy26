import Link from "next/link";
import SearchBox from "./SearchBox";
import CartButton from "./cart/CartButton";

// Session 23: brand + nav come from tenant config/CMS. `nav` null = the
// pre-CMS behavior (scroller of all collections); an array replaces it.
// S61 (audit "Core" chrome contract): TWO structural variants —
//   "standard" (default): logo left, inline search, icons right, left-
//     aligned nav strip — the original layout, byte-identical.
//   "centered": logo centered between the shop link and the icons, search
//     always on its own centered row, nav strip centered.
// Both share the announcement bar, the icon set and the dropdown strip
// pieces, so navigation/cart/wishlist behavior is identical.

const WishlistIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z" />
  </svg>
);

const AccountIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
  </svg>
);

const Announcement = ({ announcement }) =>
  announcement?.enabled && announcement.text ? (
    <div data-sec="announcement" className="bg-accent-400 px-4 py-1.5 text-center text-xs font-semibold text-accent-label">
      {announcement.href ? (
        <Link href={announcement.href} className="hover:underline">
          {announcement.text}
        </Link>
      ) : (
        announcement.text
      )}
    </div>
  ) : null;

const Wordmark = ({ logo, className = "" }) => (
  <Link href="/" className={`shrink-0 text-xl font-extrabold tracking-tight ${className}`}>
    {logo.text1}
    {logo.text2 ? <span className="text-accent-400">{logo.text2}</span> : null}
  </Link>
);

const IconLinks = () => (
  <>
    {/* S49 (SF22): local-first wishlist */}
    <Link href="/wishlist" aria-label="Wishlist" className="shrink-0 p-1 text-header-muted transition hover:text-header-fg">
      <WishlistIcon />
    </Link>
    {/* S45 (SF10): optional shopper account — guest checkout untouched */}
    <Link href="/account" aria-label="Your account" className="shrink-0 p-1 text-header-muted transition hover:text-header-fg">
      <AccountIcon />
    </Link>
    <CartButton />
  </>
);

const NavStrip = ({ items, centered = false }) =>
  items.length > 0 && (
    <nav className="border-t border-header-fg/10">
      <div className={`no-scrollbar mx-auto flex max-w-7xl gap-1 overflow-x-auto px-3 sm:px-5 ${centered ? "md:justify-center" : ""}`}>
        {items.map((i) =>
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
  );

export default function Header({ collections = [], logo = { text1: "Store", text2: "" }, nav = null, announcement = null, variant = "standard" }) {
  const stripItems = Array.isArray(nav)
    ? nav.map((i) => ({ key: i.href + i.label, href: i.href, label: i.label, children: i.children || null }))
    : collections.map((c) => ({ key: c.handle, href: `/collections/${c.handle}`, label: c.title }));

  if (variant === "centered") {
    return (
      <header className="sticky top-0 z-30 bg-header text-header-fg">
        <Announcement announcement={announcement} />
        <div className="mx-auto grid max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 py-3 sm:px-6">
          <nav className="hidden items-center text-sm font-medium md:flex">
            <Link href="/collections" className="text-header-muted transition hover:text-header-fg">
              Shop all
            </Link>
          </nav>
          <span className="md:hidden" aria-hidden />
          <Wordmark logo={logo} className="justify-self-center text-center" />
          <span className="flex items-center justify-end gap-1">
            <IconLinks />
          </span>
        </div>
        {/* search gets its own centered row at every width */}
        <div className="mx-auto max-w-xl px-4 pb-3">
          <SearchBox />
        </div>
        <NavStrip items={stripItems} centered />
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-30 bg-header text-header-fg">
      <Announcement announcement={announcement} />

      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
        <Wordmark logo={logo} />

        <div className="hidden flex-1 md:block">
          <SearchBox />
        </div>

        <nav className="ml-auto hidden items-center gap-6 text-sm font-medium md:flex">
          <Link href="/collections" className="text-header-muted transition hover:text-header-fg">
            Shop all
          </Link>
        </nav>

        <IconLinks />
      </div>

      {/* Search drops to its own row on mobile */}
      <div className="px-4 pb-3 md:hidden">
        <SearchBox />
      </div>

      <NavStrip items={stripItems} />
    </header>
  );
}
