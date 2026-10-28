"use client";

import { useState } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Table } from "@/components/console/Table";
import { EmptyState } from "@/components/console/bits";
import { ConfirmDialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";
import { cx } from "@/components/console/cx";

// Billing tab (S40 / MC24, redesigned S50). Everything shown derives from
// provider state + the plan catalog — the console never invents money
// numbers. States are honest: grace shows a countdown warning, degraded
// explains exactly what is paused (checkout) and what is not (everything
// else). Plan changes now confirm via dialog before anything is created.

const money = (paise, currency = "INR") =>
  paise === 0 ? "Free" : `₹${(paise / 100).toLocaleString("en-IN")}${currency !== "INR" ? ` ${currency}` : ""}`;

const CHARGE_COLUMNS = [
  { key: "occurred_at", header: "Date", width: "8rem" },
  { key: "type", header: "Event" },
  { key: "amount", header: "Amount", align: "right", width: "8rem" },
];

const chargeKind = (type) => String(type).replace("subscription.", "").replace("refund.processed", "refund");

function Meter({ quota: q }) {
  const pct = q.limit > 0 ? Math.round((q.used / q.limit) * 100) : 0;
  const warn = q.warn || pct >= 80;
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="font-medium text-fg-muted">{q.metric.replace(/_/g, " ")}</span>
        <span className={cx("tabular-nums", q.over ? "font-semibold text-danger" : warn ? "font-semibold text-warning" : "text-fg-subtle")}>
          {q.used} / {q.limit}
          {q.over ? " — over" : warn ? " — nearing limit" : ""}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
        <div
          className={cx("h-full rounded-full motion-safe:transition-[width]", q.over ? "bg-danger" : warn ? "bg-warning" : "bg-primary")}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

export default function BillingAdmin({ initial }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [confirm, setConfirm] = useState(null); // plan pending confirmation

  if (!data.supported) {
    // provider unconfigured — the honest, persistent state note
    return <Banner tone="neutral">{data.reason}</Banner>;
  }

  async function subscribe(planId) {
    const res = await fetch("/api/admin/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "subscribe", plan: planId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(json.error || `Failed (${res.status})`);
    setData(json);
    toast.success(
      json.result?.shortUrl
        ? "Subscription created — authorize the first payment via the link in Current plan. The plan activates once Razorpay confirms."
        : "Plan active.",
    );
  }

  const sub = data.subscription;
  const charges = data.history.filter((h) => h.amount !== 0);

  return (
    <div className="space-y-4">
      {data.degraded && (
        <Banner tone="danger" title="Checkout is paused — subscription payment is overdue.">
          Your storefront, catalog and order lookups stay fully live; only new checkouts are held. Renew below and checkout resumes on the
          next payment confirmation.
        </Banner>
      )}
      {data.inGrace && !data.degraded && (
        <Banner tone="warning" title="Payment trouble — grace period running.">
          Everything keeps working until{" "}
          {sub?.grace_until ? new Date(sub.grace_until).toLocaleString("en-IN", { dateStyle: "medium" }) : "the grace deadline"}; after
          that, checkout pauses (nothing else shuts down).
        </Banner>
      )}

      <Card>
        <CardHeader title="Current plan" badge={<StatusBadge status={data.label} />} />
        {sub ? (
          <p className="text-sm text-fg-muted">
            <span className="font-medium capitalize text-fg">{sub.plan}</span> (v{sub.version})
            {sub.current_end ? ` · renews ${new Date(sub.current_end).toLocaleDateString("en-IN", { dateStyle: "medium" })}` : ""}
          </p>
        ) : (
          <p className="text-sm text-fg-muted">No subscription yet — this store runs on the Free plan&rsquo;s limits.</p>
        )}
        {sub?.short_url && ["created", "authenticated"].includes(sub.status) && (
          <a
            href={sub.short_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-ctl bg-primary px-3.5 py-2 text-sm font-medium text-primary-fg focus-ring hover:bg-primary-hover motion-safe:transition-colors"
          >
            Authorize payment with Razorpay
            <ExternalLink size={14} aria-hidden />
          </a>
        )}
        {data.entitlements.override && (
          <Banner tone="info" className="mt-3">
            Operator adjustment active on: {data.entitlements.override.fields.join(", ")} ({data.entitlements.override.reason})
            {data.entitlements.override.expiresAt ? ` — until ${new Date(data.entitlements.override.expiresAt).toLocaleDateString("en-IN")}` : ""}
          </Banner>
        )}
      </Card>

      <Card>
        <CardHeader title="Usage this month" />
        <div className="space-y-3">
          {data.quotas.map((q) => (
            <Meter key={q.metric} quota={q} />
          ))}
          {data.quotas.length === 0 && <p className="text-sm text-fg-subtle">No metered limits on this plan.</p>}
        </div>
        <p className="mt-3 text-[11px] text-fg-subtle">
          Going over warns — it never blocks a sale. Checkout pauses only when a subscription stays unpaid past its grace period.
        </p>
      </Card>

      <Card>
        <CardHeader title="Plans" />
        <div className="grid gap-3 sm:grid-cols-3">
          {data.plans.map((p) => {
            const current = sub?.plan === p.id;
            return (
              <div key={p.id} className={cx("rounded-ctl border p-4", current ? "border-edge-strong bg-surface-sunken" : "border-edge")}>
                <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                  {p.name}
                  {current && <Badge tone="success">Current</Badge>}
                </p>
                <p className="mt-1 text-lg font-semibold tracking-tight text-fg">
                  {money(p.price, p.currency)}
                  {p.price > 0 && <span className="text-xs font-normal text-fg-subtle">/{p.interval}</span>}
                </p>
                <ul className="mt-2 space-y-1 text-xs text-fg-muted">
                  {Object.entries(p.features).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {typeof v === "boolean" ? (
                        v ? (
                          <Check size={13} className="shrink-0 text-success" aria-hidden />
                        ) : (
                          <X size={13} className="shrink-0 text-fg-subtle" aria-hidden />
                        )
                      ) : (
                        <span className="font-medium tabular-nums text-fg">{v}</span>
                      )}
                      <span className={cx(typeof v === "boolean" && !v && "text-fg-subtle")}>
                        {k.replace(/_/g, " ")}
                        {typeof v === "boolean" && <span className="sr-only">{v ? " — included" : " — not included"}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                <Button size="sm" variant="primary" disabled={current} onClick={() => setConfirm(p)} className="mt-3 w-full">
                  {current ? "Current plan" : p.price === 0 ? "Switch to Free" : "Choose plan"}
                </Button>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader title="Charges & refunds" />
        <Table
          columns={CHARGE_COLUMNS}
          rows={charges}
          dense
          empty={<EmptyState title="No charges yet" className="py-6" />}
          renderCell={(h, col) => {
            switch (col.key) {
              case "occurred_at":
                return <span className="whitespace-nowrap text-xs text-fg-muted">{new Date(h.occurred_at).toLocaleDateString("en-IN", { dateStyle: "medium" })}</span>;
              case "type":
                return <StatusBadge status={chargeKind(h.type)} />;
              case "amount":
                return (
                  <span className={cx("font-medium", h.amount < 0 ? "text-danger" : "text-fg")}>
                    {h.amount < 0 ? "−" : ""}₹{(Math.abs(h.amount) / 100).toLocaleString("en-IN")}
                  </span>
                );
              default:
                return h[col.key];
            }
          }}
        />
      </Card>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Change plan"
        confirmLabel="Switch plan"
        body={confirm ? `Switch to ${confirm.name} — ${money(confirm.price, confirm.currency)}${confirm.price > 0 ? `/${confirm.interval}` : ""} from the next cycle?` : null}
        onConfirm={() => subscribe(confirm.id)}
      />
    </div>
  );
}
