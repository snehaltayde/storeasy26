"use client";

import { usePathname } from "next/navigation";
import { EditorShell } from "@/components/admin/cms/EditorShell";
import DesignerTabs from "@/components/admin/cms/DesignerTabs";
import { Skeleton, SkeletonText } from "@/components/console/bits";

// ED-01: while a designer page loads, show the editor's own shape (its top bar
// with the menu button, then tree, preview and inspector) instead of the
// console's page skeleton, so nothing jumps when the page arrives and the
// menu is in reach the whole time. The product and collection designers have
// no tree, so their skeleton has none either.
export default function DesignerLoading() {
  const home = usePathname() === "/admin/storefront/designer";
  return (
    <div aria-busy="true" aria-label="Loading">
      <EditorShell
        title="Designer"
        breadcrumb={[{ label: "Storefront", href: "/admin/storefront" }, { label: "Designer" }]}
        tabs={<DesignerTabs />}
        tree={
          home ? (
            <div className="p-3">
              <SkeletonText lines={5} />
            </div>
          ) : null
        }
        preview={
          <div className="h-[75dvh] p-2 lg:h-auto lg:flex-1">
            <Skeleton className="h-full w-full rounded-card" />
          </div>
        }
        inspector={
          <div className="p-4">
            <SkeletonText lines={6} />
          </div>
        }
      />
    </div>
  );
}
