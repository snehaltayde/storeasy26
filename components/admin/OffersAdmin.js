"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import OfferForm from "./OfferForm";
import { offerScheduleStatus } from "@/lib/admin/schedule";
import { PageHeader } from "@/components/console/PageHeader";
import { Card } from "@/components/console/Card";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Switch } from "@/components/console/Switch";
import { ConfirmDialog } from "@/components/console/Dialog";
import { EmptyState, Skeleton } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Single-store offer console (Session 19, redesigned S50). List +
// enable/disable + schedule + edit/create for the 4 engine offer types.
// Every save is live on the next cart read — deliberately NOT a SaaS console
// (no tenants/theming/billing).
// S32 (MC14): lifecycle — draft / paused / scheduled / active / expired
// (derived in lib/admin/schedule.js, same logic the engine's window uses);
// S50 renders it through the one StatusBadge map instead of a local chip.

export default function OffersAdmin({ initialOffers }) {
  const toast = useToast();
  const [offers, setOffers] = useState(initialOffers);
  const [editing, setEditing] = useState(null); // offer row | "new"
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [togglingId, setTogglingId] = useState(null);
  const [deleting, setDeleting] = useState(null); // offer row | null

  // silent=true keeps the rows on screen (the toggling Switch already shows
  // pending); the skeleton pass is for refetches after save/delete.
  async function refresh({ silent = false } = {}) {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/admin/offers");
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.offers) throw new Error(data.error || `Couldn't load offers (${res.status})`);
      setOffers(data.offers);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setRefreshing(false);
    }
  }

  async function toggle(offer) {
    setError(null);
    setTogglingId(offer.id);
    try {
      const res = await fetch(`/api/admin/offers/${offer.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !offer.enabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Toggle failed (${res.status})`);
      }
      await refresh({ silent: true });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setTogglingId(null);
    }
  }

  async function remove(offer) {
    const res = await fetch(`/api/admin/offers/${offer.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Delete failed (${res.status})`);
    }
    toast.success(`Deleted “${offer.label}”`);
    await refresh();
  }

  const summarize = (o) => {
    const c = o.config || {};
    switch (o.type) {
      case "BXGY":
        return `buy ${c.buy} get ${c.free} free · ${c.target?.kind}=${c.target?.value}`;
      case "TIERED_QTY":
        return `${(c.tiers || []).map((t) => `${t.minQty}+→${t.percent}%`).join(", ")} · ${c.target?.kind}=${c.target?.value}`;
      case "FREE_GIFT":
        return `over ₹${c.threshold} → ${c.gift?.title?.slice(0, 30)}`;
      case "COUPON":
        return `${c.code} · ${c.discount?.kind === "percent" ? `${c.discount.value}%` : `₹${c.discount?.value}`}${c.minSubtotal ? ` (min ₹${c.minSubtotal})` : ""}${c.combinable === false ? " · exclusive" : ""}`;
      default:
        return "";
    }
  };

  const schedule = (o) => {
    if (!o.starts_at && !o.ends_at) return "always";
    const f = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "…");
    return `${f(o.starts_at)} → ${f(o.ends_at)}`;
  };

  if (editing) {
    return (
      <OfferForm
        existing={editing === "new" ? null : editing}
        onDone={async () => {
          setEditing(null);
          await refresh();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const newOfferButton = (
    <Button variant="primary" icon={<Plus size={15} aria-hidden />} onClick={() => setEditing("new")}>
      New offer
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Offers"
        description="Changes are live on the next cart read — no deploy needed."
        actions={newOfferButton}
      />

      {error && (
        <Banner tone="danger" className="mb-4" actions={<Button size="sm" onClick={() => { setError(null); refresh(); }}>Retry</Button>}>
          {error}
        </Banner>
      )}

      <Card padded={false}>
        {refreshing ? (
          <ul className="divide-y divide-edge" aria-hidden>
            {Array.from({ length: Math.max(offers.length, 3) }, (_, i) => (
              <li key={i} className="flex items-center gap-4 px-4 py-4">
                <Skeleton className="h-5 w-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </li>
            ))}
          </ul>
        ) : offers.length === 0 ? (
          <EmptyState
            title="No offers yet"
            body="Coupons, bundles, tiered discounts and free gifts all start here."
            action={newOfferButton}
          />
        ) : (
          <ul className="divide-y divide-edge">
            {offers.map((o) => (
              <li key={o.id} className="flex items-center gap-4 px-4 py-4">
                <Switch
                  checked={!!o.enabled}
                  pending={togglingId === o.id}
                  label={`${o.enabled ? "Disable" : "Enable"} ${o.label}`}
                  onChange={() => toggle(o)}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
                    <span className="truncate">{o.label}</span>
                    <Badge>{o.type}</Badge>
                    <StatusBadge status={offerScheduleStatus(o)} />
                  </p>
                  <p className="truncate text-xs text-fg-muted">
                    {summarize(o)} · <span className={o.starts_at || o.ends_at ? "text-warning" : ""}>{schedule(o)}</span>
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditing(o)}>
                  Edit
                </Button>
                <Button size="sm" variant="dangerOutline" onClick={() => setDeleting(o)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete offer"
        tone="danger"
        confirmLabel="Delete offer"
        body={deleting ? `Delete “${deleting.label}”? Shoppers lose it on the next cart read — this cannot be undone.` : null}
        onConfirm={() => remove(deleting)}
      />
    </div>
  );
}
