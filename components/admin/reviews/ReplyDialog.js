"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Phase 9 line 1: the store's public reply to a review (≤ 1,000 characters).
// Saving empty text removes the reply. The parent posts it (reviews.moderate).
export const REPLY_MAX = 1000;

export function ReplyDialog({ open, onOpenChange, review, onSave, busy }) {
  const [text, setText] = useState(review?.reply || "");
  const over = text.trim().length > REPLY_MAX;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-reviews="reply-dialog">
        <DialogHeader>
          <DialogTitle>{review?.reply ? "Edit your reply" : "Reply to this review"}</DialogTitle>
          <DialogDescription>Shoppers see your reply under the review when Show store replies is on. Leave it empty to remove it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="review-reply">Reply</Label>
          <Textarea id="review-reply" value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={REPLY_MAX + 200} />
          <p className={`text-xs ${over ? "text-destructive" : "text-muted-foreground"}`}>
            {text.trim().length} of {REPLY_MAX} characters
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || over} onClick={() => onSave(text)} data-reviews="save-reply">
            Save reply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
