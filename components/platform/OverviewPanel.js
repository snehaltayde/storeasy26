"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { StatusBadge } from "@/components/console/Badge";
import { Table } from "@/components/console/Table";
import { SkeletonText, ErrorState, EmptyState } from "@/components/console/bits";

// Platform overview + fleet releases/migrations (S42 / OP02 + OP06). Stale or
// partial coverage is EXPLICIT — unreachable tenants are listed as "no data",
// never silently folded into totals.
const inr = (v) => `₹${Math.round(v).toLocaleString("en-IN")}`;

const FLEET_COLUMNS = [
  { key: "tenant", header: "Tenant" },
  { key: "migrations", header: "Migrations" },
  { key: "release", header: "Live release" },
  { key: "kit", header: "Kit" },
];

export default function OverviewPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    fetch("/api/platform/overview")
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card id="overview">
      <CardHeader title="Fleet" description="Totals cover reachable tenants only — gaps are listed, never papered over." />
      {err && <ErrorState title="Couldn't load the fleet overview" detail={err} onRetry={load} />}
      {!data && !err && <SkeletonText lines={4} />}
      {data && (
        <>
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="rounded-ctl bg-surface-sunken px-3 py-2">
              <span className="font-semibold tabular-nums">{data.counts.active}</span> active
              {data.counts.suspended ? ` · ${data.counts.suspended} suspended` : ""}
            </span>
            <span className="rounded-ctl bg-surface-sunken px-3 py-2">
              30d GMV <span className="font-semibold tabular-nums">{inr(data.revenue30d.net)}</span> · {data.revenue30d.orders} orders
              <span className="ml-1 text-xs text-fg-subtle">
                ({data.revenue30d.covered_tenants} tenant{data.revenue30d.covered_tenants === 1 ? "" : "s"} covered)
              </span>
            </span>
            <span className="rounded-ctl bg-surface-sunken px-3 py-2">
              MRR <span className="font-semibold tabular-nums">{inr(data.mrr / 100)}</span>
            </span>
          </div>
          {data.revenue30d.uncovered.length > 0 && (
            <Banner tone="warning" className="mt-3">
              No data from: {data.revenue30d.uncovered.map((u) => `${u.tenant} (${u.error})`).join(" · ")} — totals EXCLUDE these.
            </Banner>
          )}

          <h3 className="mt-5 text-xs font-semibold text-fg-muted">Releases &amp; migrations (repo head: {data.repoMigrationHead})</h3>
          <Table
            className="mt-2"
            columns={FLEET_COLUMNS}
            rows={data.fleet}
            rowKey={(t) => t.tenant}
            empty={<EmptyState title="No tenants in the fleet yet" body="Provision a tenant to see releases and migration state here." />}
            renderCell={(t, col) => {
              switch (col.key) {
                case "tenant":
                  return (
                    <span className="font-medium">
                      {t.tenant}
                      {t.status !== "active" && <span className="ml-1 text-[11px] text-fg-subtle">({t.status})</span>}
                    </span>
                  );
                case "migrations":
                  return !t.reachable ? (
                    <StatusBadge status="unreachable" />
                  ) : t.behind ? (
                    <StatusBadge status="stale" label={`Behind (${t.migrationHead})`} />
                  ) : (
                    <StatusBadge status="current" />
                  );
                case "release":
                  return (
                    <span className="text-xs text-fg-muted">
                      {!t.reachable ? "—" : t.release ? `${t.release.hash} · ${new Date(t.release.published_at).toLocaleDateString("en-IN")}` : "pre-first-publish (drafts serve)"}
                    </span>
                  );
                case "kit":
                  return <span className="font-mono text-xs text-fg-muted">{t.reachable ? t.kit : "—"}</span>;
                default:
                  return t[col.key];
              }
            }}
          />
          <p className="mt-3 text-xs text-fg-subtle">
            Migrations roll out via <code className="rounded bg-surface-sunken px-1 font-mono">pnpm tenant:migrate -- --all --canary &lt;slug&gt;</code>:
            the canary migrates first and a canary failure pauses the whole rollout.
          </p>
        </>
      )}
    </Card>
  );
}
