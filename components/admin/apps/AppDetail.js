"use client";

import { useState } from "react";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AppSettingsForm } from "@/components/admin/apps/AppSettingsForm";
import { AppDangerZone } from "@/components/admin/apps/AppDangerZone";
import { AppActivity } from "@/components/admin/apps/AppActivity";
import { WebhooksCard } from "@/components/admin/apps/WebhooksCard";
import { ApiAccessCard } from "@/components/admin/apps/ApiAccessCard";
import { PluginIcon } from "@/components/admin/apps/plugin-icon";
import PlacementsCard from "@/components/admin/apps/PlacementsCard";
import { WhatsAppCard } from "@/components/admin/apps/WhatsAppCard";
import { KILLED, KILLED_BODY, SEES_NOTHING, installState, shortDate } from "@/components/admin/apps/app-words";

// /admin/apps/[id] (Phase 4 line 1): Overview (what it does, what it can see,
// version, who installed it and when), Settings, Activity (audit.read holders
// only: activity is null for others and the section is not drawn), and the
// Danger zone. Lines 2–4 add their sections at the anchors below.
//   install, plugin, activity: GET /api/admin/apps/[id]; role: the actor's role
export function AppDetail({ install: initial, plugin, activity, role }) {
  const [install, setInstall] = useState(initial);
  const [label, tone] = installState(install);
  return (
    <div className="space-y-6" data-apps="detail" data-install={install.id}>
      {install.killed && (
        <Alert variant="warning" data-apps="killed">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{KILLED}</AlertTitle>
          <AlertDescription>{KILLED_BODY}</AlertDescription>
        </Alert>
      )}
      <Card data-apps="overview">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <PluginIcon name={plugin?.icon} className="size-5 text-foreground" />
            </span>
            <CardTitle className="min-w-0">{install.name}</CardTitle>
            <Badge variant={tone} data-app-status={install.killed ? "killed" : install.status}>
              {label}
            </Badge>
          </div>
          {plugin?.description && <CardDescription>{plugin.description}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4">
          <section aria-labelledby="app-scopes" className="space-y-2">
            <h3 id="app-scopes" className="text-sm font-medium text-foreground">
              What it can see
            </h3>
            {install.grantedScopes.length ? (
              <ul className="space-y-1 text-sm">
                {(plugin?.scopes ?? install.grantedScopes.map((s) => ({ scope: s, words: s }))).map((s) => (
                  <li key={s.scope} className="flex gap-2" data-scope={s.scope}>
                    <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    {s.words}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{SEES_NOTHING}</p>
            )}
          </section>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Version</dt>
              <dd>{install.version}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Installed by</dt>
              <dd>{install.installedByName}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Installed</dt>
              <dd>{shortDate(install.installedAt)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      {plugin ? (
        <AppSettingsForm install={install} settings={plugin.settings} role={role} onSaved={setInstall} />
      ) : (
        <p className="text-sm text-muted-foreground">This app is no longer offered, so its settings can't be changed. You can still turn it off or uninstall it.</p>
      )}
      {/* line 2: placements */}
      <PlacementsCard installId={install.id} role={role} installOff={install.status !== "enabled"} />
      {/* line 3: webhooks */}
      <WebhooksCard install={install} role={role} />
      {/* line 4: api access */}
      {install.kind === "custom" && <ApiAccessCard install={install} role={role} />}
      {/* p9: whatsapp */}
      {install.pluginId === "whatsapp" && install.status !== "uninstalled" && <WhatsAppCard install={install} role={role} />}
      {activity && <AppActivity rows={activity} />}
      <AppDangerZone install={install} role={role} onChanged={setInstall} />
    </div>
  );
}
