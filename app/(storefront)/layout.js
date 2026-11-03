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
import { getCart, emptyCart, CART_COOKIE } from "@/lib/cart";
import { siteUrl, siteName, siteTitle, siteTagline, siteFooterTagline, siteLogo, siteSupport, siteLegalName } from "@/lib/site";
import { tenantOwnCfg } from "@/lib/tenant-context";
import { resolveBrand, brandCssVars } from "@/lib/brand";
import { resolvedAnnouncement, resolvedNav, resolvedBrand, resolvedTheme, resolvedContentPageList, resolvedSurfaceTemplates, contentSource } from "@/lib/content/resolve";
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
      const [announcement, navHeader, navFooter, brand, theme, src, pageList, surfaces] = await Promise.all([
        resolvedAnnouncement(),
        resolvedNav("header"),
        resolvedNav("footer"),
        resolvedBrand(),
        resolvedTheme(),
        contentSource(),
        resolvedContentPageList().catch(() => []),
        resolvedSurfaceTemplates(), // S61: header/footer structural variants (release-governed)
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
        logo: siteLogo(),
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
        brandCss: brand ? brandCssVars(resolveBrand(brand)) : "",
        kitAttr: kitAttr(theme),
        preview: src.preview,
        footerPages,
        headerVariant: surfaces.header || "standard",
        footerVariant: surfaces.footer || "columns",
      };
    });
  } catch {
    return {
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
      footerPages: { about: false, policies: [] },
      headerVariant: "standard",
      footerVariant: "columns",
    };
  }
}

async function initialCart() {
  try {
    const id = (await cookies()).get(CART_COOKIE)?.value;
    return id ? await tfetch(() => getCart(id)) : emptyCart();
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

  // S43 (OP12): maintenance mode — shoppers get the BRANDED closed page;
  // holders of a VERIFIED console/platform session or _mx pass see the real
  // site so the team can work while the store is closed (lib/maintenance.js).
  // Checkout is closed for EVERYONE via checkoutCapability.
  const maintenance = await tfetch(() => storeCurtain()).catch(() => null);
  if (maintenance) {
    const [name, brand, theme] = await tfetch(async () => [siteName(), await resolvedBrand(), await resolvedTheme()]).catch(() => ["Store", null, null]);
    const brandCss = brand ? brandCssVars(resolveBrand(brand)) : "";
    const palette = curtainPalette(brand);
    return (
      <html lang="en" data-kit={kitAttr(theme)} className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full`}>
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

  const [collections, cart, chrome] = await Promise.all([navCollections(), initialCart(), chromeData()]);
  return (
    <html lang="en" data-kit={chrome.kitAttr} className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full`}>
      {/* Brand variables: values come from lib/brand.js (validated hex/enum
          tokens only — nothing merchant-typed reaches this string raw). */}
      {/* precedence+href let React hoist this into <head> (without them React
          19 warns and risks a hydration mismatch for styles under <html>) */}
      {chrome.brandCss ? <style id="brand-vars" precedence="default" href="brand-vars">{chrome.brandCss}</style> : null}
      <body className="flex min-h-full flex-col bg-background text-foreground antialiased">
        {chrome.preview && (
          <div className="bg-purple-700 px-4 py-1.5 text-center text-xs font-semibold text-white">
            Draft preview — this is NOT what shoppers see.{" "}
            <a href="/api/preview?exit=1" className="underline">
              Exit preview
            </a>
          </div>
        )}
        {/* S54: designer⇄preview bridge — preview mode ONLY, inert unless the
            console iframe performs the same-origin handshake. Public pages
            never ship it. */}
        {chrome.preview && <PreviewBridgeMount />}
        <CartProvider initialCart={cart}>
          <Header collections={collections} logo={chrome.logo} nav={chrome.navHeader} announcement={chrome.announcement} variant={chrome.headerVariant} />
          <main className="flex-1">{children}</main>
          <Footer
            collections={collections}
            logo={chrome.logo}
            nav={chrome.navFooter}
            tagline={chrome.footerTagline}
            support={chrome.support}
            legalName={chrome.legalName}
            pages={chrome.footerPages}
            variant={chrome.footerVariant}
          />
          <CartDrawer />
        </CartProvider>
        <ServiceWorkerRegister />
        <ConsentBanner storeName={chrome.name} />
        <Pixels ga4Id={chrome.ga4Id} metaPixelId={chrome.metaPixelId} />
        <ErrorReporter />
      </body>
    </html>
  );
}
