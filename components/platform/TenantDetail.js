"use client";

import { useEffect, useState } from "react";

// Tenant detail (S41 / OP03): lifecycle, config summary, secrets as a
// PRESENCE map (values never leave the encrypted envelope), billing
// snapshot, onboarding progress, provisioning history — inline under the
// registry row.
export default function TenantDetail({ id }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch(`/api/platform/tenants/${id}`)
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  }, [id]);

  if (err) return <p className="mt-2 text-xs text-red-600">{err}</p>;
  if (!data) return <p className="mt-2 text-xs text-zinc-400">Loading detail…</p>;

  const t = data.tenant;
  const billing = t.config.billing;

  return (
    <div className="mt-3 grid gap-3 rounded-xl bg-zinc-50 p-3 text-xs sm:grid-cols-2">
      <div>
        <p className="font-bold text-zinc-600">Config</p>
        <p className="mt-1 text-zinc-500">
          shop: {t.config.shop_domain || "—"} · site: {t.config.site_name || "—"} · checkout: {t.config.checkout_mode}
          {t.config.theme ? ` · kit: ${t.config.theme.kit} v${t.config.theme.version}` : ""}
        </p>
        <p className="mt-2 font-bold text-zinc-600">Credentials (presence only)</p>
        <p className="mt-1 flex flex-wrap gap-1">
          {Object.keys(t.secretsPresent).length === 0 && <span className="text-zinc-400">none</span>}
          {Object.keys(t.secretsPresent).map((k) => (
            <span key={k} className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-600">
              {k} ✓
            </span>
          ))}
        </p>
      </div>
      <div>
        <p className="font-bold text-zinc-600">Billing</p>
        <p className="mt-1 text-zinc-500">
          {billing ? `${billing.plan} v${billing.plan_version} · ${billing.status}${billing.grace_until ? ` · grace until ${new Date(billing.grace_until).toLocaleDateString("en-IN")}` : ""}` : "no subscription (free limits)"}
        </p>
        <p className="mt-2 font-bold text-zinc-600">Onboarding</p>
        {data.onboarding ? (
          <p className="mt-1 text-zinc-500">
            {data.onboarding.doneCount}/{data.onboarding.total} {data.onboarding.launched ? "· LAUNCHED 🚀" : ""}
            <span className="mt-1 flex flex-wrap gap-1">
              {data.onboarding.items.map((i) => (
                <span key={i.id} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${i.done ? "bg-lime-100 text-lime-700" : "bg-white text-zinc-400"}`}>
                  {i.id}
                </span>
              ))}
            </span>
          </p>
        ) : (
          <p className="mt-1 text-zinc-400">unavailable (tenant DB unreachable)</p>
        )}
      </div>
      {data.runs.length > 0 && (
        <div className="sm:col-span-2">
          <p className="font-bold text-zinc-600">Provisioning history</p>
          {data.runs.map((r) => (
            <p key={r.id} className="mt-1 text-zinc-500">
              <span className="font-mono text-[10px]">{r.id}</span> · {r.status} · {r.steps.filter((s) => s.status === "done").length}/{r.steps.length} steps
              {r.error ? <span className="text-red-500"> · {r.error}</span> : ""}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
