import { Geist, GeistMono } from "@/app/fonts/fonts";
import { ToastProvider } from "@/components/kit/toast";
import "../globals.css";

// Console root layout (S50). The second root layout: /admin and /platform
// render HERE — no storefront Header/Footer/cart,
// no consent banner, no analytics pixels, no service worker, and no tenant
// brand variables (the [data-console] token scope is structurally isolated
// from brandCssVars). Runtime is NODE, deliberately: every /api/admin
// and /api/platform route already runs on Node, console
// pages gain nothing from edge, and Node's libsql build also supports the
// file: DBs the local design-preview harness uses. (The storefront stays
// edge, unchanged.)
export const runtime = "nodejs";

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
    <html lang="en" data-console className={`${Geist.variable} ${GeistMono.variable} h-full`}>
      <body className="console min-h-full bg-surface-muted font-sans text-fg antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
