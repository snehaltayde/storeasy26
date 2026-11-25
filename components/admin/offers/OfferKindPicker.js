"use client";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { OFFER_KINDS, OFFER_TYPE_NAMES } from "@/lib/offers/plain";

// The first step of a new offer: its kind (OFFER_KINDS, in the founder's
// words). Arrow keys move between kinds (RadioGroup). Once saved, the kind is
// fixed and shown as words.
export function OfferKindPicker({ type, onChange, fixed = false }) {
  if (fixed) return <p className="text-sm text-foreground">{OFFER_TYPE_NAMES[type] || type}</p>;
  return (
    <RadioGroup value={type || ""} onValueChange={onChange} aria-label="Kind of offer" className="grid gap-2 sm:grid-cols-2">
      {OFFER_KINDS.map((k) => (
        <Label key={k.type} htmlFor={`kind-${k.type}`} className="flex items-start gap-3 rounded-md border border-border p-3 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-muted">
          <RadioGroupItem id={`kind-${k.type}`} value={k.type} className="mt-0.5" />
          <span>
            <span className="block text-sm font-medium text-foreground">{k.name}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{k.hint}</span>
          </span>
        </Label>
      ))}
    </RadioGroup>
  );
}
