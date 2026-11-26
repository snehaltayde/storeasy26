"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

// Up to `max` products for the SEO and FAQ task (Phase 9 line 5). Writers only:
// the page never renders it for a role that can't run the task.
export function ProductPicker({ products, selected, onChange, max = 10 }) {
  const [q, setQ] = useState("");
  const shown = products.filter((p) => !q || p.title.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : selected.length < max ? [...selected, id] : selected);
  return (
    <div className="space-y-2">
      <Input type="search" placeholder="Find a product" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a product" className="h-11 md:h-8" />
      <p className="text-xs tabular-nums text-muted-foreground" role="status">
        {selected.length} of {max} chosen
      </p>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border p-1.5" aria-label="Products">
        {shown.map((p) => (
          <li key={p.id}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-1 text-sm hover:bg-muted md:min-h-8 md:gap-2">
              <Checkbox checked={selected.includes(p.id)} disabled={!selected.includes(p.id) && selected.length >= max} onCheckedChange={() => toggle(p.id)} data-copilot-product={p.handle} />
              <span className="truncate">{p.title}</span>
            </label>
          </li>
        ))}
        {!shown.length ? <li className="px-1 py-2 text-sm text-muted-foreground">{products.length ? "No products match." : "Your catalog has no products yet."}</li> : null}
      </ul>
    </div>
  );
}
