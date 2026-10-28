"use client";

import { useEffect, useState } from "react";

// Store switcher (S41 / MC03). Renders nothing unless the signed-in user has
// VERIFIED memberships in more than one store. Switching navigates to that
// store's console on its own host — sessions stay tenant-bound.
export default function StoreSwitcher() {
  const [stores, setStores] = useState([]);

  useEffect(() => {
    fetch("/api/admin/stores")
      .then((r) => r.json())
      .then((j) => j.ok && setStores(j.stores || []))
      .catch(() => {});
  }, []);

  if (stores.length < 2) return null;

  return (
    <select
      aria-label="Switch store"
      value={stores.find((s) => s.current)?.id || ""}
      onChange={(e) => {
        const target = stores.find((s) => s.id === e.target.value);
        if (target && !target.current) window.location.href = target.url;
      }}
      className="w-full rounded-ctl border border-edge bg-surface px-2 py-1.5 text-xs font-medium text-fg-muted focus-ring"
    >
      {stores.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name} ({s.role})
        </option>
      ))}
    </select>
  );
}
