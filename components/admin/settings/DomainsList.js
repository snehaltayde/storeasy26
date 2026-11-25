"use client";

import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { ReadState, useRead } from "@/components/admin/settings/SaveBar";

// Settings → Domains and SEO (Phase 2 line 7): this store's domains from
// GET /api/admin/domains, each with its status and primary flag and, until
// it is verified, the TXT record to add (with Copy). Verify is
// POST { action: "verify", host } (settings.write, audited). Claiming a
// domain stays with Storeasy's team (it changes routing for every store), and
// the screen says so.
export function DomainsList({ role }) {
  const toast = useToast();
  const read = useRead("/api/admin/domains");
  const [verifying, setVerifying] = useState(null);
  const [note, setNote] = useState(null); // { ok, words }

  async function verify(host) {
    setVerifying(host);
    setNote(null);
    try {
      const res = await fetch("/api/admin/domains", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", host }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        read.setData((d) => ({ ...d, domains: data.domains }));
        if (data.result?.verified) toast.success(`${host} is verified.`);
        else setNote({ ok: false, words: `We couldn't find the TXT record for ${host} yet. DNS changes can take up to an hour; try again later.` });
      } else setNote({ ok: false, words: data.error || "That didn't work. Try again." });
    } catch {
      setNote({ ok: false, words: "That didn't go through. Check your connection and try again." });
    }
    setVerifying(null);
  }

  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("TXT value copied");
    } catch {
      toast.error("Couldn't copy. Select the text instead.");
    }
  }

  return (
    <div className="space-y-4" data-settings-tab="domains">
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Domains</CardTitle>
          <CardDescription>
            Your storefront answers on these addresses. To add a domain, ask Storeasy's team: they add it, then you add the TXT record at your domain provider and verify it here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {note && (
            <Alert variant="warning">
              <AlertDescription className="text-current">{note.words}</AlertDescription>
            </Alert>
          )}
          <ReadState read={read}>
            {(d) =>
              !d.supported ? (
                <p className="text-sm text-muted-foreground">Custom domains need Storeasy's platform; this store runs without it.</p>
              ) : d.domains.length === 0 ? (
                <EmptyState title="No custom domain yet" description="Ask Storeasy's team for the address you want, like shop.yourbrand.in. It shows here once they add it." />
              ) : (
                <ul className="space-y-3">
                  {d.domains.map((dom) => (
                    <li key={dom.host} className="rounded-card border border-border p-3" data-domain={dom.host}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 truncate font-mono text-sm font-medium" title={dom.host}>
                          {dom.host}
                        </span>
                        <Badge variant={dom.verified ? "success" : "warning"}>{dom.verified ? "Verified" : "Waiting for the TXT record"}</Badge>
                        {dom.primary && <Badge variant="muted">Primary</Badge>}
                        {!dom.verified && (
                          <span className="ml-auto">
                            <RoleGate role={role} action="settings.write" reason="Only the owner or an admin can verify a domain.">
                              <Button type="button" size="sm" disabled={verifying === dom.host} onClick={() => verify(dom.host)}>
                                {verifying === dom.host ? "Checking…" : "Verify"}
                              </Button>
                            </RoleGate>
                          </span>
                        )}
                      </div>
                      {dom.challenge && (
                        <div className="mt-3 rounded-md border border-dashed border-border bg-muted p-3 text-[0.8125rem]">
                          <p className="text-foreground">Add this TXT record at your domain provider, then press Verify.</p>
                          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
                            <dt className="text-muted-foreground">Type</dt>
                            <dd className="font-mono">TXT</dd>
                            <dt className="text-muted-foreground">Name</dt>
                            <dd className="font-mono break-all">{dom.challenge.record}</dd>
                            <dt className="text-muted-foreground">Value</dt>
                            <dd className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-card py-0.5 pr-0.5 pl-2">
                              <span className="min-w-0 flex-1 font-mono break-all">{dom.challenge.value}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Copy the TXT value for ${dom.host}`}
                                onClick={() => copy(dom.challenge.value)}
                                data-read-control
                              >
                                <Copy aria-hidden />
                              </Button>
                            </dd>
                          </dl>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )
            }
          </ReadState>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Search engines</CardTitle>
          <CardDescription>
            Your sitemap and robots file follow what you publish, on your primary domain. Campaign pages are never listed. Page titles and descriptions are set per page in the
            editor; the default ones are in Details.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
