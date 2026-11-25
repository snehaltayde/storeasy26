import Link from "next/link";

// P6-LOGO-RENDER (GEN-04): a documents store's picture logo (logo.image, a
// library path from the live design document) replaces the text wordmark in
// both spots. Its words are the founder's alt, else the store's name
// (logo.name), never text1 (half of a split wordmark). An explicit 48px height
// keeps an SVG with no size of its own from collapsing or growing.
export const FOOTER_LOGO_CLASS = "block h-12 max-h-12 w-auto max-w-full object-contain";

const FooterLogo = ({ logo, className = "" }) => (
  <img src={logo.image.media} alt={logo.image.alt || logo.name || ""} className={className ? `${FOOTER_LOGO_CLASS} ${className}` : FOOTER_LOGO_CLASS} />
);

// The wordmark (picture, else words). Phase 1 line 6: in a documents preview
// (`editing`) both are rendered, one hidden, as the slots onboarding's live
// preview draws an unsaved logo into; shoppers' markup is unchanged.
function FooterMark({ logo, editing, imgClass = "" }) {
  const picture = Boolean(logo.image?.media);
  const words = (
    <>
      {logo.text1}
      {logo.text2 ? <span className="text-sf-accent-strong">{logo.text2}</span> : null}
    </>
  );
  if (!editing) return picture ? <FooterLogo logo={logo} className={imgClass} /> : words;
  return (
    <>
      <img data-store-logo-img="" src={picture ? logo.image.media : undefined} alt={picture ? logo.image.alt || logo.name || "" : ""} hidden={!picture} className={imgClass ? `${FOOTER_LOGO_CLASS} ${imgClass}` : FOOTER_LOGO_CLASS} />
      <span data-store-logo-text="" hidden={picture}>
        {words}
      </span>
    </>
  );
}

// The one-line description; in a documents preview always rendered (hidden
// when empty) so the live preview can show an unsaved one.
function Tagline({ tagline, editing, className }) {
  if (editing) return <p data-store-tagline="" hidden={!tagline} className={className}>{tagline}</p>;
  return tagline ? <p className={className}>{tagline}</p> : null;
}

// Session 23: brand, support and the Shop column come from tenant config/CMS.
// `nav` null = top-5 collections (pre-CMS behavior); an array replaces it.
export default function Footer({
  collections = [],
  logo = { text1: "Store", text2: "" },
  nav = null,
  tagline = "",
  support = {},
  legalName = "",
  // S39 (MC11): links to pages that actually EXIST on this store — the old
  // hardcoded /policies/* list 404'd on tenants without those pages.
  pages = { about: true, policies: [] },
  variant = "columns", // S61: "columns" (default, original) | "minimal"
  // P3-FRAME (ED-04): a documents preview only: data-doc="doc_footer", the
  // document a click in the editor's frame picks. Shoppers' markup is unchanged.
  editing = false,
}) {
  const doc = editing ? { "data-doc": "doc_footer" } : {};
  // nested nav items flatten here (dropdowns are a header affordance)
  const shopItems = Array.isArray(nav)
    ? nav.flatMap((i) => [
        { key: i.href + i.label, href: i.href, label: i.label },
        ...(i.children || []).map((c) => ({ key: i.href + c.href + c.label, href: c.href, label: `· ${c.label}` })),
      ])
    : collections.slice(0, 5).map((c) => ({ key: c.handle, href: `/collections/${c.handle}`, label: c.title }));

  // S61 "minimal": one centered band — wordmark, a single link row, inline
  // support, legal line. Same links/pages logic, materially different
  // structure than the four-column default.
  if (variant === "minimal") {
    const links = [
      { key: "all", href: "/collections", label: "All collections" },
      ...(pages.about ? [{ key: "about", href: "/about", label: "About us" }] : []),
      { key: "contact", href: "/contact", label: "Contact" },
      ...pages.policies.map((p) => ({ key: p.href, href: p.href, label: p.label })),
    ];
    return (
      <footer {...doc} data-part="footer" className="mt-20 border-t border-sf-border-soft bg-sf-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-10 text-center sm:px-6">
          <p className="text-xl font-extrabold">
            <FooterMark logo={logo} editing={editing} imgClass="mx-auto" />
          </p>
          <Tagline tagline={tagline} editing={editing} className="mx-auto mt-2 max-w-md text-sm text-sf-text-subtle" />
          <nav className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-sf-text-subtle">
            {links.map((l) => (
              <Link key={l.key} href={l.href} data-part="footer-link" className="hover:text-sf-text">
                {l.label}
              </Link>
            ))}
          </nav>
          {(support.email || support.phone) && (
            <p className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-sm text-sf-text-subtle">
              {support.email ? (
                <a href={`mailto:${support.email}`} data-part="footer-link" className="hover:text-sf-text">
                  {support.email}
                </a>
              ) : null}
              {support.phone ? (
                <a href={`tel:${support.phone.replace(/[^+\d]/g, "")}`} data-part="footer-link" className="hover:text-sf-text">
                  {support.phone}
                </a>
              ) : null}
            </p>
          )}
          <p className="mt-8 border-t border-sf-border pt-5 text-xs text-sf-text-faint">© {legalName}</p>
        </div>
      </footer>
    );
  }

  return (
    <footer {...doc} data-part="footer" className="mt-20 border-t border-sf-border-soft bg-sf-surface-muted">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xl font-extrabold">
              <FooterMark logo={logo} editing={editing} />
            </p>
            <Tagline tagline={tagline} editing={editing} className="mt-3 max-w-sm text-sm text-sf-text-subtle" />
          </div>

          <div>
            <p className="mb-3 text-sm font-semibold text-sf-text">Shop</p>
            <ul className="space-y-2 text-sm text-sf-text-subtle">
              <li>
                <Link href="/collections" data-part="footer-link" className="hover:text-sf-text">
                  All collections
                </Link>
              </li>
              {shopItems.map((i) => (
                <li key={i.key}>
                  <Link href={i.href} data-part="footer-link" className="hover:text-sf-text">
                    {i.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-3 text-sm font-semibold text-sf-text">Company</p>
            <ul className="space-y-2 text-sm text-sf-text-subtle">
              {pages.about && (
                <li>
                  <Link href="/about" data-part="footer-link" className="hover:text-sf-text">
                    About us
                  </Link>
                </li>
              )}
              <li>
                <Link href="/contact" data-part="footer-link" className="hover:text-sf-text">
                  Contact
                </Link>
              </li>
              {pages.policies.map((p) => (
                <li key={p.href}>
                  <Link href={p.href} data-part="footer-link" className="hover:text-sf-text">
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-3 text-sm font-semibold text-sf-text">Support</p>
            <ul className="space-y-2 text-sm text-sf-text-subtle">
              {support.email ? (
                <li>
                  <a href={`mailto:${support.email}`} data-part="footer-link" className="hover:text-sf-text">
                    {support.email}
                  </a>
                </li>
              ) : null}
              {support.phone ? (
                <li>
                  <a href={`tel:${support.phone.replace(/[^+\d]/g, "")}`} data-part="footer-link" className="hover:text-sf-text">
                    {support.phone}
                  </a>
                </li>
              ) : null}
            </ul>
          </div>
        </div>

        <p className="mt-10 border-t border-sf-border pt-6 text-xs text-sf-text-faint">
          © {legalName}
        </p>
      </div>
    </footer>
  );
}
