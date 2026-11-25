"use client";

import { Gift, Layers, PackagePlus, Tag } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { OFFER_KINDS, OFFER_TYPE_NAMES } from "@/lib/offers/plain";

// The first step of a new offer: its kind (OFFER_KINDS, in the founder's
// words). Arrow keys move between kinds (RadioGroup). Once saved, the kind is
// fixed and shown as words. Each kind carries an icon so the four read apart
// at a glance; the chosen one takes the accent border and a faint accent tint.
const ICONS = { BXGY: PackagePlus, TIERED_QTY: Layers, FREE_GIFT: Gift, COUPON: Tag };

export function OfferKindPicker({ type, onChange, fixed = false }) {
  if (fixed) {
    const Icon = ICONS[type];
    return (
      <p className="flex items-center gap-2 text-sm text-foreground">
        {Icon && <Icon aria-hidden className="size-4 text-muted-foreground" />}
        {OFFER_TYPE_NAMES[type] || type}
      </p>
    );
  }
  return (
    <RadioGroup value={type || ""} onValueChange={onChange} aria-label="Kind of offer" className="grid gap-2 sm:grid-cols-2">
      {OFFER_KINDS.map((k) => {
        const Icon = ICONS[k.type];
        return (
          <Label
            key={k.type}
            htmlFor={`kind-${k.type}`}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 font-normal transition-colors hover:border-muted-foreground/40 has-focus-visible:ring-2 has-focus-visible:ring-ring has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 motion-reduce:transition-none"
          >
            <RadioGroupItem id={`kind-${k.type}`} value={k.type} className="mt-0.5 focus-visible:ring-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{k.name}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{k.hint}</span>
            </span>
            {Icon && <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
          </Label>
        );
      })}
    </RadioGroup>
  );
}
