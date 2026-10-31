"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/console/cx";

// S59: the Designer edits more than the home page now — one surface strip
// shared by all designer routes.
const TABS = [
  { href: "/admin/storefront/designer", label: "Home page" },
  { href: "/admin/storefront/designer/product", label: "Product page" },
  { href: "/admin/storefront/designer/collection", label: "Collection page" },
];

export default function DesignerTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Designer surfaces" className="mb-4 flex gap-1 rounded-ctl border border-edge bg-surface-sunken p-1 w-fit">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "rounded-md px-3 py-1.5 text-xs font-semibold focus-ring",
              active ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
