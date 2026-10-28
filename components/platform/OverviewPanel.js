"use client";

import { useEffect, useState } from "react";

// Platform overview + fleet releases/migrations (S42 / OP02 + OP06). Stale or
// partial coverage is EXPLICIT — unreachable tenants are listed as "no data",
// never silently folded into totals.
const inr = (v) => `₹${Math.round(v).toLocaleString("en-IN")}`;

export default function OverviewPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch("/api/platform/overview")
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) return <p className="mt-4 text-sm text-red-600">overview: {err}</p>;
  if (!data) return <p className="mt-4 text-sm text-zinc-400">Loading fleet overview…</p>;

  return (
    <section className="mt-6 rounded-2xl border border-zinc-200 p-5">
      <h2 className="text-sm font-bold">Fleet</h2>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        <span className="rounded-xl bg-zinc-50 px-3 py-2">
          <span className="font-bold">{data.counts.active}</span> active{data.counts.suspended ? ` · ${data.counts.suspended} suspended` : ""}
        </span>
        <span className="rounded-xl bg-zinc-50 px-3 py-2">
          30d GMV <span className="font-bold">{inr(data.revenue30d.net)}</span> · {data.revenue30d.orders} orders
          <span className="ml-1 text-xs text-zinc-400">({data.revenue30d.covered_tenants} tenant{data.revenue30d.covered_tenants === 1 ? "" : "s"} covered)</span>
        </span>
        <span className="rounded-xl bg-zinc-50 px-3 py-2">
          MRR <span className="font-bold">{inr(data.mrr / 100)}</span>
        </span>
      </div>
      {data.revenue30d.uncovered.length > 0 && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          No data from: {data.revenue30d.uncovered.map((u) => `${u.tenant} (${u.error})`).join(" · ")} — totals EXCLUDE these.
        </p>
      )}

      <h3 className="mt-5 text-xs font-bold uppercase tracking-wide text-zinc-400">Releases & migrations (repo head: {data.repoMigrationHead})</h3>
      <table className="mt-2 w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-zinc-400">
            <th className="py-1 pr-3">Tenant</th>
            <th className="py-1 pr-3">Migrations</th>
            <th className="py-1 pr-3">Live release</th>
            <th className="py-1">Kit</th>
          </tr>
        </thead>
        <tbody>
          {data.fleet.map((t) => (
            <tr key={t.tenant} className="border-t border-zinc-100">
              <td className="py-1.5 pr-3 font-medium">
                {t.tenant}
                {t.status !== "active" && <span className="ml-1 text-[10px] text-zinc-400">({t.status})</span>}
              </td>
              <td className="py-1.5 pr-3">
                {!t.reachable ? (
                  <span className="text-xs text-red-600">unreachable</span>
                ) : t.behind ? (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">BEHIND ({t.migrationHead})</span>
                ) : (
                  <span className="text-xs text-lime-700">current ✓</span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-xs text-zinc-500">
                {!t.reachable ? "—" : t.release ? `${t.release.hash} · ${new Date(t.release.published_at).toLocaleDateString("en-IN")}` : "pre-first-publish (drafts serve)"}
              </td>
              <td className="py-1.5 font-mono text-xs text-zinc-500">{t.reachable ? t.kit : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-zinc-400">
        Migrations roll out via <code>pnpm tenant:migrate -- --all --canary &lt;slug&gt;</code>: the canary migrates first and a canary failure pauses the whole rollout.
      </p>
    </section>
  );
}
