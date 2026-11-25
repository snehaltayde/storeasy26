"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/kit/role-gate";
import { EmptyState } from "@/components/kit/empty-state";
import { InstallDialog } from "@/components/admin/apps/InstallDialog";
import { PluginIcon } from "@/components/admin/apps/plugin-icon";
import { KILLED, NO_MANAGE } from "@/components/admin/apps/app-words";

// The Browse tab: one card per catalog app. Installed → "Open" (a link, a
// read); turned off by Storeasy → "Not available right now", no Install;
// otherwise Install (admin and owner; RoleGate shows it disabled for others).
export function AppCatalog({ catalog, role }) {
  const [installing, setInstalling] = useState(null);
  if (!catalog.length) return <EmptyState title="There are no apps to install yet" description="Storeasy adds apps here as they are ready." />;
  return (
    <>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-apps="catalog">
        {catalog.map((app) => (
          <li key={app.id} data-app-card={app.id}>
            <Card className="h-full">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                    <PluginIcon name={app.icon} className="size-5 text-foreground" />
                  </span>
                  <div className="min-w-0">
                    <CardTitle>{app.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">{`By ${app.author}`}</p>
                  </div>
                </div>
                <CardDescription>{app.summary}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1" />
              <CardFooter className="flex items-center justify-between gap-2">
                {app.installId ? (
                  <>
                    <Badge variant="muted">Installed</Badge>
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/admin/apps/${encodeURIComponent(app.installId)}`} data-read-control data-app-open={app.id}>
                        Open
                      </Link>
                    </Button>
                  </>
                ) : !app.available ? (
                  <p className="text-sm text-muted-foreground" data-app-unavailable={app.id}>
                    {`Not available right now (${KILLED})`}
                  </p>
                ) : (
                  <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
                    <Button type="button" size="sm" data-app-install={app.id} onClick={() => setInstalling(app)}>
                      Install
                    </Button>
                  </RoleGate>
                )}
              </CardFooter>
            </Card>
          </li>
        ))}
      </ul>
      <InstallDialog app={installing} open={Boolean(installing)} onOpenChange={(v) => !v && setInstalling(null)} />
    </>
  );
}
