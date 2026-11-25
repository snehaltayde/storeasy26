"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/kit/page-header";
import { sectionFor } from "@/lib/admin/settings-sections";

// The settings layout's title and content column (Phase 2 line 7). Team (line
// 8's page) brings its own title row with a "Settings / Team" breadcrumb, so
// there the layout draws no second "Settings" title, and its member table
// gets the full width beside the nav.
export function SettingsTitle() {
  if (sectionFor(usePathname())?.id === "team") return null;
  return <PageHeader title="Settings" description="How your store runs. Changes here go live within a minute, with no publish." />;
}

export function SettingsColumn({ children }) {
  const team = sectionFor(usePathname())?.id === "team";
  return <div className={team ? "min-w-0" : "min-w-0 max-w-3xl"}>{children}</div>;
}
