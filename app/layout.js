import { Geist, Geist_Mono } from "next/font/google";
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
import { getAnnouncement, getNav } from "@/lib/cms/store";
import { tfetch } from "@/lib/tenant-request";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Render pages on the edge runtime — the libSQL client resolves to its
// fetch-based `edge-light` build, and search uses edge-safe fetch.
export const runtime = "edge";

// Session 23: metadata resolves per tenant (was a hardcoded BeastLife export).
export async function generateMetadata() {
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
      const [announcement, navHeader, navFooter] = await Promise.all([getAnnouncement(), getNav("header"), getNav("footer")]);
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
  const [collections, cart, chrome] = await Promise.all([navCollections(), initialCart(), chromeData()]);
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="flex min-h-full flex-col bg-white text-zinc-900 antialiased">
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
