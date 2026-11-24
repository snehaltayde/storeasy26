"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Rocket } from "lucide-react";
import { Badge } from "@/components/console/Badge";
import { KeyValue, SkeletonText, ErrorState } from "@/components/console/bits";
import { CopyButton } from "@/components/console/Copy";

// Tenant detail (S41 / OP03, redesigned S50): lifecycle, config summary,
// secrets as a PRESENCE map (values never leave the encrypted envelope),
// billing snapshot, onboarding progress, provisioning history — inline
// under the registry row.
const STEP_STATE_WORDS = { done: "done", in_progress: "in progress", ready: "to do", blocked: "blocked" };

export default function TenantDetail({ id }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    fetch(`/api/platform/tenants/${id}`)
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (err) {
    return (
      <div className="mt-3 rounded-ctl bg-surface-sunken p-3">
        <ErrorState title="Couldn't load tenant detail" detail={err} onRetry={load} className="py-4" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mt-3 rounded-ctl bg-surface-sunken p-3" aria-busy="true" aria-label="Loading tenant detail">
        <SkeletonText lines={3} />
      </div>
    );
  }

  const t = data.tenant;
  const billing = t.config.billing;

  return (
    <div className="mt-3 grid gap-4 rounded-ctl bg-surface-sunken p-4 text-xs sm:grid-cols-2">
      <div>
        <p className="text-xs font-semibold text-fg">Config</p>
        <KeyValue
          className="mt-1.5 text-xs"
          items={[
            { key: "Shop", value: t.config.shop_domain || "—", mono: true },
            { key: "Site", value: t.config.site_name || "—" },
            { key: "Checkout", value: t.config.checkout_mode },
            t.config.theme_pin && { key: "Kit", value: `${t.config.theme_pin.kit} v${t.config.theme_pin.version}`, mono: true },
          ]}
        />
        {data.connect && (
          <div data-tenant="shopify-app">
            <p className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold text-fg">
              Shopify app redirect URLs
              <Badge tone={data.connect.appReady ? "success" : "warning"}>{data.connect.appReady ? "App set up" : "App not set up"}</Badge>
            </p>
            <p className="mt-1 text-fg-subtle">Add each one to this store's Shopify app (App setup, Allowed redirection URLs).</p>
            <ul className="mt-1.5 space-y-1" data-tenant="redirect-urls">
              {data.connect.redirectUrls.length ? (
                data.connect.redirectUrls.map((u) => (
                  <li key={u} className="flex items-center gap-1 rounded-ctl bg-surface pl-2.5">
                    <code className="min-w-0 flex-1 select-all py-1.5 font-mono text-[11px] text-fg [overflow-wrap:anywhere]">{u}</code>
                    <CopyButton value={u} label={`Copy ${u}`} size={12} />
                  </li>
                ))
              ) : (
                <li className="text-fg-subtle">No store domain yet, so there's nothing to add.</li>
              )}
            </ul>
            {!data.connect.appReady && <p className="mt-1.5 text-fg-subtle">Add the app's client id and secret (More, Edit details). Until then the founder sees "Storeasy's team is preparing your Shopify connection" and can't connect.</p>}
          </div>
        )}
        <p className="mt-3 text-xs font-semibold text-fg">Credentials (presence only)</p>
        <p className="mt-1.5 flex flex-wrap gap-1">
          {Object.keys(t.secretsPresent).length === 0 && <span className="text-fg-subtle">none</span>}
          {Object.keys(t.secretsPresent).map((k) => (
            <Badge key={k} tone="success" className="font-mono">
              <Check size={11} aria-hidden />
              {k}
            </Badge>
          ))}
        </p>
      </div>
      <div>
        <p className="text-xs font-semibold text-fg">Billing</p>
        <p className="mt-1.5 text-fg-muted">
          {billing
            ? `${billing.plan} v${billing.plan_version} · ${billing.status}${billing.grace_until ? ` · grace until ${new Date(billing.grace_until).toLocaleDateString("en-IN")}` : ""}`
            : "no subscription (free limits)"}
        </p>
        <p className="mt-3 text-xs font-semibold text-fg">Onboarding</p>
        {data.onboarding ? (
          <div className="mt-1.5 text-fg-muted">
            <span className="inline-flex items-center gap-2">
              {data.onboarding.doneCount}/{data.onboarding.total}
              {data.onboarding.open && (
                <Badge tone="success">
                  <Rocket size={11} aria-hidden />
                  Open
                </Badge>
              )}
            </span>
            <span className="mt-1.5 flex flex-wrap gap-1">
              {data.onboarding.steps.map((s) => (
                <Badge key={s.id} tone={s.state === "done" ? "success" : s.state === "blocked" ? "warning" : "neutral"} title={`${s.label}: ${STEP_STATE_WORDS[s.state] || s.state}`} data-step={s.id} data-state={s.state}>
                  {s.state === "done" && <Check size={11} aria-hidden />}
                  {s.label}
                </Badge>
              ))}
            </span>
          </div>
        ) : (
          <p className="mt-1.5 text-fg-subtle">unavailable (tenant DB unreachable)</p>
        )}
      </div>
      {data.runs.length > 0 && (
        <div className="sm:col-span-2">
          <p className="text-xs font-semibold text-fg">Provisioning history</p>
          {data.runs.map((r) => (
            <p key={r.id} className="mt-1.5 text-fg-muted">
              <span className="font-mono text-[11px]">{r.id}</span> · {r.status} · {r.steps.filter((s) => s.status === "done").length}/
              {r.steps.length} steps
              {r.error ? <span className="text-danger"> · {r.error}</span> : ""}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
