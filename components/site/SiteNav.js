import Link from "next/link";

// Marketing-site navigation (S44). Server component, zero client JS.
const LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/templates", label: "Templates" },
  { href: "/integrations", label: "Integrations" },
  { href: "/customers", label: "Customers" },
  { href: "/trust", label: "Trust" },
];

export default function SiteNav() {
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-100 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-5 px-4 py-3.5 sm:px-6">
        <Link href="/" className="text-lg font-extrabold tracking-tight">
          Store<span className="text-lime-600">asy</span>
        </Link>
        <nav className="no-scrollbar flex gap-1 overflow-x-auto text-sm font-medium">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="whitespace-nowrap rounded-lg px-3 py-1.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
              {l.label}
            </Link>
          ))}
        </nav>
        <Link href="/contact" className="ml-auto shrink-0 rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">
          Talk to us
        </Link>
      </div>
    </header>
  );
}
