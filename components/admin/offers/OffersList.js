"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CircleAlert, Plus, Search, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { RoleGate } from "@/components/kit/role-gate";
import { StatusBadge, offerState } from "@/components/kit/status-badge";
import { isAutoTitle } from "@/components/admin/offerFormModel";
import { OFFER_TYPE_NAMES, offerSentence, staleNameWarning } from "@/lib/offers/plain";
import { ConfirmAction, sendJson } from "./ConfirmAction";
import { scheduleText } from "./ScheduleField";

// The offers list (Phase 2 line 4): each offer as its sentence, with kind,
// state (Live, Scheduled, Ended, Off), schedule in the store's time and a
// warning when a typed name mentions rules changed since. Tabs by state with
// counts and a search by name or code filter the store's offers here (one
// store's offers are a short list; the API answers them all). Writers get an
// on/off Switch (turning off a live offer asks first); support gets none. A
// bundle's own offer says "Part of bundle X" and links there, with no switch
// for anyone (the offers API refuses it: NOT_HERE).
const TABS = [
  ["all", "All"],
  ["live", "Live"],
  ["scheduled", "Scheduled"],
  ["ended", "Ended"],
  ["off", "Off"],
];
const PAGE = 50;
const NO_WRITE = "Your role can look at offers but not change them.";
export const bundleIdOf = (offer) => (offer?.type === "BUNDLE" && String(offer.id).startsWith("bundle-") ? String(offer.id).slice("bundle-".length) : null);

export function OffersList({ initialOffers, initialNames = {}, currency, timezone, role, canWrite }) {
  const [offers, setOffers] = useState(initialOffers);
  const [names, setNames] = useState(initialNames);
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [toggling, setToggling] = useState(null);
  const [askOff, setAskOff] = useState(null);
  const now = Date.now();

  async function refresh({ quiet = false } = {}) {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch("/api/admin/offers");
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.offers) throw new Error(data.error || "Your offers couldn't load.");
      setOffers(data.offers);
      if (data.names) setNames(data.names);
      setError(null);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function setEnabled(o, enabled) {
    setToggling(o.id);
    try {
      await sendJson(`/api/admin/offers/${encodeURIComponent(o.id)}`, "PUT", { enabled });
      await refresh({ quiet: true });
    } catch (e) {
      setError(`“${o.label}”: ${e.message}`);
    } finally {
      setToggling(null);
    }
  }

  const stateOf = (o) => offerState(o, now);
  const counts = useMemo(() => {
    const c = { all: offers.length, live: 0, scheduled: 0, ended: 0, off: 0 };
    for (const o of offers) c[offerState(o, now)]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offers]);
  const needle = q.trim().toLowerCase();
  const shown = offers.filter((o) => (tab === "all" || stateOf(o) === tab) && (!needle || String(o.label || "").toLowerCase().includes(needle) || String(o.config?.code || "").toLowerCase().includes(needle)));
  const page = shown.slice(offset, offset + PAGE);
  const say = { names, currency };

  const newOffer = (
    <RoleGate role={role} action="offers.write" reason={NO_WRITE}>
      <Link href="/admin/offers/new" className={buttonVariants()}>
        <Plus aria-hidden /> New offer
      </Link>
    </RoleGate>
  );

  const columns = [
    { key: "label", header: "Offer", truncate: true, className: "w-[22%] min-w-36" },
    {
      key: "sentence",
      header: "What shoppers get",
      className: "w-[44%]",
      cell: (o) => {
        const stale = !isAutoTitle(o.config, say) && o.previous ? staleNameWarning(o.config?.title, o.previous.config, o.config, say) : null;
        const bundleId = bundleIdOf(o);
        return (
          <div className="min-w-64 space-y-1 py-1.5 whitespace-normal">
            <p className="text-sm leading-snug text-foreground" data-sentence="row">
              {offerSentence(o.config, say) || o.label}
            </p>
            {bundleId && (
              <p className="text-xs text-muted-foreground">
                Part of bundle{" "}
                <Link href={`/admin/bundles/${encodeURIComponent(bundleId)}`} data-read-control className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" data-offer-bundle-link>
                  {o.label}
                </Link>
              </p>
            )}
            {stale && (
              <p className="flex items-start gap-1 text-xs text-warning-text" data-offer-stale-name>
                <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {stale}
              </p>
            )}
          </div>
        );
      },
    },
    { key: "type", header: "Kind", cell: (o) => <Badge variant="muted">{OFFER_TYPE_NAMES[o.type] || "Offer"}</Badge> },
    { key: "state", header: "State", cell: (o) => <StatusBadge kind="offer" status={stateOf(o)} /> },
    { key: "schedule", header: "When", className: "min-w-40 max-w-56 whitespace-normal", cell: (o) => <span className="block text-xs leading-snug text-muted-foreground">{scheduleText(o.starts_at, o.ends_at, timezone)}</span> },
  ];

  const rowActions = canWrite
    ? (o) =>
        bundleIdOf(o) ? null : (
          <Switch
            checked={!!o.enabled}
            disabled={toggling === o.id}
            aria-label={`${o.enabled ? "Turn off" : "Turn on"} ${o.label}`}
            data-offer-switch={o.id}
            onCheckedChange={(v) => (!v && stateOf(o) === "live" ? setAskOff(o) : setEnabled(o, v))}
          />
        )
    : null;

  return (
    <div>
      <PageHeader title="Offers" description="An offer reaches shoppers as soon as you start it, with no publish step. Turn one off at any time." actions={newOffer} />

      {error && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-card border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span className="flex items-start gap-2">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error}
          </span>
          <Button type="button" size="sm" variant="outline" data-read-control onClick={() => refresh()}>
            Try again
          </Button>
        </div>
      )}

      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v);
            setOffset(0);
          }}
        >
          <TabsList aria-label="Offers by state" data-read-control className="max-w-full overflow-x-auto">
            {TABS.map(([k, label]) => (
              <TabsTrigger key={k} value={k} data-read-control>
                {label} <span className="ml-1 font-mono text-xs tabular-nums text-muted-foreground">{counts[k]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative sm:w-64">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search offers by name or code"
            placeholder="Search by name or code"
            className="pl-8"
            data-read-control
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
        </div>
      </div>

      <DataTable
        label="Offers"
        columns={columns}
        rows={page}
        loading={loading}
        skeletonRows={Math.max(3, Math.min(page.length, 8))}
        rowHref={(o) => (bundleIdOf(o) ? `/admin/bundles/${encodeURIComponent(bundleIdOf(o))}` : `/admin/offers/${encodeURIComponent(o.id)}`)}
        rowActions={rowActions}
        footer={shown.length > PAGE ? { offset, total: shown.length, onPrevious: () => setOffset(Math.max(0, offset - PAGE)), onNext: () => setOffset(offset + PAGE) } : { offset: 0, total: shown.length }}
        empty={
          offers.length === 0 ? (
            <EmptyState title="No offers yet" description="Buy-some-get-some-free deals, bigger discounts for buying more, free gifts and discount codes all start here." action={newOffer} />
          ) : (
            <EmptyState title="No offers match" description={needle ? "Try a different name or code." : "No offer is in this state right now."} />
          )
        }
      />

      <ConfirmAction
        open={!!askOff}
        onOpenChange={(v) => !v && setAskOff(null)}
        title="Turn off this offer?"
        destructive
        confirmLabel="Turn off"
        body={askOff ? <p>“{askOff.label}” is live. Shoppers lose it on their next cart. You can turn it back on at any time.</p> : null}
        onConfirm={async () => {
          await sendJson(`/api/admin/offers/${encodeURIComponent(askOff.id)}`, "PUT", { enabled: false });
          await refresh({ quiet: true });
        }}
      />
    </div>
  );
}
