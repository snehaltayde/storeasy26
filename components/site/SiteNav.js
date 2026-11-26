import Link from "next/link";
import StoreImage from "@/components/StoreImage";
import SiteNavBar from "./SiteNavBar";

// Marketing-site chrome (S44; rebranded 2026-11-26; header v4 the same day):
// the header and the footer every platform-host page shares. The header is a
// floating glass pill with a Product menu and a small-screen sheet; its moving
// parts are the client island ./SiteNavBar.js and its words are NAV in
// ./landing-copy.js. The footer is a server component with no client JS.
// Colours are the .mk tokens in app/marketing.css; the logo is the
// "storeasy by mediaStic" lockup (1762×471, transparent), drawn on paper only:
// its navy wordmark has no dark-surface version, so the pill is always light.
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
// Each className sets the height and the width together, as a pair per
// breakpoint, and the pair from `sm` equals the attributes. With `w-auto` the
// browser took the width from the resized file's own ratio (149px against the
// attribute's 150), which next/image reports as "width or height modified".
function Logo({ height, priority = false, className }) {
  return <StoreImage src="/brand/storeasy-by-mediastic.png" alt="Storeasy by mediaStic" width={Math.round(height * (1762 / 471))} height={height} priority={priority} className={className} />;
}

export default function SiteNav() {
  return (
    <SiteNavBar>
      <Link href="/" className={`shrink-0 rounded-md ${ring}`}>
        <Logo height={40} priority className="h-8 w-[120px] object-contain sm:h-10 sm:w-[150px]" />
      </Link>
    </SiteNavBar>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-mk-rule bg-mk-mist">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="flex flex-wrap items-start justify-between gap-x-12 gap-y-8">
          <Link href="/" className={`shrink-0 rounded-md ${ring}`}>
            <Logo height={56} className="h-12 w-[180px] object-contain sm:h-14 sm:w-[209px]" />
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
