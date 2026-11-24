import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import "../globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { CartProvider } from "@/components/cart/CartContext";
import CartDrawer from "@/components/cart/CartDrawer";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import ConsentBanner from "@/components/analytics/ConsentBanner";
import Pixels from "@/components/analytics/Pixels";
import ErrorReporter from "@/components/analytics/ErrorReporter";
import { cookies } from "next/headers";
import { getAllCollections } from "@/lib/repo";
import { getCart, emptyCart, shopperCart, CART_COOKIE } from "@/lib/cart";
import { siteUrl, siteName, siteTitle, siteTagline, siteFooterTagline, siteLogo, siteSupport, siteLegalName } from "@/lib/site";
import { tenantOwnCfg } from "@/lib/tenant-context";
import { resolveBrand, brandCssVars } from "@/lib/brand";
import { resolvedAnnouncement, resolvedNav, resolvedBrand, resolvedTheme, resolvedLogo, resolvedContentPageList, resolvedSurfaceTemplates, contentSource, isContentUnavailable, previewFrameRoutes } from "@/lib/content/resolve";
import { kitAttr } from "@/lib/themes/kits";
import { tfetch, requestResolution } from "@/lib/tenant-request";
import { isGated } from "@/lib/tenant-gate";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { curtainPalette, curtainTitle } from "@/lib/maintenance";
import { storeCurtain } from "@/lib/storefront-request";
import { headers } from "next/headers";
import SiteNav from "@/components/site/SiteNav";
import Link from "next/link";
import PreviewBridgeMount from "@/components/preview/PreviewBridge";
import PreviewBanner, { PreviewMain } from "@/components/PreviewBanner";
import EditThisPage from "@/components/preview/EditThisPage";
import { DOCUMENTS_RELEASE_VERSION } from "@/lib/releases";
import StoreClosed from "@/components/StoreClosed";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// S37: display serif for kits that ask for one (Glow). Loaded once; kits pick
// it up through the --display-font token.
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], weight: ["400", "600", "700"] });

// Render pages on the edge runtime — the libSQL client resolves to its
// fetch-based `edge-light` build, and search uses edge-safe fetch.
export const runtime = "edge";

// Session 23: metadata resolves per tenant (was a hardcoded BeastLife export).
// S25: gated hosts (unknown/suspended/control-plane-down in platform mode) get
// neutral metadata — no siteName()/siteUrl() env fallback, no manifest, noindex.
export async function generateMetadata() {
  // S44: marketing hosts get the PLATFORM's metadata, not a tenant's.
  if (isPlatformSiteHost((await headers()).get("host"))) {
    return {
      title: { default: "Storeasy — fast, branded storefronts on your Shopify catalog", template: "%s · Storeasy" },
      description: "Launch a fast, branded storefront on your existing Shopify catalog — themes, offers, releases and analytics included.",
    };
  }
  if (isGated(await requestResolution())) {
    return { title: "Store", robots: { index: false } };
  }
  // PUB-06: a closed store's metadata says nothing about it beyond its name:
  // no tagline, no manifest, not indexed.
  if (await closedNow()) {
    const name = await tfetch(async () => siteName()).catch(() => "Store");
    return { title: { absolute: `${name} · Opening soon` }, description: "Opening soon.", robots: { index: false, follow: false } };
  }
  const [name, title, tagline, url, closed] = await tfetch(async () => [siteName(), siteTitle(), siteTagline(), siteUrl(), Boolean(await storeCurtain())]);
  // A template with no %s replaces whatever title the page sets.
  const closedTitle = closed ? curtainTitle(name) : null;
  return {
    metadataBase: new URL(url),
    title: closedTitle ? { default: closedTitle, template: closedTitle } : { default: title, template: `%s · ${name}` },
    description: tagline,
    manifest: "/manifest.webmanifest",
    applicationName: name,
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: name },
    icons: {
      icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
      apple: [{ url: "/icons/icon-192.png" }],
    },
  };
}

export const viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
};

async function navCollections() {
  try {
    return await tfetch(() => getAllCollections());
  } catch {
    return [];
  }
}

// One tenant-scoped pass for everything the chrome needs (brand + CMS).
async function chromeData() {
  try {
    return await tfetch(async () => {
      const [announcement, navHeader, navFooter, brand, theme, src, pageList, surfaces, routes, logoImage] = await Promise.all([
        resolvedAnnouncement(),
        resolvedNav("header"),
        resolvedNav("footer"),
        resolvedBrand(),
        resolvedTheme(),
        contentSource(),
        resolvedContentPageList().catch(() => []),
        resolvedSurfaceTemplates(), // S61: header/footer structural variants (release-governed)
        previewFrameRoutes().catch(() => null), // P3-FRAME: documents preview only, else null
        resolvedLogo(), // P6-LOGO-RENDER: null unless a v4 source's design has a logo
      ]);
      // S39 (MC11): footer links only to pages that EXIST on this store.
      const enabledPages = pageList.filter((p) => p.enabled && (p.family || "page") === "page");
      const footerPages = {
        about: enabledPages.some((p) => p.slug === "about"),
        policies: enabledPages
          .filter((p) => p.slug !== "about" && p.slug !== "contact")
          .slice(0, 6)
          .map((p) => ({ label: p.title, href: `/policies/${p.slug}` })),
      };
      return {
        name: siteName(),
        // P6-LOGO-RENDER (GEN-04): a documents store (a v4 source) also hands
        // the chrome its picture logo and the store's name, the logo's words
        // when the founder gave none. Legacy and migrating stores pass the
        // text pair exactly as before, with no image key.
        logo: src.v === DOCUMENTS_RELEASE_VERSION ? { image: logoImage, name: siteName(), ...siteLogo() } : siteLogo(),
        footerTagline: siteFooterTagline(),
        support: siteSupport(),
        legalName: siteLegalName(),
        announcement,
        navHeader,
        navFooter,
        // Browser pixel ids, TENANT-scoped (S24 quirk fix) — a tenant without
        // its own ids loads no pixels, never the env default's.
        ga4Id: tenantOwnCfg("ga4_measurement_id", "NEXT_PUBLIC_GA4_MEASUREMENT_ID", "") || "",
        metaPixelId: tenantOwnCfg("meta_pixel_id", "NEXT_PUBLIC_META_PIXEL_ID", "") || "",
        // S35 (MC10) + S36 (BE09): brand tokens come through the release
        // resolver — published brand serves live, a brand edit stays draft
        // (and previewable) until the next publish. Default brand emits
        // nothing (globals.css already carries those values).
        // TOK-01: the kit decides the header/hero surfaces the accent is checked on;
        // with no brand, only the kit's header/hero accent corrections (if any)
        brandCss: brandCssVars(brand ? resolveBrand(brand) : null, { kit: kitAttr(theme) }),
        kitAttr: kitAttr(theme),
        preview: src.preview,
        // P2-PREVIEW: what a documents preview shows
        // P6-LOGO-RENDER: designShown too, so the bar never says the new
        // colours are not shown while they are (a store with no live design)
        previewOverlay: src.overlay ? { designDirty: src.overlay.designDirty, showDesign: src.overlay.showDesign, designShown: src.overlay.designShown === true, otherTab: src.overlay.otherTab } : null,
        frame: frameOf(src, routes),
        footerPages,
        headerVariant: surfaces.header || "standard",
        footerVariant: surfaces.footer || "columns",
      };
    });
  } catch (e) {
    const neutral = {
      name: "Store",
      logo: { text1: "Store", text2: "" },
      footerTagline: "",
      support: {},
      legalName: "Store",
      announcement: { enabled: false },
      navHeader: null,
      navFooter: null,
      ga4Id: "",
      metaPixelId: "",
      brandCss: "",
      kitAttr: "pulse-1",
      preview: false,
      previewOverlay: null,
      frame: null,
      footerPages: { about: false, policies: [] },
      headerVariant: "standard",
      footerVariant: "columns",
    };
    // P2-VGATE: published content can't be read (a release that can't be
    // read, or a v4 release before its reader exists). The page itself shows
    // the error surface; the chrome around it must show nothing of the store.
    // Empty nav lists, not null: null makes Header and Footer list the
    // catalog's collections instead.
    if (isContentUnavailable(e)) return { ...neutral, navHeader: [], navFooter: [] };
    return neutral;
  }
}

// P3-FRAME (PV-01, ED-04): what the editor's frame needs from this request.
//   documents preview  { kind: "documents", state, routes, offline } for the
//                      bridge (ok), the banner and the preview-only data-doc
//   ended preview      { kind: "refused", reason } (a session token this store
//                      signed whose session was revoked, expired or not found)
//   a live v4 page     { kind: "live" }: a console cookie may then mount the
//                      bridge with reason "live" and the Edit this page link
//   anything else      null: the plain markup
function frameOf(src, routes) {
  if (src.preview === true && src.v === DOCUMENTS_RELEASE_VERSION && src.overlay) {
    const o = src.overlay;
    const offline = Array.isArray(o.offline) ? o.offline : [];
    return {
      kind: "documents",
      state: { kind: "documents", sid: o.sid, docs: o.docs || {}, offline, skipped: Array.isArray(o.skipped) ? o.skipped : [], designShown: o.designShown === true },
      routes: routes || {},
      offline,
    };
  }
  if (src.preview !== true && typeof src.previewRefused === "string") return { kind: "refused", reason: src.previewRefused };
  if (src.preview !== true && src.v === DOCUMENTS_RELEASE_VERSION && src.mode === "live") return { kind: "live" };
  return null;
}

// Presence only: a browser signed in to the console (store or platform). Never
// proof of anything; it only decides whether the founder's own frame helpers
// (the bridge saying "live", the Edit this page link) are sent.
async function consoleCookiePresent() {
  try {
    const jar = await cookies();
    return Boolean(jar.get("_admin") || jar.get("_platform"));
  } catch {
    return false;
  }
}

// PUB-06: the store is closed to this request: documents mode, never
// published, and no valid preview session (a founder's preview gets the
// "live" preview source instead, never "closed"). Console cookies (_admin,
// _platform, _mx) play no part. A source that can't be read is not "closed":
// the page's own read then shows the error surface, as before.
async function closedNow() {
  try {
    return (await tfetch(() => contentSource())).mode === "closed";
  } catch {
    return false;
  }
}

// The maintenance curtain's name, brand and theme when they can't be read.
const NEUTRAL_CURTAIN = ["Store", null, null];

// P4-EFFECTIVE (OVL-06, plan decision 13): the cart handed to CartProvider (a
// client component) is the shopper's projection: no Shopify title or SKU.
async function initialCart() {
  try {
    const id = (await cookies()).get(CART_COOKIE)?.value;
    return id ? shopperCart(await tfetch(() => getCart(id))) : emptyCart();
  } catch {
    return emptyCart();
  }
}

export default async function RootLayout({ children }) {
  // S44: the marketing website — same app, designated PLATFORM hosts
  // (PLATFORM_SITE_HOSTS). Own chrome; no tenant storefront machinery.
  if (isPlatformSiteHost((await headers()).get("host"))) {
    return (
      <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full`}>
        <body className="flex min-h-full flex-col bg-white text-zinc-900 antialiased">
          <SiteNav />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-zinc-100 bg-zinc-50">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-8 text-xs text-zinc-500 sm:px-6">
              <span className="font-bold text-zinc-800">Storeasy</span>
              <Link href="/pricing" className="hover:text-zinc-900">Pricing</Link>
              <Link href="/templates" className="hover:text-zinc-900">Templates</Link>
              <Link href="/integrations" className="hover:text-zinc-900">Integrations</Link>
              <Link href="/trust" className="hover:text-zinc-900">Trust & security</Link>
              <Link href="/contact" className="hover:text-zinc-900">Contact</Link>
              <span className="ml-auto flex gap-4">
                <Link href="/legal/terms" className="hover:text-zinc-900">Terms</Link>
                <Link href="/legal/privacy" className="hover:text-zinc-900">Privacy</Link>
              </span>
            </div>
          </footer>
        </body>
      </html>
    );
  }

  // S25 fail-closed: gated hosts render a bare neutral shell — no tenant (or
  // env-fallback) chrome, cart, pixels, consent banner or service worker. The
  // page below still runs; its tfetch() calls notFound()/throw, which land in
  // the neutral not-found / error surfaces inside this shell.
  if (isGated(await requestResolution())) {
    return (
      <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
        <body className="flex min-h-full flex-col bg-white text-zinc-900 antialiased">
          <main className="flex-1">{children}</main>
        </body>
      </html>
    );
  }

  // PUB-06: a store that has never published shows "Opening soon" instead of
  // any page, with neutral brand values. It wins over maintenance: the
  // maintenance check and its cookie bypass are not consulted, so a console
  // cookie never opens a closed store (only a preview session does, above,
  // through the content source).
  if (await closedNow()) {
    const name = await tfetch(async () => siteName()).catch(() => "Store");
    return (
      <html lang="en" data-kit="pulse-1" className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full`}>
        <body className="flex min-h-full flex-col antialiased">
          <StoreClosed name={name} />
        </body>
      </html>
    );
  }

  // S43 (OP12): maintenance mode — shoppers get the BRANDED closed page;
  // holders of a VERIFIED console/platform session or _mx pass see the real
  // site so the team can work while the store is closed (lib/maintenance.js).
  // Checkout is closed for EVERYONE via checkoutCapability.
  const maintenance = await tfetch(() => storeCurtain()).catch(() => null);
  if (maintenance) {
    // P2-VGATE: brand and theme are awaited inside tfetch; any failure to read
    // them shows the neutral curtain.
    const [name, brand, theme] = await tfetch(async () => [siteName(), await resolvedBrand(), await resolvedTheme()]).catch(() => NEUTRAL_CURTAIN);
    const kit = kitAttr(theme);
    const brandCss = brandCssVars(brand ? resolveBrand(brand) : null, { kit });
    const palette = curtainPalette(brand);
    return (
      <html lang="en" data-kit={kit} className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full`}>
        {brandCss ? <style id="brand-vars" precedence="default" href="brand-vars">{brandCss}</style> : null}
        {/* Colours inline from curtainPalette: every text tone reaches 4.5:1 on
            the brand's background. data-curtain marks what the edge drill measures. */}
        <body
          data-curtain="page"
          className="flex min-h-full flex-col items-center justify-center px-6 text-center antialiased"
          style={{ backgroundColor: palette.background, color: palette.foreground }}
        >
          <p
            data-curtain="eyebrow"
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium"
            style={{ color: palette.muted, borderColor: palette.border }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: palette.accent }} /> Scheduled maintenance
          </p>
          <h1 data-curtain="title" className="mt-5 max-w-xl font-display text-4xl font-extrabold tracking-tight" style={{ color: palette.foreground }}>
            {name} will be right back.
          </h1>
          <p data-curtain="message" className="mt-4 max-w-md" style={{ color: palette.muted }}>
            {maintenance.message || "We're doing some quick work behind the scenes. Nothing is lost — your cart will be waiting."}
          </p>
          <a data-curtain="signin" href="/api/admin/maintenance-pass" className="mt-10 text-xs underline" style={{ color: palette.muted }}>
            Store team sign-in
          </a>
        </body>
      </html>
    );
  }

  // P2-PERF: the catalog's collections are only the Header's and Footer's
  // fallback when the store has no menu of its own (nav null). A store whose
  // header and footer menus are both set never shows them, so it doesn't read
  // them (about 6 KB on the perf fixture). The cost: a store without its own
  // menus starts this read once its chrome is known, not alongside it.
  const chromeRead = chromeData();
  const collectionsRead = chromeRead.then((c) => (Array.isArray(c.navHeader) && Array.isArray(c.navFooter) ? [] : navCollections()));
  const [collections, cart, chrome] = await Promise.all([collectionsRead, initialCart(), chromeRead]);
  const frame = chrome.frame;
  const editing = frame?.kind === "documents"; // preview-only data-doc / data-field
  const liveConsole = frame?.kind === "live" && (await consoleCookiePresent());
  return (
    <html lang="en" data-kit={chrome.kitAttr} className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full`}>
      {/* Brand variables: values come from lib/brand.js (validated hex/enum
          tokens only — nothing merchant-typed reaches this string raw). */}
      {/* precedence+href let React hoist this into <head> (without them React
          19 warns and risks a hydration mismatch for styles under <html>) */}
      {chrome.brandCss ? <style id="brand-vars" precedence="default" href="brand-vars">{chrome.brandCss}</style> : null}
      <body className="flex min-h-full flex-col bg-background text-foreground antialiased">
        {chrome.preview && (
          <div data-preview-bar="" className="bg-purple-700 px-4 py-1.5 text-center text-xs font-semibold text-white">
            <PreviewBanner overlay={chrome.previewOverlay} frame={editing ? { routes: frame.routes, offline: frame.offline } : null} />
          </div>
        )}
        {/* P3-FRAME (PV-01): a preview that ended says so, with a way out
            (the exit clears the stale cookie). */}
        {frame?.kind === "refused" && (
          <div data-preview-bar="" data-preview-ended="" className="bg-purple-700 px-4 py-1.5 text-center text-xs font-semibold text-white">
            Your preview has ended, so you&apos;re seeing the live store.{" "}
            <a href="/api/preview?exit=1" className="underline">
              Exit
            </a>
          </div>
        )}
        {/* S54: designer⇄preview bridge — preview mode ONLY, inert unless the
            console iframe performs the same-origin handshake. Public pages
            never ship it. P3-FRAME: also for a preview that ended, and for a
            console-signed-in browser on the live store (reason "live"), so
            the editor knows what its frame shows. Never for a shopper. */}
        {chrome.preview && editing && <PreviewBridgeMount state={frame.state} ok />}
        {frame?.kind === "refused" && <PreviewBridgeMount ok={false} reason={frame.reason} />}
        {liveConsole && <PreviewBridgeMount ok={false} reason="live" />}
        <CartProvider initialCart={cart}>
          <Header collections={collections} logo={chrome.logo} nav={chrome.navHeader} announcement={chrome.announcement} variant={chrome.headerVariant} editing={editing} />
          {editing ? <PreviewMain routes={frame.routes}>{children}</PreviewMain> : <main className="flex-1">{children}</main>}
          <Footer
            collections={collections}
            logo={chrome.logo}
            nav={chrome.navFooter}
            tagline={chrome.footerTagline}
            support={chrome.support}
            legalName={chrome.legalName}
            pages={chrome.footerPages}
            variant={chrome.footerVariant}
            editing={editing}
          />
          <CartDrawer />
        </CartProvider>
        <ServiceWorkerRegister />
        <ConsentBanner storeName={chrome.name} />
        <Pixels ga4Id={chrome.ga4Id} metaPixelId={chrome.metaPixelId} />
        <ErrorReporter />
        {liveConsole && <EditThisPage />}
      </body>
    </html>
  );
}
