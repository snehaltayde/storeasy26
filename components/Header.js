import Link from "next/link";
import SearchBox from "./SearchBox";
import CartButton from "./cart/CartButton";

export default function Header({ collections = [] }) {
  return (
    <header className="sticky top-0 z-30 bg-zinc-950 text-white">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="shrink-0 text-xl font-extrabold tracking-tight">
          BEAST<span className="text-lime-400">LIFE</span>
        </Link>

        <div className="hidden flex-1 md:block">
          <SearchBox />
        </div>

        <nav className="ml-auto hidden items-center gap-6 text-sm font-medium md:flex">
          <Link href="/collections" className="text-zinc-300 transition hover:text-white">
            Shop all
          </Link>
        </nav>

        <CartButton />
      </div>

      {/* Search drops to its own row on mobile */}
      <div className="px-4 pb-3 md:hidden">
        <SearchBox />
      </div>

      {collections.length > 0 && (
        <nav className="border-t border-white/10">
          <div className="no-scrollbar mx-auto flex max-w-7xl gap-1 overflow-x-auto px-3 sm:px-5">
            {collections.map((c) => (
              <Link
                key={c.handle}
                href={`/collections/${c.handle}`}
                className="whitespace-nowrap rounded-full px-3 py-2 text-sm text-zinc-300 transition hover:text-white"
              >
                {c.title}
              </Link>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}
