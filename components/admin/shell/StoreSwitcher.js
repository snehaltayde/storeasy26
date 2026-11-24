"use client";

import { ChevronsUpDown, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { switcherItems } from "@/lib/admin/nav";

// The store switcher (Phase 0 line 8): the caller's own stores from the
// server (listMyStores), shown even with one. Choosing another store loads
// that store's console on its own host (sessions are tenant-bound).
export function StoreSwitcher({ stores, current }) {
  const items = switcherItems(stores, current);
  const storeRows = items.filter((i) => i.kind === "store");
  const here = storeRows.find((s) => s.current) || storeRows[0];
  const link = items.find((i) => i.kind === "link");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" data-shell-control="switcher" className="h-9 max-w-64 gap-2 px-2 text-sm font-medium" aria-label={`Store: ${here.name}. Switch store`}>
          <span className="truncate">{here.name}</span>
          <ChevronsUpDown aria-hidden className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Your stores</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={here.id}
          onValueChange={(id) => {
            const to = storeRows.find((s) => s.id === id);
            if (to && !to.current && to.url) window.location.assign(to.url);
          }}
        >
          {storeRows.map((s) => (
            <DropdownMenuRadioItem key={s.id} value={s.id} data-store={s.id} className="flex-col items-start gap-0">
              <span className="truncate font-medium">{s.name}</span>
              {s.role && <span className="text-xs text-muted-foreground">{s.role}</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={link.href} target="_blank" rel="noreferrer" data-switcher-link="storefront">
            <ExternalLink aria-hidden />
            {link.text}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
