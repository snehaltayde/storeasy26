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
      <Input type="search" placeholder="Find a product" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a product" />
      <p className="text-xs text-muted-foreground">
        {selected.length} of {max} chosen
      </p>
      <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
        {shown.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={selected.includes(p.id)} disabled={!selected.includes(p.id) && selected.length >= max} onCheckedChange={() => toggle(p.id)} data-copilot-product={p.handle} />
              <span className="truncate">{p.title}</span>
            </label>
          </li>
        ))}
        {!shown.length ? <li className="text-sm text-muted-foreground">No products match.</li> : null}
      </ul>
    </div>
  );
}
