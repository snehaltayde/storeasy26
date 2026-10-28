"use client";

import { useEffect, useState } from "react";

// Operator theme registry panel (S37 / OP07): kit catalog + per-tenant pins.
// Read-only by design — pins change only in each tenant's own console.
export default function ThemesPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch("/api/platform/themes")
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
      <h2 className="text-sm font-bold">Theme kits</h2>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      {!data && !err && <p className="mt-2 text-sm text-zinc-400">Loading…</p>}
      {data && (
        <>
          <ul className="mt-3 flex flex-wrap gap-2">
            {data.kits.map((k) => (
              <li key={k.id} className="rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs">
                <span className="font-bold">{k.label}</span> v{k.version} <span className="text-zinc-400">· {k.vertical} · {k.schema_range}</span>
              </li>
            ))}
          </ul>
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-zinc-400">
                <th className="py-1 pr-3">Tenant</th>
                <th className="py-1 pr-3">Kit</th>
                <th className="py-1 pr-3">Pin</th>
                <th className="py-1">Applied</th>
              </tr>
            </thead>
            <tbody>
              {data.tenants.map((t) => (
                <tr key={t.id} className="border-t border-zinc-100">
                  <td className="py-2 pr-3 font-medium">{t.id}</td>
                  <td className="py-2 pr-3">{t.kit}</td>
                  <td className="py-2 pr-3">
                    {t.pinned ? (
                      <span className="font-mono text-xs">v{t.version}</span>
                    ) : (
                      <span className="text-xs text-zinc-400">implicit default</span>
                    )}
                    {t.upgradeAvailable && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">UPGRADE AVAILABLE</span>}
                  </td>
                  <td className="py-2 text-xs text-zinc-400">{t.applied_at ? new Date(t.applied_at).toLocaleString("en-IN", { day: "numeric", month: "short" }) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-zinc-400">Pins are explicit and never overwritten from here — a kit change happens in the tenant's own console, draft-until-publish.</p>
        </>
      )}
    </section>
  );
}
