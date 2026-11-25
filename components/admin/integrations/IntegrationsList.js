"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/console/Toast";
import { ConfirmAction, sendJson } from "@/components/admin/offers/ConfirmAction";

// Integrations (Phase 2 line 7): each provider's connection from
// integrationStatus() (presence flags and metadata, never a secret value),
// Test (POST /api/admin/integrations { action: "test" }: a read, settings.read,
// it stores nothing) and Disconnect (action "revoke", settings.write, asks
// first, audited). Below: contact-form messages whose email to the store
// didn't send, the contact inbox and the outgoing email log.
//   initial: integrationStatus(); messages, notifications: the latest 20 of each
const NAMES = { shopify: "Shopify", razorpay: "Razorpay", ga4: "Google Analytics 4", meta: "Meta", typesense: "Search", mail: "Email" };
const WHAT = {
  shopify: "Your products, prices and stock come from here; orders go back to it.",
  razorpay: "Card and UPI payments at checkout.",
  ga4: "Visits and sales in Google Analytics, for shoppers who agree.",
  meta: "Pixel and Conversions API events, for shoppers who agree.",
  typesense: "Fast product search. If it's down, search still works, more slowly.",
  mail: "Invites, sign-in links and the store's own emails.",
};
const WHERE = {
  shopify: "Connect it in onboarding step 1.",
  razorpay: "Add your keys in Settings → Checkout and payments.",
  ga4: "Add it in Settings → Tracking.",
  meta: "Add it in Settings → Tracking.",
};
const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null);

function facts(r) {
  const out = [];
  if (r.store_domain) out.push(["Store", r.store_domain]);
  if (r.mode) out.push(["Mode", r.mode === "live" ? "Live payments" : "Test payments"]);
  if (r.webhook !== undefined) out.push(["Webhook secret", r.webhook ? "Saved" : "Not set"]);
  if (when(r.last_event_at)) out.push(["Last update from Shopify", when(r.last_event_at)]);
  if (when(r.last_forward_at)) out.push(["Last event sent", when(r.last_forward_at)]);
  if (r.reauth_needed_at) out.push(["Needs reconnecting since", when(r.reauth_needed_at)]);
  return out;
}

export function IntegrationsList({ initial, messages = [], notifications = [], role }) {
  const toast = useToast();
  const [rows, setRows] = useState(initial);
  const [testing, setTesting] = useState(null);
  const [results, setResults] = useState({}); // provider -> { ok, words }
  const [revoking, setRevoking] = useState(null);

  async function test(provider) {
    setTesting(provider);
    try {
      const data = await sendJson("/api/admin/integrations", "POST", { action: "test", provider });
      setResults((m) => ({ ...m, [provider]: { ok: Boolean(data.ok), words: data.ok ? `Working: ${data.detail}.` : `Not working: ${data.detail || "no answer"}.` } }));
    } catch (e) {
      setResults((m) => ({ ...m, [provider]: { ok: false, words: e.message } }));
    }
    setTesting(null);
  }
  async function revoke(provider) {
    const data = await sendJson("/api/admin/integrations", "POST", { action: "revoke", provider });
    if (data.integrations) setRows(data.integrations);
    setResults((m) => ({ ...m, [provider]: undefined }));
    toast.success(`${NAMES[provider] || provider} is disconnected.`);
  }

  const failed = messages.filter((m) => m.notify_status === "failed");
  return (
    <div className="space-y-6" data-integrations="list">
      <ul className="grid gap-4 md:grid-cols-2">
        {rows.map((r) => {
          const res = results[r.provider];
          return (
            <li key={r.provider}>
              <Card className="h-full" data-provider={r.provider}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
                    {NAMES[r.provider] || r.provider}
                    <Badge variant={!r.connected ? "muted" : res?.ok === false ? "danger" : "success"}>
                      {!r.connected ? "Not connected" : res?.ok === false ? "Not working" : "Connected"}
                    </Badge>
                    {r.uninstalled_at && <Badge variant="danger">App removed from Shopify</Badge>}
                    {r.mock && <Badge variant="warning">Not sending: no mail provider</Badge>}
                    {r.platform_level && <Badge variant="muted">Run by Storeasy</Badge>}
                  </CardTitle>
                  <CardDescription>{WHAT[r.provider] || r.kind}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {facts(r).length > 0 && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.8125rem]">
                      {facts(r).map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-muted-foreground">{k}</dt>
                          <dd className="truncate font-mono" title={v}>
                            {v}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {!r.connected && WHERE[r.provider] && <p className="text-[0.8125rem] text-muted-foreground">{WHERE[r.provider]}</p>}
                  {res && (
                    <Alert variant={res.ok ? "success" : "warning"}>
                      <AlertDescription className="text-current">{res.words}</AlertDescription>
                    </Alert>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {r.actions?.includes("test") && (
                      <Button type="button" variant="outline" size="sm" disabled={Boolean(testing)} onClick={() => test(r.provider)} data-read-control>
                        {testing === r.provider ? "Testing…" : "Test"}
                      </Button>
                    )}
                    {r.actions?.includes("revoke") && r.connected && (
                      <RoleGate role={role} action="settings.write" reason="Only the owner or an admin can disconnect an integration.">
                        <Button type="button" variant="destructive" size="sm" onClick={() => setRevoking(r.provider)}>
                          Disconnect
                        </Button>
                      </RoleGate>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>

      <Card data-integrations="failed-mail">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Contact messages that didn't reach you</CardTitle>
          <CardDescription>A shopper wrote through your contact form, but the email to your support address didn't send. Reply to them directly.</CardDescription>
        </CardHeader>
        <CardContent>
          {failed.length === 0 ? (
            <p className="text-sm text-muted-foreground">None. Every recent message was emailed to you.</p>
          ) : (
            <ul className="divide-y divide-border">
              {failed.map((m) => (
                <li key={m.id} className="space-y-1 py-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{m.name}</span>
                    <span className="text-muted-foreground">{m.email}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{when(m.created_at)}</span>
                  </p>
                  <p className="whitespace-pre-line text-muted-foreground">{m.message}</p>
                  {m.notify_error && <p className="text-xs text-destructive">Why it didn't send: {m.notify_error}</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Contact inbox</CardTitle>
          <CardDescription>The latest messages from your storefront's contact form. Each is also emailed to your support address.</CardDescription>
        </CardHeader>
        <CardContent>
          {messages.length === 0 ? (
            <EmptyState title="No messages yet" description="Messages from your contact form show here." />
          ) : (
            <ul className="divide-y divide-border">
              {messages.map((m) => (
                <li key={m.id} className="space-y-1 py-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{m.name}</span>
                    <span className="text-muted-foreground">{m.email}</span>
                    <Badge variant={m.notify_status === "failed" ? "warning" : m.notify_status === "sent" ? "success" : "muted"}>
                      {m.notify_status === "failed" ? "Email didn't send" : m.notify_status === "sent" ? "Emailed to you" : "Saved"}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{when(m.created_at)}</span>
                  </p>
                  <p className="whitespace-pre-line text-muted-foreground">{m.message}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Emails sent by your store</CardTitle>
          <CardDescription>Every email your store queued, and whether it went. Failed ones are tried again a few times.</CardDescription>
        </CardHeader>
        <CardContent>
          {notifications.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {notifications.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                  <Badge variant={n.status === "failed" ? "danger" : n.status === "sent" ? "success" : "muted"}>
                    {n.status === "failed" ? "Didn't send" : n.status === "sent" ? "Sent" : "Waiting"}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate" title={n.subject}>
                    {n.subject}
                  </span>
                  <span className="text-xs text-muted-foreground">{n.recipient}</span>
                  {n.provider_id === "mock" && <Badge variant="warning">Not really sent</Badge>}
                  {n.error && n.provider_id !== "mock" && <span className="w-full text-xs text-destructive">{n.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmAction
        open={Boolean(revoking)}
        onOpenChange={(v) => !v && setRevoking(null)}
        title={`Disconnect ${NAMES[revoking] || revoking}?`}
        body={<p>The saved keys for {NAMES[revoking] || revoking} are deleted. Anything that uses them stops until you connect it again.</p>}
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => revoke(revoking)}
      />
    </div>
  );
}
