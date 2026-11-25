"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/kit/empty-state";
import { ReadState, useRead } from "@/components/admin/settings/SaveBar";

// Settings → Privacy (Phase 2 line 7): read-only. The consent banner's
// version and purposes, how long data is kept, shoppers' privacy requests and
// how many orders have been redacted, from GET /api/admin/privacy. Requests
// are carried out by Shopify's privacy webhooks or Storeasy's team.
const REQUEST_WORDS = { done: "Done", manual: "Needs Storeasy's team", received: "Received" };
const when = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");

export function PrivacyPanel() {
  const read = useRead("/api/admin/privacy");
  return (
    <div className="space-y-4" data-settings-tab="privacy">
      <ReadState read={read} lines={5}>
        {(d) => (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-semibold">Cookie consent</CardTitle>
                <CardDescription>{d.consent.note}</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-3 text-sm sm:grid-cols-[160px_1fr]">
                  <dt className="font-medium">Banner version</dt>
                  <dd className="font-mono">v{d.consent.version}</dd>
                  {d.consent.purposes.map((p) => (
                    <div key={p.id} className="contents">
                      <dt className="font-medium">{p.label}</dt>
                      <dd className="text-muted-foreground">{p.basis}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-semibold">How long data is kept</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-3 text-sm sm:grid-cols-[160px_1fr]">
                  {Object.entries(d.retention).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="font-medium capitalize">{k}</dt>
                      <dd className="text-muted-foreground">{v}</dd>
                    </div>
                  ))}
                  <dt className="font-medium">Redacted orders</dt>
                  <dd className="font-mono">{d.redacted_orders}</dd>
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-semibold">Privacy requests</CardTitle>
                <CardDescription>Shoppers' requests to see or delete their data. Shopify sends them; each is tracked here.</CardDescription>
              </CardHeader>
              <CardContent>
                {d.requests.length === 0 ? (
                  <EmptyState title="No privacy requests yet" />
                ) : (
                  <ul className="divide-y divide-border">
                    {d.requests.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                        <Badge variant={r.status === "done" ? "success" : r.status === "manual" ? "warning" : "muted"}>{REQUEST_WORDS[r.status] || r.status}</Badge>
                        <span>{String(r.kind).replace(/_/g, " ")}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{when(r.created_at)}</span>
                        {r.notes && <span className="w-full text-xs text-muted-foreground">{r.notes}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </ReadState>
    </div>
  );
}
