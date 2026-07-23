import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { CartProvider } from "@/components/cart/CartContext";
import CartDrawer from "@/components/cart/CartDrawer";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import ConsentBanner from "@/components/analytics/ConsentBanner";
import Pixels from "@/components/analytics/Pixels";
import { cookies } from "next/headers";
import { getAllCollections } from "@/lib/repo";
import { getCart, emptyCart, CART_COOKIE } from "@/lib/cart";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Render pages on the edge runtime — the libSQL client resolves to its
// fetch-based `edge-light` build, and search uses edge-safe fetch.
export const runtime = "edge";

export const metadata = {
  title: {
    default: "BeastLife — Sports Nutrition, delivered fast",
    template: "%s · BeastLife",
  },
  description:
    "Browse BeastLife's catalog — protein, creatine, pre-workout and more. Fast storefront over the live Shopify catalog.",
  manifest: "/manifest.webmanifest",
  applicationName: "BeastLife",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "BeastLife" },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/icon-192.png" }],
  },
};

export const viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
};

async function navCollections() {
  try {
    return await getAllCollections();
  } catch {
    return [];
  }
}

async function initialCart() {
  try {
    const id = (await cookies()).get(CART_COOKIE)?.value;
    return id ? await getCart(id) : emptyCart();
  } catch {
    return emptyCart();
  }
}

export default async function RootLayout({ children }) {
  const [collections, cart] = await Promise.all([navCollections(), initialCart()]);
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="flex min-h-full flex-col bg-white text-zinc-900 antialiased">
        <CartProvider initialCart={cart}>
          <Header collections={collections} />
          <main className="flex-1">{children}</main>
          <Footer collections={collections} />
          <CartDrawer />
        </CartProvider>
        <ServiceWorkerRegister />
        <ConsentBanner />
        <Pixels />
      </body>
    </html>
  );
}
