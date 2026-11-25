"use client";

// Phase 3 line 6: the Themes tab (was ThemesPanel). The theme kits in the code
// and every store's pin: the kit and version its last design publish put live,
// or the platform default when it has none. Read only: a pin changes only when
// the store's own team publishes a look (versions are never overwritten here).
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { LoadError, opsGet, when } from "./opsShared";

export default function Themes() {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, data: await opsGet("themes") });
    } catch (e) {
      setState((s) => ({ loading: false, error: String(e?.message || e), data: s.data }));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const data = state.data;
  const loading = !data && state.loading;
  const kitColumns = [
    { key: "label", header: "Kit", cell: (k) => k.label || k.id },
    { key: "id", header: "Id", cell: (k) => <span className="font-mono text-xs">{k.id}</span> },
    { key: "version", header: "Version", align: "right", cell: (k) => <span className="font-mono tabular-nums">v{k.version}</span> },
    { key: "vertical", header: "For", cell: (k) => k.vertical || "—" },
    { key: "schema_range", header: "Blocks" },
  ];
  const storeColumns = [
    { key: "id", header: "Store" },
    { key: "status", header: "Store state", cell: (t) => <Badge variant={t.status === "active" ? "success" : "muted"}>{t.status === "active" ? "Active" : t.status}</Badge> },
    { key: "kit", header: "Kit", cell: (t) => <span className="font-mono text-xs">{t.kit}</span> },
    { key: "version", header: "Pinned version", cell: (t) => (t.pinned ? <span className="font-mono tabular-nums">v{t.version}</span> : <span className="text-muted-foreground">Platform default</span>) },
    {
      key: "package",
      header: "Uploaded theme",
      cell: (t) =>
        t.package ? (
          <span data-ops-theme-package={t.package.id}>
            {t.package.name || t.package.slug || "Uploaded theme"} {t.package.version ? <span className="font-mono tabular-nums">{t.package.version}</span> : null} <span className="font-mono text-xs text-muted-foreground">{t.package.id}</span>
          </span>
        ) : (
          "—"
        ),
    },
    { key: "applied_at", header: "Published", cell: (t) => when(t.applied_at) },
    { key: "upgradeAvailable", header: "Newer version", cell: (t) => (t.upgradeAvailable ? <Badge variant="info">Available</Badge> : "—") },
  ];

  return (
    <section aria-labelledby="ops-themes-title" className="space-y-4" data-ops-tab="themes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="ops-themes-title" className="text-base font-semibold">
            Themes
          </h2>
          <p className="text-sm text-muted-foreground">Which look each store has live, and the uploaded theme it uses, if any. Only the store&apos;s own team changes it, by publishing a design.</p>
        </div>
        <Button size="sm" variant="outline" disabled={state.loading} onClick={load}>
          <RefreshCw aria-hidden /> Refresh
        </Button>
      </div>
      {state.error && <LoadError what="themes" error={state.error} onRetry={load} />}
      {(data || loading) && (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Kits</h3>
            <DataTable label="Theme kits" columns={kitColumns} rows={data?.kits || []} loading={loading} skeletonRows={2} empty={<EmptyState title="No theme kits in this build." />} />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Store pins</h3>
            <DataTable label="Store theme pins" columns={storeColumns} rows={data?.tenants || []} loading={loading} empty={<EmptyState title="No stores yet." />} />
          </div>
        </>
      )}
    </section>
  );
}
