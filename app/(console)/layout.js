import { Geist, Geist_Mono } from "next/font/google";
import { ToastProvider } from "@/components/console/Toast";
import "../globals.css";

// Console root layout (S50). The second root layout: /admin, /platform,
// /partners and /approve render HERE — no storefront Header/Footer/cart,
// no consent banner, no analytics pixels, no service worker, and no tenant
// brand variables (the [data-console] token scope is structurally isolated
// from brandCssVars). Edge runtime is EXPLICIT: admin pages inherited edge
// from the old root layout and must keep it (libsql edge build).
export const runtime = "edge";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata = {
  title: { default: "Console · Storeasy", template: "%s" },
  robots: { index: false, follow: false },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function ConsoleRootLayout({ children }) {
  return (
    <html lang="en" data-console className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full bg-surface-muted font-sans text-fg antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
