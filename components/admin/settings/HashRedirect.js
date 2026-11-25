"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { hashTarget, SETTINGS_HOME } from "@/lib/admin/settings-sections";

// Old links (Phase 2 line 7): settings used to be one page with anchors
// (/admin/settings#payments). A hash only reaches the browser, so the move to
// the tab that now holds that part happens here, keeping the query
// (?from=onboarding). Only on /admin/settings itself.
export function HashRedirect() {
  const router = useRouter();
  useEffect(() => {
    if (window.location.pathname.replace(/\/+$/, "") !== SETTINGS_HOME) return;
    const to = hashTarget(window.location.hash);
    if (to && to !== SETTINGS_HOME) router.replace(`${to}${window.location.search}`);
    else if (to) window.history.replaceState(null, "", `${SETTINGS_HOME}${window.location.search}`);
  }, [router]);
  return null;
}
