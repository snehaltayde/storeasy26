"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, Search } from "lucide-react";
import { Tabs } from "@/components/console/Tabs";
import { Table } from "@/components/console/Table";
import { StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Input } from "@/components/console/fields";
import { EmptyState } from "@/components/console/bits";
import { ConfirmDialog } from "@/components/console/Dialog";
import { Textarea } from "@/components/console/fields";
import { useToast } from "@/components/console/Toast";
import { humanizeStatus } from "@/components/console/status";

// Orders console (S22, redesigned S50): status tabs with honest counts, a
// real table (numeric right-aligned, skeleton rows while filtering, fetch
// errors surfaced — they used to fail silently), keyset "load more", and a
// Returns view (S46) that now lives BEHIND the page header instead of on
// top of it. Decisions go through ConfirmDialog; approval moves no money.

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const when = (s) =>
  new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const STATUS_TABS = ["all", "paid", "synced", "sync_failed", "cod_pending", "pending_payment", "cancelled"];

const ORDER_COLUMNS = [
  { key: "id", header: "Order" },
  { key: "customer", header: "Customer" },
  { key: "status", header: "Status" },
  { key: "payment_method", header: "Payment" },
  { key: "total", header: "Total", align: "right" },
  { key: "created_at", header: "Placed", align: "right" },
  { key: "open", header: "", width: "2rem" },
];

function OrdersTable({ orders, loading, filtered, onClear }) {
  const router = useRouter();
  return (
    <Table
      columns={ORDER_COLUMNS}
      rows={orders}
      loading={loading}
      empty={
        <EmptyState
          title={filtered ? "No orders match" : "No orders yet"}
          body={filtered ? "Try a different status or search term." : "Orders land here the moment checkout completes."}
          action={filtered ? <Button size="sm" onClick={onClear}>Clear filters</Button> : null}
        />
      }
      renderCell={(o, col) => {
        switch (col.key) {
          case "id":
            return (
              <Link href={`/admin/orders/${o.id}`} className="rounded font-mono text-xs font-medium text-fg focus-ring hover:underline">
                {o.id}
              </Link>
            );
          case "customer":
            return (
              <span className="block max-w-44 truncate text-fg-muted" title={o.email || undefined}>
                {o.name || o.email || "—"}
              </span>
            );
          case "status":
            return (
              <span className="inline-flex items-center gap-1.5">
                <StatusBadge status={o.status} />
                {o.status === "sync_failed" && o.sync_error && (
                  <span className="hidden max-w-40 truncate text-xs text-danger lg:inline" title={o.sync_error}>
                    {o.sync_error}
                  </span>
                )}
              </span>
            );
          case "payment_method":
            return <span className="text-xs uppercase text-fg-muted">{o.payment_method}</span>;
          case "total":
            return <span className="font-medium">{inr(o.total)}</span>;
          case "created_at":
            return <span className="whitespace-nowrap text-xs text-fg-muted">{when(o.created_at)}</span>;
          case "open":
            return (
              <button
                type="button"
                aria-label={`Open order ${o.id}`}
                onClick={() => router.push(`/admin/orders/${o.id}`)}
                className="rounded p-1 text-fg-subtle focus-ring hover:text-fg"
              >
                <ChevronRight size={15} aria-hidden />
              </button>
            );
          default:
            return o[col.key];
        }
      }}
    />
  );
}

function ReturnsList({ returns, onChanged }) {
  const toast = useToast();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(null); // {id, action, label}
  const open = returns.filter((r) => ["requested", "approved"].includes(r.status));
  const closed = returns.filter((r) => !["requested", "approved"].includes(r.status));

  async function decide(id, action, noteText) {
    const res = await fetch("/api/admin/returns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, note: noteText }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Request failed");
    toast.success(`Return ${json.status} — ${json.moneyNote || "no money moved"}`);
    setNote("");
    onChanged();
    router.refresh();
  }

  const Row = ({ r, actions }) => (
    <li className="rounded-card border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={r.status} />
        <Link href={`/admin/orders/${r.order_id}`} className="rounded font-mono text-xs font-medium focus-ring hover:underline">
          {r.order_id}
        </Link>
        <span className="text-xs text-fg-subtle">{new Date(r.created_at).toLocaleDateString("en-IN")}</span>
        <span className="ml-auto text-xs text-fg-muted">
          {inr(r.total)}
          {Number(r.refunded_total) > 0 && <span className="text-danger"> · {inr(r.refunded_total)} refunded</span>}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-fg-muted">“{r.reason}”</p>
      {r.note && <p className="mt-0.5 text-xs text-fg-subtle">Note: {r.note}</p>}
      {actions && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input placeholder="Note to the shopper (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="max-w-xs" />
          {r.status === "requested" && (
            <Button size="sm" variant="primary" onClick={() => setConfirm({ id: r.id, action: "approve", label: "Approve return" })}>
              Approve
            </Button>
          )}
          {r.status === "approved" && (
            <Button size="sm" variant="primary" onClick={() => setConfirm({ id: r.id, action: "complete", label: "Mark received" })}>
              Mark received
            </Button>
          )}
          <Button size="sm" variant="dangerOutline" onClick={() => setConfirm({ id: r.id, action: "reject", label: "Reject return" })}>
            Reject
          </Button>
        </div>
      )}
    </li>
  );

  return (
    <div>
      <Banner tone="info" className="mb-4">
        Approving authorizes the physical return only — it moves <strong>no money</strong>. Refund through the provider as usual; the order
        mirrors it automatically.
      </Banner>
      {open.length === 0 ? (
        <EmptyState title="No open return requests" body="Shopper requests from their account pages appear here." />
      ) : (
        <ul className="space-y-3">
          {open.map((r) => (
            <Row key={r.id} r={r} actions />
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer rounded text-xs text-fg-muted focus-ring">Resolved ({closed.length})</summary>
          <ul className="mt-3 space-y-3">
            {closed.map((r) => (
              <Row key={r.id} r={r} />
            ))}
          </ul>
        </details>
      )}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.label}
        tone={confirm?.action === "reject" ? "danger" : "primary"}
        confirmLabel={confirm?.label}
        body={
          confirm?.action === "approve"
            ? "The shopper is told to send the items back. No refund happens here — money moves only through the provider."
            : confirm?.action === "complete"
              ? "Marks the return as received. Refund via the provider if due — the order will mirror it."
              : "The shopper sees the rejection and your note."
        }
        onConfirm={() => decide(confirm.id, confirm.action, note)}
      />
    </div>
  );
}

export default function OrdersAdmin({ initial, initialReturns }) {
  const [view, setView] = useState("orders");
  const [orders, setOrders] = useState(initial.orders);
  const [counts, setCounts] = useState(initial.counts);
  const [returns, setReturns] = useState(initialReturns || []);
  const [nextBefore, setNextBefore] = useState(initial.nextBefore);
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  async function load({ statusArg = status, qArg = q, before = null, append = false } = {}) {
    append ? setLoadingMore(true) : setBusy(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (statusArg !== "all") p.set("status", statusArg);
      if (qArg.trim()) p.set("q", qArg.trim());
      if (before) p.set("before", before);
      const res = await fetch(`/api/admin/orders?${p}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Couldn't load orders (${res.status})`);
      setOrders(append ? [...orders, ...data.orders] : data.orders);
      setCounts(data.counts);
      setNextBefore(data.nextBefore);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
      setLoadingMore(false);
    }
  }

  async function reloadReturns() {
    const data = await fetch("/api/admin/returns").then((r) => r.json()).catch(() => null);
    if (data?.ok) setReturns(data.returns);
  }

  const openReturns = returns.filter((r) => ["requested", "approved"].includes(r.status)).length;

  return (
    <div>
      <Tabs
        label="Orders views"
        items={[
          { id: "orders", label: "Orders", count: counts.all ?? orders.length },
          { id: "returns", label: "Returns", count: openReturns || undefined },
        ]}
        active={view}
        onChange={setView}
        className="mb-4"
      />

      {view === "returns" ? (
        <ReturnsList returns={returns} onChanged={reloadReturns} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Tabs
              label="Order status filter"
              items={STATUS_TABS.map((s) => ({ id: s, label: s === "all" ? "All" : humanizeStatus(s), count: s === "all" ? counts.all : counts[s] || 0 }))}
              active={status}
              onChange={(s) => {
                setStatus(s);
                load({ statusArg: s });
              }}
              className="border-b-0"
            />
            <form
              className="relative"
              onSubmit={(e) => {
                e.preventDefault();
                load();
              }}
            >
              <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <Input
                type="search"
                aria-label="Search orders"
                placeholder="Order id, email or phone"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-64 pl-8"
              />
            </form>
          </div>

          {error && (
            <Banner tone="danger" className="mb-3" actions={<Button size="sm" onClick={() => load()}>Retry</Button>}>
              {error}
            </Banner>
          )}

          <div className="rounded-card border border-edge bg-surface px-4 py-1 shadow-card">
            <OrdersTable
              orders={orders}
              loading={busy}
              filtered={status !== "all" || q.trim() !== ""}
              onClear={() => {
                setStatus("all");
                setQ("");
                load({ statusArg: "all", qArg: "" });
              }}
            />
          </div>

          {nextBefore && !busy && (
            <div className="mt-3 text-center">
              <Button busy={loadingMore} onClick={() => load({ before: nextBefore, append: true })}>
                Load older orders
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
