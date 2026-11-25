"use client";

import { useState } from "react";
import { Puzzle } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { AppCatalog } from "@/components/admin/apps/AppCatalog";
import { installState, shortDate } from "@/components/admin/apps/app-words";

// /admin/apps (Phase 4 line 1): the Installed tab (each live install: name,
// On / Off / Turned off by Storeasy, who installed it and when) and the Browse
// tab (the catalog). The tabs and the row links are reads (data-read-control).
//   installs, catalog: GET /api/admin/apps; role: the actor's role
export function AppsList({ installs, catalog, role }) {
  const [tab, setTab] = useState(installs.length ? "installed" : "browse");
  const columns = [
    { key: "name", header: "App" },
    {
      key: "status",
      header: "Status",
      cell: (r) => {
        const [label, tone] = installState(r);
        return (
          <Badge variant={tone} data-app-status={r.killed ? "killed" : r.status}>
            {label}
          </Badge>
        );
      },
    },
    { key: "installedByName", header: "Installed by" },
    { key: "installedAt", header: "Installed", cell: (r) => shortDate(r.installedAt) },
  ];
  return (
    <Tabs value={tab} onValueChange={setTab} data-apps="tabs">
      <TabsList aria-label="Apps" data-read-control>
        <TabsTrigger value="installed" data-read-control data-apps-tab="installed">
          {`Installed (${installs.length})`}
        </TabsTrigger>
        <TabsTrigger value="browse" data-read-control data-apps-tab="browse">
          Browse
        </TabsTrigger>
      </TabsList>
      <TabsContent value="installed" tabIndex={-1} className="mt-4">
        <DataTable
          label="Installed apps"
          columns={columns}
          rows={installs}
          rowHref={(r) => `/admin/apps/${encodeURIComponent(r.id)}`}
          empty={
            <EmptyState
              icon={Puzzle}
              title="No apps installed yet"
              description="Apps add things to your store, like trust badges. Nothing changes on your store until you install one and turn it on."
              action={
                <Button type="button" variant="outline" data-read-control onClick={() => setTab("browse")}>
                  Browse apps
                </Button>
              }
            />
          }
        />
      </TabsContent>
      <TabsContent value="browse" tabIndex={-1} className="mt-4">
        <AppCatalog catalog={catalog} role={role} />
      </TabsContent>
    </Tabs>
  );
}
