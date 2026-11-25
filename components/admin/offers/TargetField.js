"use client";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { TARGET_CHOICES } from "@/components/admin/offerFormModel";
import { RefCombobox, loadProducts, loadVariants, valueLoader } from "./RefCombobox";

// What a line offer (buy some get some, buy more save more) is for: one
// product, one size or option, products with a tag, products of one type. A
// gift or a code is for the whole cart (the engine has no target for them),
// and the form says so instead of offering a choice.
//   options: { tags, types, collections } from GET /api/admin/offers/targets, or null
//   optionsError: why they did not load; onRetry loads them again
export function TargetField({ form, set, targetLabel, onPicked, options, optionsError, onRetry, disabled = false }) {
  const choice = TARGET_CHOICES.find((c) => c.key === form.choice) || TARGET_CHOICES[0];
  const value = form.target?.value ?? null;
  const pickText = form.target
    ? "Change"
    : form.choice === "tag"
      ? "Choose a tag"
      : form.choice === "type"
        ? "Choose a type"
        : form.choice === "collection"
          ? "Choose a collection"
          : form.choice === "variant"
            ? "Choose a size or option"
            : "Choose a product";
  const pick = (target) => {
    if (target.label) onPicked(target.value, target.label);
    set({ target });
  };

  let picker;
  if (form.choice === "product") {
    picker = <RefCombobox label="The product" buttonText={pickText} disabled={disabled} selectedId={value} load={loadProducts} onPick={(o) => pick({ kind: "productId", value: o.id, label: o.label })} />;
  } else if (form.choice === "variant") {
    picker = <RefCombobox label="The size or option" buttonText={pickText} disabled={disabled} selectedId={value} load={loadVariants} onPick={(o) => pick({ kind: "variantId", value: o.id, label: o.label })} />;
  } else if (optionsError) {
    picker = (
      <p className="text-sm text-destructive">
        {optionsError}{" "}
        <button type="button" onClick={onRetry} disabled={disabled} className="font-medium underline">
          Try again
        </button>
      </p>
    );
  } else if (form.choice === "collection") {
    const list = options?.collections;
    picker = (
      <RefCombobox
        label="The collection"
        buttonText={pickText}
        disabled={disabled || !options}
        selectedId={value}
        emptyText={list?.length === 0 ? "No collections in your store yet. Make one in Shopify, then sync." : "Nothing matches that search."}
        load={valueLoader(list)}
        onPick={(o) => pick({ kind: "collection", value: o.id, label: o.label })}
      />
    );
  } else {
    const list = form.choice === "type" ? options?.types : options?.tags;
    picker = (
      <RefCombobox
        label={form.choice === "type" ? "The product type" : "The tag"}
        buttonText={pickText}
        disabled={disabled || !options}
        selectedId={value}
        emptyText={list?.length === 0 ? "None in your store yet. Add them to your products in Shopify, then sync." : "Nothing matches that search."}
        load={valueLoader(list)}
        onPick={(o) => pick({ kind: form.choice === "type" ? "productType" : "tag", value: o.id })}
      />
    );
  }

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-foreground">What is it for?</legend>
      <RadioGroup value={form.choice} onValueChange={(v) => set({ choice: v })} className="grid gap-2 sm:grid-cols-2" aria-label="What the offer is for" disabled={disabled}>
        {TARGET_CHOICES.map((c) => (
          <Label key={c.key} htmlFor={`target-${c.key}`} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 font-normal has-data-[state=checked]:border-primary">
            <RadioGroupItem id={`target-${c.key}`} value={c.key} />
            {c.label}
          </Label>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">{choice.hint}</p>
      <div className="flex flex-wrap items-center gap-3">
        <span className={targetLabel ? "text-sm font-medium text-foreground" : "text-sm text-muted-foreground"} data-picked="target">
          {targetLabel || "Nothing chosen yet"}
        </span>
        {picker}
      </div>
    </fieldset>
  );
}

export const WholeCart = () => <p className="text-sm text-muted-foreground">It counts the whole cart.</p>;
