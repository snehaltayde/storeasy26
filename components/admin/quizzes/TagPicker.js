"use client";

import { useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { QUIZ_LIMITS } from "@/lib/quiz-rules";

// The catalog tags one answer points to (Phase 2 line 10). Picked from the
// store's own tags (GET /api/admin/quiz?view=tags: Shopify's tags, the ones a
// quiz scores on), each with how many products carry it; up to 5. A tag no
// product carries any more stays listed with "no products" so the founder
// sees why it matches nothing. readOnly (support, or a quiz the role can't
// change): the tags as badges, no picker.
//   value: string[]; tags: [{ tag, products, inStock }]; onChange(next)
const countWords = (t) => (t ? `${t.products} ${t.products === 1 ? "product" : "products"}` : "no products");

export function TagPicker({ value, tags, onChange, label, readOnly = false }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const byTag = new Map(tags.map((t) => [t.tag, t]));
  const needle = q.trim().toLowerCase();
  const shown = (needle ? tags.filter((t) => t.tag.includes(needle)) : tags).slice(0, 50);
  const full = value.length >= QUIZ_LIMITS.tags;
  const toggle = (tag) => onChange(value.includes(tag) ? value.filter((x) => x !== tag) : full ? value : [...value, tag]);

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-quiz-tags>
      {value.length === 0 && <span className="text-xs text-muted-foreground">{readOnly ? "No tags" : "No tags yet: this answer adds nothing to the score."}</span>}
      {value.map((tag) => (
        <Badge key={tag} variant={byTag.has(tag) ? "secondary" : "warning"} className="gap-1 font-mono" title={countWords(byTag.get(tag))}>
          {tag}
          <span className="border-l border-current/25 pl-1 font-sans text-[0.7rem] opacity-80">{countWords(byTag.get(tag))}</span>
          {!readOnly && (
            <button type="button" aria-label={`Remove tag ${tag} from ${label}`} className="-mr-1 rounded-sm opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => toggle(tag)}>
              <X aria-hidden className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      {!readOnly && (
        <Popover open={open} onOpenChange={(v) => (setOpen(v), v || setQ(""))}>
          <PopoverTrigger asChild>
            <Button type="button" size="xs" variant="outline" disabled={full} aria-label={`Add a tag to ${label}`}>
              <Plus aria-hidden /> {full ? `${QUIZ_LIMITS.tags} tags at most` : "Tag"}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2">
            <Input type="search" autoFocus aria-label="Search your catalog's tags" placeholder="Search tags" value={q} onChange={(e) => setQ(e.target.value)} className="mb-2 h-8" />
            {tags.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">Your products have no tags yet. Add tags to them in Shopify, then sync the catalog.</p>
            ) : shown.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">No tag matches “{q.trim()}”.</p>
            ) : (
              <ul className="max-h-64 space-y-0.5 overflow-y-auto" aria-label="Catalog tags">
                {shown.map((t) => {
                  const on = value.includes(t.tag);
                  return (
                    <li key={t.tag}>
                      <button
                        type="button"
                        aria-pressed={on}
                        disabled={!on && full}
                        onClick={() => toggle(t.tag)}
                        className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 pointer-coarse:min-h-10", on && "bg-muted")}
                      >
                        <Check aria-hidden className={cn("size-3.5 shrink-0", !on && "invisible")} />
                        <span className="min-w-0 flex-1 truncate font-mono">{t.tag}</span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{t.products}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
