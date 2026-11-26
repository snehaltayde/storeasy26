"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { MoneyCell } from "@/components/kit/money-cell";
import { RoleGate } from "@/components/kit/role-gate";
import { StatusBadge } from "@/components/kit/status-badge";
import { sendJson } from "@/components/admin/offers/ConfirmAction";
import { dateText, productText } from "./SubscriptionTable";

// Phase 9 line 2: one subscription: its plan, next delivery, customer (hidden
// for support), cancel reason, and history (each cycle: due, ordered, skipped
// or missed, with its order). Staff and up pause or cancel it for a customer,
// with a reason that goes into the audit log.
const NO_MANAGE = "Your role can look at subscriptions but not change them.";
const CYCLE_WORDS = { due: "Due", ordered: "Ordered", skipped: "Skipped", missed: "Missed" };

export function SubscriptionDetail({ id, role, onClose }) {
  const router = useRouter();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [acting, setActing] = useState(null); // "pause" | "cancel"
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    setActing(null);
    setReason("");
    sendJson(`/api/admin/subscriptions?id=${encodeURIComponent(id)}`, "GET")
      .then((r) => setData(r.subscription))
      .catch((e) => setError(e.message));
  }, [id]);

  async function act() {
    setBusy(true);
    setError(null);
    try {
      await sendJson("/api/admin/subscriptions", "POST", { action: acting, id, reason });
      const r = await sendJson(`/api/admin/subscriptions?id=${encodeURIComponent(id)}`, "GET");
      setData(r.subscription);
      setActing(null);
      setReason("");
      router.refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const s = data;
  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" data-subscription-detail={id || ""}>
        <SheetHeader>
          <SheetTitle>{s ? productText(s) : "Subscription"}</SheetTitle>
          <SheetDescription>{s ? `${s.quantity} every ${s.interval} days${s.percent ? `, ${s.percent}% off (locked at signup)` : ""}` : "Loading…"}</SheetDescription>
        </SheetHeader>
        {error && (
          <p role="alert" className="px-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {s && (
          <div className="space-y-5 px-4 pb-6 text-sm">
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <StatusBadge kind="subscription" status={s.status} />
              </dd>
              <dt className="text-muted-foreground">Next due</dt>
              <dd>{s.status === "cancelled" ? "—" : s.status === "paused" ? (s.pausedUntil ? `Paused until ${dateText(s.pausedUntil)}` : "Paused until resumed") : dateText(s.nextDueAt)}</dd>
              <dt className="text-muted-foreground">Next amount</dt>
              <dd>{s.next ? <MoneyCell amount={s.next.amount} currency={s.next.currency} /> : "—"} <span className="text-muted-foreground">(today's price)</span></dd>
              <dt className="text-muted-foreground">Customer</dt>
              <dd>{s.customer ? `${s.customer.name ? `${s.customer.name} · ` : ""}${s.customer.email}` : s.pii_redacted ? "Hidden for your role" : "No longer linked"}</dd>
              <dt className="text-muted-foreground">First order</dt>
              <dd className="font-mono text-xs">{s.originOrderId}</dd>
              {s.cancelReason && (
                <>
                  <dt className="text-muted-foreground">Cancel reason</dt>
                  <dd>{s.cancelReason}</dd>
                </>
              )}
            </dl>

            <section aria-label="History">
              <h3 className="mb-2 font-medium">History</h3>
              {s.history.length === 0 ? (
                <p className="text-muted-foreground">No renewals yet.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {s.history.map((c) => (
                    <li key={c.cycle} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <span className="w-16 text-muted-foreground">#{c.cycle}</span>
                      <span className="flex-1">
                        {CYCLE_WORDS[c.status] || c.status} · due {dateText(c.dueAt)}
                      </span>
                      {c.orderId && <span className="font-mono text-xs">{c.orderId}</span>}
                      {c.total && <MoneyCell amount={c.total.amount} currency={c.total.currency} />}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {s.status !== "cancelled" && (
              <section aria-label="Change for the customer" className="space-y-3">
                {!acting ? (
                  <div className="flex gap-2">
                    {s.status === "active" && (
                      <RoleGate role={role} action="subscriptions.manage" reason={NO_MANAGE}>
                        <Button variant="outline" data-subscription-action="pause" onClick={() => setActing("pause")}>
                          Pause
                        </Button>
                      </RoleGate>
                    )}
                    <RoleGate role={role} action="subscriptions.manage" reason={NO_MANAGE}>
                      <Button variant="destructive" data-subscription-action="cancel" onClick={() => setActing("cancel")}>
                        Cancel subscription
                      </Button>
                    </RoleGate>
                  </div>
                ) : (
                  <div className="space-y-2 rounded-md border p-3">
                    <Label htmlFor="sub-reason">{acting === "pause" ? "Why pause it?" : "Why cancel it?"} The customer's request, for example. This goes into the audit log.</Label>
                    <Textarea id="sub-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
                    <div className="flex gap-2">
                      <Button variant={acting === "cancel" ? "destructive" : "default"} disabled={busy || !reason.trim()} onClick={act} data-subscription-confirm={acting}>
                        {acting === "pause" ? "Pause subscription" : "Cancel subscription"}
                      </Button>
                      <Button variant="ghost" disabled={busy} onClick={() => setActing(null)}>
                        Keep it
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
