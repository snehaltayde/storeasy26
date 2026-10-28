"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Table } from "@/components/console/Table";
import { SkeletonText, ErrorState, EmptyState } from "@/components/console/bits";

// Operator theme registry panel (S37 / OP07, redesigned S50): kit catalog +
// per-tenant pins. Read-only by design — pins change only in each tenant's
// own console.
const PIN_COLUMNS = [
  { key: "id", header: "Tenant" },
  { key: "kit", header: "Kit" },
  { key: "pin", header: "Pin" },
  { key: "applied", header: "Applied", align: "right" },
];

export default function ThemesPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    fetch("/api/platform/themes")
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card id="themes">
      <CardHeader
        title="Theme kits"
        description="Pins are explicit and never overwritten from here — a kit change happens in the tenant's own console, draft-until-publish."
      />
      {err && <ErrorState title="Couldn't load theme kits" detail={err} onRetry={load} />}
      {!data && !err && <SkeletonText lines={3} />}
      {data && (
        <>
          {data.kits.length === 0 ? (
            <EmptyState title="No theme kits registered" body="Kits appear here once the registry has entries." />
          ) : (
            <ul className="flex flex-wrap gap-2">
              {data.kits.map((k) => (
                <li key={k.id} className="rounded-ctl border border-edge bg-surface-sunken px-3 py-2 text-xs">
                  <span className="font-semibold text-fg">{k.label}</span> v{k.version}{" "}
                  <span className="text-fg-subtle">
                    · {k.vertical} · {k.schema_range}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Table
            className="mt-4"
            columns={PIN_COLUMNS}
            rows={data.tenants}
            rowKey={(t) => t.id}
            empty={<EmptyState title="No tenants yet" body="Per-tenant kit pins appear here once tenants exist." />}
            renderCell={(t, col) => {
              switch (col.key) {
                case "id":
                  return <span className="font-medium">{t.id}</span>;
                case "pin":
                  return (
                    <span className="inline-flex items-center gap-2">
                      {t.pinned ? <span className="font-mono text-xs">v{t.version}</span> : <span className="text-xs text-fg-subtle">implicit default</span>}
                      {t.upgradeAvailable && <Badge tone="warning">Upgrade available</Badge>}
                    </span>
                  );
                case "applied":
                  return (
                    <span className="text-xs text-fg-subtle">
                      {t.applied_at ? new Date(t.applied_at).toLocaleString("en-IN", { day: "numeric", month: "short" }) : "—"}
                    </span>
                  );
                default:
                  return t[col.key];
              }
            }}
          />
        </>
      )}
    </Card>
  );
}
