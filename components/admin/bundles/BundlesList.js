"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert, House, Plus, Trash2 } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { MoneyCell } from "@/components/kit/money-cell";
import { PageHeader } from "@/components/kit/page-header";
import { RoleGate } from "@/components/kit/role-gate";
import { StatusBadge } from "@/components/kit/status-badge";
import { stateLine } from "@/lib/commerce/bundle-words";
import { offerScheduleStatus } from "@/lib/admin/schedule";
import { scheduleText } from "@/components/admin/offers/ScheduleField";
import { ConfirmAction, sendJson } from "@/components/admin/offers/ConfirmAction";
import { allWords, componentLabel } from "./BundleCheck";

// The bundles list (Phase 2 line 4): each bundle's products with quantities,
// its price against the products' sum and the saving, whether it can be sold
// (bundle-words sentences from the structured reasons), on or off, and "On
// your home page". Writers turn a bundle on (refused with the reasons when it
// can't be sold) or off (asks first when the live home page shows it, or when
// that could not be checked), and delete it (asks first, and says when the
// home page shows it). Support reads the same rows with no switch or delete.
// Rows come from the server page (router.refresh() after each change).
const NO_WRITE = "Your role can look at bundles but not change them.";
const HOME_GOES = "Shoppers will stop seeing this bundle on your home page right away.";
const HOME_UNKNOWN = "We couldn't check whether your home page uses this bundle.";
// asks first unless the home page was read and does not use it
export const disableAsksFirst = (b) => b?.usedOnHome !== false;

export function BundlesList({ initialBundles, currency, timezone = "UTC", role, canWrite }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(null);
  const [toggling, setToggling] = useState(null);
  const [askOff, setAskOff] = useState(null);
  const [askDelete, setAskDelete] = useState(null);
  const bundles = initialBundles;
  const refresh = () => startTransition(() => router.refresh());

  async function setEnabled(b, enabled) {
    setToggling(b.id);
    setError(null);
    try {
      await sendJson("/api/admin/bundles", "POST", { enable: { id: b.id, enabled } });
      refresh();
    } catch (e) {
      const said = allWords(e.body?.reasons, currency);
      setError(`${b.title} can't be turned on: ${said.length ? said.join(". ") : e.message}`);
      throw e;
    } finally {
      setToggling(null);
    }
  }

  const newBundle = (
    <RoleGate role={role} action="offers.write" reason={NO_WRITE}>
      <Link href="/admin/bundles/new" className={buttonVariants()}>
        <Plus aria-hidden /> New bundle
      </Link>
    </RoleGate>
  );

  const columns = [
    { key: "title", header: "Bundle", truncate: true, className: "w-[24%] min-w-36" },
    {
      key: "items",
      header: "Products",
      cell: (b) => (
        <ul className="min-w-56 space-y-0.5 py-1.5 text-xs whitespace-normal text-muted-foreground" data-bundle-components>
          {(b.components || b.items || []).map((c, i) => (
            <li key={`${c.variantId}-${i}`}>
              <span className="font-mono tabular-nums">{c.quantity ?? 1} ×</span> {componentLabel(c) || "A product no longer in your catalog"}
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      cell: (b) => {
        const sum = Number(b.compat?.componentsSum) || 0;
        // the parts' sum is struck through only when the bundle really costs
        // less; a price at or over the sum says the sum plainly instead
        const saves = sum > 0 && Number(b.bundle_price) < sum;
        return (
          <div className="space-y-0.5 py-1">
            <MoneyCell amount={b.bundle_price} currency={currency} className="font-medium text-foreground" />
            {sum > 0 && (
              <span className={cn("block text-right text-xs text-muted-foreground", saves && "line-through decoration-muted-foreground/70")} data-bundle-sum>
                <span className="sr-only">{saves ? "Products add up to " : "The products add up to only "}</span>
                {!saves && <span aria-hidden>Parts </span>}
                <MoneyCell amount={sum} currency={currency} className="inline" />
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "saving",
      header: "Saving",
      align: "right",
      cell: (b) =>
        b.compat?.state === "available" ? (
          <MoneyCell amount={b.compat.saving} currency={currency} className="text-success" />
        ) : (
          <span className="block text-right text-xs text-muted-foreground">None</span>
        ),
    },
    {
      key: "state",
      header: "State",
      cell: (b) => {
        const ready = b.compat?.state === "available";
        const why = allWords(b.compat?.reasons, currency);
        // Phase 8 line 5: draft / scheduled / active / expired from its window
        const schedule = offerScheduleStatus({ enabled: !!b.enabled, starts_at: b.starts_at ?? null, ends_at: b.ends_at ?? null });
        return (
          <div className="min-w-44 space-y-1 py-1 whitespace-normal">
            <div className="flex flex-wrap items-center gap-1.5">
              <span data-bundle-schedule={schedule}>
                <StatusBadge kind="bundle" status={schedule} />
              </span>
              {b.usedOnHome && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-bundle-home>
                  <House aria-hidden className="size-3.5" /> On your home page
                </span>
              )}
            </div>
            {(b.starts_at || b.ends_at) && <p className="text-xs leading-snug text-muted-foreground">{scheduleText(b.starts_at, b.ends_at, timezone)}</p>}
            {!ready && (
              <p className="text-xs leading-snug text-warning-text" data-bundle-reason>
                {b.enabled ? stateLine(b.compat?.state, b.compat?.reasons, { currency }) : why.length ? `Can't be shown yet: ${why.join(". ")}.` : "Can't be shown yet."}
              </p>
            )}
          </div>
        );
      },
    },
  ];

  const rowActions = canWrite
    ? (b) => (
        <>
          <Switch
            checked={!!b.enabled}
            disabled={toggling === b.id || pending}
            aria-label={`${b.enabled ? "Turn off" : "Turn on"} ${b.title}`}
            data-bundle-switch={b.id}
            onCheckedChange={(v) => (v ? setEnabled(b, true).catch(() => {}) : disableAsksFirst(b) ? setAskOff(b) : setEnabled(b, false).catch(() => {}))}
          />
          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete ${b.title}`} onClick={() => setAskDelete(b)}>
            <Trash2 aria-hidden />
          </Button>
        </>
      )
    : null;

  return (
    <div>
      <PageHeader title="Bundles" description="A set price for a fixed group of products, taken off in the cart. Shoppers see a bundle only while every product is in stock and the price saves money." actions={newBundle} />

      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-card border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" data-bundle-error>
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <DataTable
        label="Bundles"
        columns={columns}
        rows={bundles}
        loading={pending && !toggling}
        rowHref={(b) => `/admin/bundles/${encodeURIComponent(b.id)}`}
        rowActions={rowActions}
        footer={{ offset: 0, total: bundles.length }}
        empty={<EmptyState title="No bundles yet" description="Sell a fixed group of products at a set price. The cart takes the saving off by itself." action={newBundle} />}
      />

      <ConfirmAction
        open={!!askOff}
        onOpenChange={(v) => !v && setAskOff(null)}
        title="Turn off this bundle?"
        destructive
        confirmLabel="Turn off"
        body={askOff ? <p>“{askOff.title}” stops being sold as a bundle. {askOff.usedOnHome == null ? `${HOME_UNKNOWN} Turn it off anyway?` : HOME_GOES}</p> : null}
        onConfirm={() => setEnabled(askOff, false)}
      />
      <ConfirmAction
        open={!!askDelete}
        onOpenChange={(v) => !v && setAskDelete(null)}
        title="Delete this bundle?"
        destructive
        confirmLabel="Delete bundle"
        body={
          askDelete ? (
            <p>
              Removes “{askDelete.title}” for good. Its cart offer goes too, so shoppers can no longer buy it as a bundle.
              {askDelete.usedOnHome ? ` ${HOME_GOES}` : askDelete.usedOnHome == null ? ` ${HOME_UNKNOWN} Delete it anyway?` : ""}
            </p>
          ) : null
        }
        onConfirm={async () => {
          await sendJson("/api/admin/bundles", "POST", { remove: { id: askDelete.id } });
          refresh();
        }}
      />
    </div>
  );
}
