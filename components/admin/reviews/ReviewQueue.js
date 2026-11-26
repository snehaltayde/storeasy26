"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { ReviewRow } from "./ReviewRow";
import { ReplyDialog } from "./ReplyDialog";

// Phase 9 line 1: the review queue. The address holds the state (?status=,
// ?rating=, ?product=), so every tab and filter is a link the server reads.
// Staff and up approve, reject (with an internal reason), hide, restore and
// reply, one at a time or up to 50 at once (Approve and Reject); support reads
// only. Every write is POST /api/admin/reviews, then the page reloads its data.
export const TABS = Object.freeze([
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["hidden", "Hidden"],
]);
const EMPTY = {
  pending: "No reviews are waiting. New reviews from buyers land here first.",
  approved: "No approved reviews yet. Approve a pending review and it shows on your store.",
  rejected: "No rejected reviews.",
  hidden: "No hidden reviews.",
};
const BULK_MAX = 50;

export function reviewsHref({ status = "pending", rating = null, product = null }) {
  const q = new URLSearchParams();
  if (status && status !== "pending") q.set("status", status);
  if (rating) q.set("rating", String(rating));
  if (product) q.set("product", product);
  const s = q.toString();
  return `/admin/reviews${s ? `?${s}` : ""}`;
}
const tabClass = (on) => `-mb-px border-b-2 pb-2 text-sm font-medium ${on ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`;
const chipClass = (on) => `rounded-full border px-3 py-1 text-xs ${on ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`;

export function ReviewQueue({ reviews, counts, products, filters, role, timeZone }) {
  const router = useRouter();
  const toast = useToast();
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(null); // ids
  const [reason, setReason] = useState("");
  const [replying, setReplying] = useState(null);
  const { status, rating, product } = filters;
  const bulkable = status === "pending";

  async function post(body) {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(j.error || "That didn't save. Try again.");
        return null;
      }
      setSelected(new Set());
      router.refresh();
      return j;
    } finally {
      setBusy(false);
    }
  }
  const act = async (action, ids) => {
    if (action === "reject") {
      setReason("");
      setRejecting(ids);
      return;
    }
    const j = await post({ action, ids });
    if (j) toast.success(`${j.changed} ${j.changed === 1 ? "review" : "reviews"} updated.`);
  };
  const onSelect = (id, on) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  return (
    <div className="space-y-4">
      <nav aria-label="Review states" className="flex gap-6 border-b border-border">
        {TABS.map(([key, label]) => (
          <Link key={key} href={reviewsHref({ status: key, rating, product })} data-read-control data-reviews-tab={key} aria-current={status === key ? "page" : undefined} className={tabClass(status === key)}>
            {label} <span className="ml-1 text-xs text-muted-foreground">{counts[key] ?? 0}</span>
          </Link>
        ))}
      </nav>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label="Rating" className="flex flex-wrap gap-2">
          {[null, 5, 4, 3, 2, 1].map((n) => (
            <Link key={n ?? "any"} href={reviewsHref({ status, rating: n, product })} data-read-control aria-current={(rating ?? null) === n ? "page" : undefined} className={chipClass((rating ?? null) === n)}>
              {n ? `${n} ${n === 1 ? "star" : "stars"}` : "Any rating"}
            </Link>
          ))}
        </nav>
        <form method="get" action="/admin/reviews" className="w-full sm:w-64">
          <select
            name="product"
            aria-label="Product"
            defaultValue={product || ""}
            onChange={(e) => router.push(reviewsHref({ status, rating, product: e.target.value || null }))}
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-base md:h-8 md:text-sm"
            data-read-control
          >
            <option value="">Every product</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </form>
      </div>

      {bulkable && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm" data-reviews="bulk-bar">
          <span>{selected.size} selected</span>
          <RoleGate role={role} action="reviews.moderate" mode="hide">
            <Button size="sm" disabled={busy || selected.size > BULK_MAX} onClick={() => act("approve", [...selected])} data-reviews="bulk-approve">
              Approve selected
            </Button>
          </RoleGate>
          <RoleGate role={role} action="reviews.moderate" mode="hide">
            <Button size="sm" variant="outline" disabled={busy || selected.size > BULK_MAX} onClick={() => act("reject", [...selected])} data-reviews="bulk-reject">
              Reject selected
            </Button>
          </RoleGate>
          {selected.size > BULK_MAX ? <span className="text-destructive">Choose at most {BULK_MAX} at a time.</span> : null}
        </div>
      ) : null}

      {reviews.length ? (
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {reviews.map((r) => (
              <ReviewRow key={r.id} review={r} role={role} timeZone={timeZone} busy={busy} selected={selected.has(r.id)} onSelect={bulkable ? onSelect : null} onAction={act} onReply={setReplying} />
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyState title={EMPTY[status] || EMPTY.pending} />
      )}

      <AlertDialog open={!!rejecting} onOpenChange={(o) => !o && setRejecting(null)}>
        <AlertDialogContent data-reviews="reject-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{rejecting?.length > 1 ? `Reject ${rejecting.length} reviews?` : "Reject this review?"}</AlertDialogTitle>
            <AlertDialogDescription>It won't show on your store. The reason is for your team only; the buyer never sees it.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Reason (optional)</Label>
            <Textarea id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={200} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={async () => {
                const ids = rejecting;
                setRejecting(null);
                const j = await post({ action: "reject", ids, reason });
                if (j) toast.success(`${j.changed} ${j.changed === 1 ? "review" : "reviews"} rejected.`);
              }}
              data-reviews="confirm-reject"
            >
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {replying ? (
        <ReplyDialog
          key={replying.id}
          open
          review={replying}
          busy={busy}
          onOpenChange={(o) => !o && setReplying(null)}
          onSave={async (text) => {
            const j = await post({ reply: { id: replying.id, text } });
            if (j) setReplying(null);
          }}
        />
      ) : null}
    </div>
  );
}
