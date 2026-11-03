"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import OfferForm from "./OfferForm";
import { offerScheduleStatus } from "@/lib/admin/schedule";
import { OFFER_TYPE_NAMES, offerSentence } from "@/lib/offers/plain";
import { PageHeader } from "@/components/console/PageHeader";
import { Card } from "@/components/console/Card";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Switch } from "@/components/console/Switch";
import { ConfirmDialog } from "@/components/console/Dialog";
import { EmptyState, Skeleton } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Single-store offer console (Session 19, redesigned S50, plain words in
// COM-03). List + on/off + schedule + edit/create for the 4 engine offer
// types. Every save is live on the next cart read — deliberately NOT a SaaS
// console (no tenants/theming/billing).
// S32 (MC14): lifecycle — draft / paused / scheduled / active / expired
// (derived in lib/admin/schedule.js, same logic the engine's window uses);
// S50 renders it through the one StatusBadge map instead of a local chip.
// COM-03: each row reads as the offer's sentence (lib/offers/plain.js) in the
// store's currency. PUB-04 ("Recently published", phase 3) will list offer
// changes from listRecentOfferChanges() in lib/offers/store.js, with Undo
// calling the same /api/admin/offers/:id/revert as the form's
// "Go back to previous offer settings".

export default function OffersAdmin({ initialOffers, initialNames = {}, currency: initialCurrency = "INR" }) {
  const toast = useToast();
  const [offers, setOffers] = useState(initialOffers);
  const [names, setNames] = useState(initialNames);
  const [currency, setCurrency] = useState(initialCurrency);
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
      if (!res.ok || !data.offers) throw new Error(data.error || "Your offers couldn't load. Try again.");
      setOffers(data.offers);
      if (data.names) setNames(data.names);
      if (data.currency) setCurrency(data.currency);
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
        throw new Error(data.error || "That didn't work. Try again.");
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
      throw new Error(data.error || "That didn't work. Try again.");
    }
    toast.success(`Deleted “${offer.label}”`);
    await refresh();
  }

  const summarize = (o) => offerSentence(o.config, { names, currency }) || o.label;

  const schedule = (o) => {
    if (!o.starts_at && !o.ends_at) return "Runs whenever it's on";
    const f = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "…");
    return `${f(o.starts_at)} → ${f(o.ends_at)}`;
  };

  if (editing) {
    return (
      <OfferForm
        existing={editing === "new" ? null : editing}
        currency={currency}
        names={names}
        offers={offers}
        onChanged={() => refresh({ silent: true })}
        onDone={async (result = {}) => {
          setEditing(null);
          if (result.reverted) toast.success("Back to the earlier settings. Shoppers get them on their next cart.");
          else if (result.created) toast.success(`“${result.offer?.label || "Your offer"}” has started.`);
          else toast.success("Updated. Shoppers get it on their next cart.");
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
        description="An offer reaches shoppers as soon as you start it, with no publish step. Turn one off at any time."
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
            body="Buy-some-get-some-free deals, bigger discounts for buying more, free gifts and discount codes all start here."
            action={newOfferButton}
          />
        ) : (
          <ul className="divide-y divide-edge">
            {offers.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4">
                <Switch
                  checked={!!o.enabled}
                  pending={togglingId === o.id}
                  label={`${o.enabled ? "Turn off" : "Turn on"} ${o.label}`}
                  onChange={() => toggle(o)}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold text-fg">
                    <span className="truncate">{o.label}</span>
                    <Badge>{OFFER_TYPE_NAMES[o.type] || o.type}</Badge>
                    <StatusBadge status={offerScheduleStatus(o)} />
                  </p>
                  <p className="text-xs text-fg-muted">
                    {summarize(o)} · <span className={o.starts_at || o.ends_at ? "text-warning" : ""}>{schedule(o)}</span>
                  </p>
                </div>
                {o.type === "BUNDLE" ? (
                  // a bundle's offer follows its bundle record; editing or
                  // deleting it here would leave the two disagreeing
                  <a href="/admin/catalog" className="rounded-ctl px-2.5 py-1.5 text-xs font-medium text-fg-muted focus-ring hover:bg-surface-sunken hover:text-fg">
                    Change it in Catalog
                  </a>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(o)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="dangerOutline" onClick={() => setDeleting(o)}>
                      Delete
                    </Button>
                  </div>
                )}
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
        body={deleting ? `Delete “${deleting.label}”? Shoppers lose it on their next cart, and it can't be brought back.` : null}
        onConfirm={() => remove(deleting)}
      />
    </div>
  );
}
