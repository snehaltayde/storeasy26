"use client";

import { Check } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { headingFamily } from "@/components/admin/themes/theme-words";
import { BRAND_WORDS } from "./brandModel";

// The Brand step's "Theme" picker (Phase 7 line 1), before Colours: "Keep the
// simple look" and the five Storeasy themes, each a tiny storefront in its own
// header colours, page colours, accent and heading face. Choosing one only
// changes the form (and the preview); Save writes the draft.
//   themes: GET /api/admin/brand-step themes ({ slug, name, vertical, headingFont,
//           sample, brand, surfaces })
//   value: the chosen slug, or null for the simple look
const SIMPLE = "simple";

const itemClass =
  "flex aspect-auto size-auto flex-col items-stretch gap-2 rounded-md border border-border bg-card p-2 text-left text-sm transition-colors not-disabled:hover:border-muted-foreground/40 motion-reduce:transition-none data-[state=checked]:border-primary data-[state=checked]:bg-card data-[state=checked]:text-foreground data-[state=checked]:ring-1 data-[state=checked]:ring-primary";

function Tick() {
  return (
    <span aria-hidden className="hidden size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground group-data-[state=checked]/radio-group-item:flex">
      <Check className="size-3" strokeWidth={3} />
    </span>
  );
}

export default function ThemePicker({ themes = [], value = null, onChange, disabled = false, ...rest }) {
  return (
    <fieldset className={`space-y-2`} data-brand-themes="">
      <legend className="mb-1 text-sm font-medium">{BRAND_WORDS.theme}</legend>
      <p className="mb-2 text-[0.8125rem] text-muted-foreground">{BRAND_WORDS.themeHint}</p>
      <RadioGroup value={value ?? SIMPLE} onValueChange={(v) => onChange?.(v === SIMPLE ? null : v)} disabled={disabled} aria-label={BRAND_WORDS.theme} className="grid-cols-2 sm:grid-cols-3" {...rest}>
        <RadioGroupItem value={SIMPLE} disabled={disabled} aria-label={BRAND_WORDS.simpleLook} data-theme-pick={SIMPLE} className={itemClass}>
          <span aria-hidden className="flex h-20 flex-col justify-end gap-1.5 rounded-sm border border-border bg-background p-2">
            <span className="h-1.5 w-10 rounded-full bg-foreground/70" />
            <span className="h-1.5 w-6 rounded-full bg-muted-foreground/50" />
          </span>
          <span className="flex items-start justify-between gap-2">
            <span className="min-w-0">
              <span className="block font-medium text-foreground">{BRAND_WORDS.simpleLook}</span>
              <span className="block text-xs text-muted-foreground">{BRAND_WORDS.simpleLookHint}</span>
            </span>
            <Tick />
          </span>
        </RadioGroupItem>
        {themes.map((t) => (
          <RadioGroupItem key={t.slug} value={t.slug} disabled={disabled} aria-label={`${t.name}, ${t.vertical}`} data-theme-pick={t.slug} className={itemClass}>
            {/* a tiny storefront: its header, a heading in its own face, an accent button */}
            <span aria-hidden className="flex h-20 flex-col overflow-hidden rounded-sm border" style={{ background: t.brand?.background, borderColor: t.surfaces?.header?.bg }}>
              <span className="h-3 w-full shrink-0" style={{ background: t.surfaces?.header?.bg }} />
              <span className="flex flex-1 flex-col justify-end gap-1.5 p-2">
                <span className="truncate text-sm leading-none" style={{ color: t.brand?.foreground, fontFamily: headingFamily(t.headingFont) }}>
                  {t.name}
                </span>
                <span className="h-3 w-8 rounded-full" style={{ background: t.brand?.accent }} />
              </span>
            </span>
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{t.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{t.vertical}</span>
              </span>
              <Tick />
            </span>
          </RadioGroupItem>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
