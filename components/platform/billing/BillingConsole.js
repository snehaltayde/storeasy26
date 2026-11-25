"use client";

// Phase 3 line 3: the operator's Billing screen. The tab and each tab's
// filters live in the URL (?tab=&store=&status=&plan=&q=&type=&month=&offset=),
// so a link opens the same view; the exception queue links to
// ?tab=subscriptions&store=<id>. Each tab loads its own data.
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/kit/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TABS, TAB_IDS } from "./billingWords";
import Overview from "./Overview";
import Subscriptions from "./Subscriptions";
import Plans from "./Plans";
import Events from "./Events";
import Overrides from "./Overrides";
import Costs from "./Costs";

const PANELS = { overview: Overview, subscriptions: Subscriptions, plans: Plans, events: Events, overrides: Overrides, costs: Costs };

export default function BillingConsole() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab = TAB_IDS.includes(sp.get("tab")) ? sp.get("tab") : "overview";

  // patch the query; null or "" removes a key. A new tab starts with no filters.
  const setParams = useCallback(
    (patch, { fresh = false } = {}) => {
      const next = new URLSearchParams(fresh ? "" : sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, String(v));
      }
      if (next.get("tab") === "overview") next.delete("tab");
      router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
    },
    [sp, router, pathname],
  );
  const params = Object.fromEntries(sp.entries());
  const Panel = PANELS[tab];

  return (
    <TooltipProvider>
      <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
        <PageHeader title="Billing" description="What each store pays Storeasy: plans, subscriptions, the payment ledger, overrides and what each store costs to run." />
        <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { fresh: true })}>
          <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
            <TabsList aria-label="Billing sections">
              {TABS.map(([id, label]) => (
                <TabsTrigger key={id} value={id} data-read-control className="px-3 pointer-coarse:h-10">
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value={tab} className="mt-4">
            <Panel params={params} setParams={setParams} />
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}
