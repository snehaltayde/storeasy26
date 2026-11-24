"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { SyncProgressBody, readSync, requestSync, POLL_MS } from "@/components/admin/SyncProgress";
import FirstRun from "@/components/admin/first-run/FirstRun";

// The four onboarding step panels (Phase 1 line 3). Each shows what the step
// model (lib/onboarding/steps.js) says about the step and wires only what the
// console can do today; lines 4–7 rebuild each one. A control the role can't
// use is shown disabled with the model's reason under it (the RoleGate
// pattern), never hidden and never refused after a click. After anything here
// saves, onChange() re-reads the steps.
//   Connect  ./ConnectPanel (line 4): the address, Connect through Shopify's
//            approval, the errors; nothing is written to Shopify
//   Import   SyncProgress's own body, readSync and requestSync (/api/admin/sync)
//   Brand    FirstRun (the starter store and BrandStep at #brand), legacy styled
//   Open     OpenStepPanel.js (line 7): every opening item with its fix,
//            and the editor's own publish flow in a dialog

export const POLICY_START_URL = "/api/admin/policy-start";
export const ONBOARDING_URL = "/api/admin/onboarding";
export const PANEL_WORDS = Object.freeze({
  failed: "That didn't work, so nothing changed. Try again in a minute.",
  notAllowed: "Your role can't do that, so nothing changed.",
  shopDomain: "Your Shopify store",
  noDomain: "No Shopify store recorded yet.",
  products: (n) => (n === 1 ? "1 product is in your store." : `${n} products are in your store.`),
});

const actionOf = (step, id) => step.actions?.find((a) => a.id === id) || null;

async function post(url, body) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) || {};
    return { ok: res.ok && json.ok !== false, status: res.status, body: json };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}
const errorWords = (r) => (typeof r.body?.error === "string" && r.body.error ? r.body.error : r.status === 403 ? PANEL_WORDS.notAllowed : PANEL_WORDS.failed);

// A control the role may or may not use. Not allowed: disabled, with the
// reason under it (and read by screen readers with the button).
export function Gated({ action, children, reasonId, ...props }) {
  if (!action) return null;
  if (action.allowed) return <Button {...props}>{children}</Button>;
  return (
    <span className="inline-flex flex-col items-start gap-1" data-onboarding="gated">
      <Button {...props} disabled aria-describedby={reasonId} onClick={undefined}>
        {children}
      </Button>
      <span id={reasonId} className="text-xs text-muted-foreground" data-onboarding="reason">
        {action.reason}
      </span>
    </span>
  );
}

function Notice({ tone = "danger", children }) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <p role={tone === "danger" ? "alert" : undefined} className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", tone === "danger" ? "bg-danger/10 text-danger" : tone === "warning" ? "bg-warning/10 text-warning-text" : "bg-success/10 text-success")}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// ---- Connect ---------------------------------------------------------------
// Phase 1 line 4: the panel lives in ./ConnectPanel (it reads ?shop and ?connect_error itself).
export { ConnectPanel } from "./ConnectPanel";

// ---- Import ----------------------------------------------------------------
const LIVE = new Set(["running", "retrying"]);

export function ImportPanel({ step, onChange, pollMs = POLL_MS }) {
  const [view, setView] = useState(step.facts?.sync || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const was = useRef(view?.state);
  // a fresh read of the steps brings a fresh sync view
  const fresh = JSON.stringify(step.facts?.sync || null);
  useEffect(() => setView(step.facts?.sync || null), [fresh]);

  useEffect(() => {
    if (view && view.state !== was.current) {
      const before = was.current;
      was.current = view.state;
      if (before && LIVE.has(before) !== LIVE.has(view.state)) onChange?.();
    }
    if (!view || !LIVE.has(view.state)) return undefined;
    const timer = setTimeout(async () => {
      const next = await readSync().catch(() => null);
      setView(next || ((v) => ({ ...v })));
    }, pollMs);
    return () => clearTimeout(timer);
  }, [view]);

  async function act(body) {
    setBusy(true);
    setError(null);
    const res = await requestSync(body);
    if (res.ok && res.sync) setView(res.sync);
    else if (!res.ok) setError(res.error);
    setBusy(false);
  }

  const syncAction = actionOf(step, "retry_sync") || actionOf(step, "start_sync");
  const blocked = step.state === "blocked";
  return (
    <div className="space-y-3">
      {step.state === "done" && typeof step.facts?.products === "number" && step.facts.products > 0 && <p className="text-sm text-foreground">{PANEL_WORDS.products(step.facts.products)}</p>}
      {view && !blocked && (
        <div data-legacy className="contents">
          <div data-onboarding="sync">
            <SyncProgressBody view={view} busy={busy} error={error} canRun={Boolean(syncAction?.allowed)} showStart={step.state === "done"} onRetry={() => act({ retry: true })} onStart={() => act({})} />
          </div>
        </div>
      )}
      {syncAction && !syncAction.allowed && !blocked && (
        <Gated action={syncAction} reasonId="import-reason" variant="outline">
          {syncAction.id === "retry_sync" ? "Try again" : view?.state === "none" || !view ? "Bring in products" : "Refresh from Shopify"}
        </Gated>
      )}
    </div>
  );
}

// ---- Brand -----------------------------------------------------------------
export function BrandPanel({ step, canSync, onChange }) {
  if (step.state === "blocked" || (step.problem && !step.actions?.length)) return null;
  const edit = actionOf(step, "brand_save");
  return (
    <div className="space-y-3">
      {edit && !edit.allowed && (
        <p className="text-xs text-muted-foreground" data-onboarding="reason">
          {edit.reason}
        </p>
      )}
      <div data-legacy className="contents">
        <div data-onboarding="brand">
          <FirstRun canEdit={Boolean(edit?.allowed)} canSync={canSync} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

// ---- Open ------------------------------------------------------------------
// Phase 1 line 7: step 4 has its own file.
export { default as OpenPanel } from "./OpenStepPanel";
