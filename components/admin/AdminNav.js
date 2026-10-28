"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const TABS = [
  { href: "/admin/offers", label: "Offers" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/storefront", label: "Storefront" },
  { href: "/admin/media", label: "Media" },
  { href: "/admin/theme", label: "Theme" },
  { href: "/admin/brand", label: "Brand" },
  { href: "/admin/releases", label: "Releases" },
  { href: "/admin/upsells", label: "Upsells" },
  { href: "/admin/integrations", label: "Integrations" },
  { href: "/admin/settings", label: "Settings" },
];

// Console chrome (Session 22): one nav across the merchant sections.
export default function AdminNav({ storeName }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <div className="mx-auto mb-2 flex max-w-4xl items-center gap-1 px-4 pt-8 sm:px-6">
      <span className="mr-3 text-sm font-bold">{storeName} admin</span>
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            pathname.startsWith(t.href) ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          {t.label}
        </Link>
      ))}
      <button onClick={logout} className="ml-auto text-sm text-zinc-400 hover:text-zinc-700">
        Sign out
      </button>
    </div>
  );
}
