"use client";

// Phase 3 line 6: /platform/operations. One tab per old panel; the open tab is
// in the URL (?tab=), so a link opens the same tab. Each tab loads its own data
// when it is opened.
import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/kit/page-header";
import Queues from "./Queues";
import ProvisionRuns from "./ProvisionRuns";
import Privacy from "./Privacy";
import Themes from "./Themes";
import CaseStudies from "./CaseStudies";

export const OPERATIONS_TABS = Object.freeze([
  { id: "queues", label: "Queues", Panel: Queues },
  { id: "provisioning", label: "Provisioning runs", Panel: ProvisionRuns },
  { id: "privacy", label: "Privacy requests", Panel: Privacy },
  { id: "themes", label: "Themes", Panel: Themes },
  { id: "case-studies", label: "Case studies", Panel: CaseStudies },
]);

export default function OperationsTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab = OPERATIONS_TABS.some((t) => t.id === sp.get("tab")) ? sp.get("tab") : "queues";
  const strip = useRef(null);

  // On a narrow screen the tab strip scrolls sideways: keep the open tab in view
  // (a link to ?tab=case-studies would otherwise open with its tab cut off).
  useEffect(() => {
    strip.current?.querySelector('[data-state="active"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <PageHeader title="Operations" description="Job queues, provisioning runs, privacy requests, themes and case studies across every store." />
      <Tabs
        value={tab}
        onValueChange={(v) => router.replace(`${pathname}${v === "queues" ? "" : `?tab=${v}`}`, { scroll: false })}
      >
        <div ref={strip} className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <TabsList variant="line" aria-label="Operations">
            {OPERATIONS_TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} data-read-control>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {OPERATIONS_TABS.map(({ id, Panel }) => (
          <TabsContent key={id} value={id} className="mt-4">
            {tab === id && <Panel />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
