import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import "./globals.css";
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
import { resolvedAnnouncement, resolvedNav, resolvedBrand, resolvedTheme, contentSource } from "@/lib/content/resolve";
import { kitAttr } from "@/lib/themes/kits";
import { tfetch, requestResolution } from "@/lib/tenant-request";
import { isGated } from "@/lib/tenant-gate";

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
  if (isGated(await requestResolution())) {
    return { title: "Store", robots: { index: false } };
  }
  const [name, title, tagline, url] = await tfetch(async () => [siteName(), siteTitle(), siteTagline(), siteUrl()]);
  return {
    metadataBase: new URL(url),
    title: { default: title, template: `%s · ${name}` },
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
      const [announcement, navHeader, navFooter, brand, theme, src] = await Promise.all([
        resolvedAnnouncement(),
        resolvedNav("header"),
        resolvedNav("footer"),
        resolvedBrand(),
        resolvedTheme(),
        contentSource(),
      ]);
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
  const [collections, cart, chrome] = await Promise.all([navCollections(), initialCart(), chromeData()]);
  return (
    <html lang="en" data-kit={chrome.kitAttr} className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full`}>
      {/* Brand variables: values come from lib/brand.js (validated hex/enum
          tokens only — nothing merchant-typed reaches this string raw). */}
      {chrome.brandCss ? <style id="brand-vars">{chrome.brandCss}</style> : null}
      <body className="flex min-h-full flex-col bg-background text-foreground antialiased">
        {chrome.preview && (
          <div className="bg-purple-700 px-4 py-1.5 text-center text-xs font-semibold text-white">
            Draft preview — this is NOT what shoppers see.{" "}
            <a href="/api/preview?exit=1" className="underline">
              Exit preview
            </a>
          </div>
        )}
        <CartProvider initialCart={cart}>
          <Header collections={collections} logo={chrome.logo} nav={chrome.navHeader} announcement={chrome.announcement} />
          <main className="flex-1">{children}</main>
          <Footer
            collections={collections}
            logo={chrome.logo}
            nav={chrome.navFooter}
            tagline={chrome.footerTagline}
            support={chrome.support}
            legalName={chrome.legalName}
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
