"use client";

import { useState } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/console/Toast";
import { ConfirmAction, sendJson } from "@/components/admin/offers/ConfirmAction";

// Billing (Phase 2 line 7): the plan and its state (grace and paused said
// plainly), this month's usage against the plan's limits, the plans with
// Subscribe (POST /api/admin/billing { action: "subscribe" }, settings.write,
// asks first), and charges and refunds. Every number comes from the payment
// provider's confirmed events (lib/admin/billing-view.js). A provider that
// isn't set up answers 503 with its reason, shown as it is; never a pretend plan.
//   initial: buildBillingView()
const money = (paise, currency = "INR") => (paise === 0 ? "Free" : `₹${(paise / 100).toLocaleString("en-IN")}${currency !== "INR" ? ` ${currency}` : ""}`);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");
const STATUS = { active: ["success", "Active"], grace: ["warning", "Payment overdue"], degraded: ["danger", "Checkout paused"], none: ["muted", "Free plan"] };
const KIND = { "subscription.charged": "Charge", "refund.processed": "Refund" };

export function BillingPanel({ initial, role }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [choosing, setChoosing] = useState(null);

  if (!data.supported) {
    return (
      <Alert variant="info" data-billing="unsupported">
        <AlertTitle>Billing isn't available for this store</AlertTitle>
        <AlertDescription>{data.reason}</AlertDescription>
      </Alert>
    );
  }

  async function subscribe(plan) {
    let json;
    try {
      json = await sendJson("/api/admin/billing", "POST", { action: "subscribe", plan: plan.id });
    } catch (e) {
      // 503: the payment provider isn't set up; its own words, plainly
      throw new Error(e.status === 503 ? `Plans can't be bought yet: ${e.message}. Storeasy's team has to finish setting up payments first.` : e.message);
    }
    setData(json);
    toast.success(
      json.result?.shortUrl ? "Almost done: approve the first payment with the button under Your plan. The plan starts once Razorpay confirms it." : `You're on ${plan.name}.`,
    );
  }

  const sub = data.subscription;
  const state = data.degraded ? "degraded" : data.inGrace ? "grace" : sub && ["active", "authenticated"].includes(sub.status) ? "active" : "none";
  const [tone, words] = STATUS[state];
  const charges = data.history.filter((h) => h.amount !== 0);

  return (
    <div className="space-y-4" data-billing="panel">
      {data.degraded && (
        <Alert variant="destructive">
          <AlertTitle>Checkout is paused because a payment is overdue</AlertTitle>
          <AlertDescription>
            Your storefront, products and orders all keep working; only new orders wait. Pay below and checkout comes back once the payment is confirmed.
          </AlertDescription>
        </Alert>
      )}
      {data.inGrace && !data.degraded && (
        <Alert variant="warning">
          <AlertTitle>A payment didn't go through</AlertTitle>
          <AlertDescription className="text-current">
            Everything keeps working until {day(sub?.grace_until) || "the end of the grace period"}. After that, checkout pauses until it's paid; nothing else stops.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            Your plan <Badge variant={tone}>{words}</Badge>
          </CardTitle>
          <CardDescription>
            {sub
              ? `${data.plans.find((p) => p.id === sub.plan)?.name || sub.plan}${sub.current_end ? `, renews ${day(sub.current_end)}` : ""}.`
              : "No plan bought yet: your store runs on the Free plan's limits."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sub?.short_url && ["created", "authenticated"].includes(sub.status) && (
            <Button asChild>
              <a href={sub.short_url} target="_blank" rel="noopener noreferrer">
                Approve the payment with Razorpay
                <ExternalLink aria-hidden />
              </a>
            </Button>
          )}
          {data.entitlements?.override && (
            <p className="text-sm text-muted-foreground">
              Storeasy's team adjusted {data.entitlements.override.fields.join(", ")} for you ({data.entitlements.override.reason})
              {data.entitlements.override.expiresAt ? `, until ${day(data.entitlements.override.expiresAt)}` : ""}.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Usage this month</CardTitle>
          <CardDescription>Going over a limit warns you; it never stops a sale.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.quotas.length === 0 && <p className="text-sm text-muted-foreground">This plan has no limits to count.</p>}
          {data.quotas.map((q) => {
            const pct = q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
            return (
              <div key={q.metric} className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="capitalize">{q.metric.replace(/_/g, " ")}</span>
                  <span className={q.over ? "font-mono text-destructive" : q.warn ? "font-mono text-warning-text" : "font-mono text-muted-foreground"}>
                    {q.used} of {q.limit}
                    {q.over ? ", over" : q.warn ? ", nearly there" : ""}
                  </span>
                </div>
                <Progress value={pct} aria-label={`${q.metric.replace(/_/g, " ")} used`} aria-valuetext={`${q.used} of ${q.limit}`} />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Plans</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 sm:grid-cols-3">
            {data.plans.map((p) => {
              const current = sub?.plan === p.id;
              return (
                <li key={p.id} className={`flex flex-col rounded-card border p-4 ${current ? "border-primary/40 bg-muted" : "border-border"}`} data-plan={p.id}>
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    {p.name}
                    {current && <Badge variant="success">Your plan</Badge>}
                  </p>
                  <p className="mt-1 font-mono text-lg font-semibold">
                    {money(p.price, p.currency)}
                    {p.price > 0 && <span className="font-sans text-xs font-normal text-muted-foreground"> a {p.interval}</span>}
                  </p>
                  <ul className="mt-2 flex-1 space-y-1 text-xs text-muted-foreground">
                    {Object.entries(p.features || {}).map(([k, v]) => (
                      <li key={k} className="flex items-center gap-1.5">
                        {typeof v === "boolean" ? (
                          v ? (
                            <Check aria-hidden className="size-3.5 text-success" />
                          ) : (
                            <X aria-hidden className="size-3.5" />
                          )
                        ) : (
                          <span className="font-mono text-foreground">{v}</span>
                        )}
                        <span>
                          {k.replace(/_/g, " ")}
                          {typeof v === "boolean" && <span className="sr-only">{v ? ", included" : ", not included"}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <RoleGate role={role} action="settings.write" reason="Only the owner or an admin can change the plan.">
                    <Button type="button" size="sm" className="mt-3 w-full" variant={current ? "outline" : "default"} disabled={current} onClick={() => setChoosing(p)}>
                      {current ? "Your plan" : p.price === 0 ? "Switch to Free" : `Subscribe to ${p.name}`}
                    </Button>
                  </RoleGate>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Charges and refunds</CardTitle>
        </CardHeader>
        <CardContent>
          {charges.length === 0 ? (
            <EmptyState title="No charges yet" />
          ) : (
            <ul className="divide-y divide-border">
              {charges.map((h, i) => (
                <li key={`${h.occurred_at}-${i}`} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="w-28 font-mono text-xs text-muted-foreground">{day(h.occurred_at)}</span>
                  <span className="flex-1">{KIND[h.type] || h.type.replace(/^subscription\./, "")}</span>
                  <span className={`font-mono ${h.amount < 0 ? "text-destructive" : ""}`}>
                    {h.amount < 0 ? "−" : ""}₹{(Math.abs(h.amount) / 100).toLocaleString("en-IN")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmAction
        open={Boolean(choosing)}
        onOpenChange={(v) => !v && setChoosing(null)}
        title={choosing ? `Switch to ${choosing.name}?` : ""}
        body={
          choosing ? (
            <p>
              {choosing.price === 0
                ? "Your store moves to the Free plan's limits from the next cycle."
                : `${money(choosing.price, choosing.currency)} a ${choosing.interval}, from the next cycle. Razorpay asks you to approve the first payment.`}
            </p>
          ) : null
        }
        confirmLabel={choosing?.price === 0 ? "Switch to Free" : "Subscribe"}
        onConfirm={() => subscribe(choosing)}
      />
    </div>
  );
}
