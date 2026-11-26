import Link from "next/link";
import StoreImage from "@/components/StoreImage";

// Marketing-site chrome (S44; rebranded 2026-11-26): the header and the
// footer every platform-host page shares. Server components, zero client JS.
// Colours are the .mk tokens in app/marketing.css; the logo is the
// "storeasy by mediaStic" lockup (1762×471, transparent), drawn on paper only:
// its navy wordmark has no dark-surface version.
const LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/templates", label: "Templates" },
  { href: "/integrations", label: "Integrations" },
  { href: "/customers", label: "Customers" },
  { href: "/trust", label: "Trust" },
];

const FOOTER = [
  { href: "/pricing", label: "Pricing" },
  { href: "/templates", label: "Templates" },
  { href: "/integrations", label: "Integrations" },
  { href: "/trust", label: "Trust & security" },
  { href: "/contact", label: "Contact" },
];

const LEGAL = [
  { href: "/legal/terms", label: "Terms" },
  { href: "/legal/privacy", label: "Privacy" },
];

const ring = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mk-blue";

// The lockup is 3.74:1; the width and height below keep that ratio at the
// drawn size so next/image asks for a file no larger than the screen needs.
// StoreImage is the app's one door to next/image (test:images).
function Logo({ height, priority = false, className }) {
  return <StoreImage src="/brand/storeasy-by-mediastic.png" alt="Storeasy by mediaStic" width={Math.round(height * (1762 / 471))} height={height} priority={priority} className={className} />;
}

export default function SiteNav() {
  return (
    <header className="sticky top-0 z-30 border-b border-mk-rule bg-white/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:gap-6 sm:px-6">
        <Link href="/" className={`shrink-0 rounded-md ${ring}`}>
          <Logo height={40} priority className="h-9 w-auto sm:h-10" />
        </Link>
        <nav aria-label="Storeasy" className="no-scrollbar flex gap-1 overflow-x-auto text-sm font-medium">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={`rounded-full px-3 py-1.5 whitespace-nowrap text-mk-body transition-colors hover:bg-mk-mist hover:text-mk-navy ${ring}`}>
              {l.label}
            </Link>
          ))}
        </nav>
        <Link href="/contact" className={`mk-cta ml-auto shrink-0 rounded-full px-5 py-2.5 text-sm font-semibold ${ring}`}>
          Talk to us
        </Link>
      </div>
      <span aria-hidden="true" className="mk-progress" />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-mk-rule bg-mk-mist">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="flex flex-wrap items-start justify-between gap-x-12 gap-y-8">
          <Link href="/" className={`shrink-0 rounded-md ${ring}`}>
            <Logo height={56} className="h-12 w-auto sm:h-14" />
          </Link>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-7 gap-y-3 text-[0.9375rem] font-medium">
              {FOOTER.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={`rounded text-mk-body transition-colors hover:text-mk-violet ${ring}`}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="mk-hairline mt-10" />
        <ul className="mt-6 flex gap-6 text-sm text-mk-muted">
          {LEGAL.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className={`rounded transition-colors hover:text-mk-navy ${ring}`}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </footer>
  );
}
