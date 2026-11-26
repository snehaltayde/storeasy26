"use client";

import Link from "next/link";
import { Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RoleGate } from "@/components/kit/role-gate";
import { roleAllows } from "@/lib/platform/authz";

// Phase 9 line 1: one review in the queue. Staff and up get the actions for
// its state; support sees the review without its email, order link or reject
// reason (redacted on the server) and no actions (RoleGate hides them).
const HIDE = "hide";
export const STATE_ACTIONS = Object.freeze({
  pending: [["approve", "Approve"], ["reject", "Reject"]],
  approved: [["hide", "Hide"], ["reject", "Reject"]],
  rejected: [["approve", "Approve"]],
  hidden: [["restore", "Restore"]],
});

export function StarsLine({ rating }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} aria-hidden className={`size-4 ${i <= rating ? "fill-warning text-warning" : "text-muted-foreground/40"}`} />
      ))}
    </span>
  );
}

export function ReviewRow({ review: r, role, timeZone, selected, onSelect, onAction, onReply, busy }) {
  const date = new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: timeZone || "UTC" });
  return (
    <li className="flex gap-3 px-3 py-4 sm:px-4" data-review-row={r.id} data-review-status={r.status}>
      {onSelect && roleAllows(role, "reviews.moderate") ? <Checkbox checked={selected} onCheckedChange={(v) => onSelect(r.id, v === true)} aria-label={`Select the review by ${r.name}`} className="mt-1 size-5 md:size-4" /> : null}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StarsLine rating={r.rating} />
          {r.title ? <p className="font-medium text-foreground">{r.title}</p> : null}
        </div>
        <p className="whitespace-pre-line break-words text-sm text-foreground">{r.body}</p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{r.name}</span>
          <Badge variant="success">Verified buyer</Badge>
          <span>·</span>
          {r.productHandle ? (
            <a href={`/products/${r.productHandle}`} target="_blank" rel="noreferrer" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm underline underline-offset-2">
              {r.productTitle}
            </a>
          ) : (
            <span>{r.productTitle}</span>
          )}
          <span>·</span>
          <span>{date}</span>
          {r.orderId ? (
            <>
              <span>·</span>
              <Link href={`/admin/orders/${r.orderId}`} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm underline underline-offset-2" data-review-order="">
                Order
              </Link>
            </>
          ) : null}
          {r.email ? (
            <>
              <span>·</span>
              <span data-review-email="">{r.email}</span>
            </>
          ) : null}
        </p>
        {r.rejectReason ? <p className="text-xs text-muted-foreground">Rejected because: {r.rejectReason}</p> : null}
        {r.reply ? (
          <div className="rounded-md bg-muted p-2 text-sm">
            <p className="text-xs font-medium text-muted-foreground">Your reply</p>
            <p className="whitespace-pre-line">{r.reply}</p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1">
          {(STATE_ACTIONS[r.status] || []).map(([action, label]) => (
            <RoleGate key={action} role={role} action="reviews.moderate" mode={HIDE}>
              <Button size="sm" className="h-11 md:h-7" variant={action === "approve" || action === "restore" ? "default" : "outline"} disabled={busy} onClick={() => onAction(action, [r.id])} data-review-action={action}>
                {label}
              </Button>
            </RoleGate>
          ))}
          <RoleGate role={role} action="reviews.moderate" mode={HIDE}>
            <Button size="sm" className="h-11 md:h-7" variant="ghost" disabled={busy} onClick={() => onReply(r)} data-review-action="reply">
              {r.reply ? "Edit reply" : "Reply"}
            </Button>
          </RoleGate>
        </div>
      </div>
    </li>
  );
}
