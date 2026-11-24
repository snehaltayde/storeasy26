"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import FirstRun from "@/components/admin/first-run/FirstRun";
import ImportStep from "./ImportStep";

// The four onboarding step panels (Phase 1 line 3). Each shows what the step
// model (lib/onboarding/steps.js) says about the step and wires only what the
// console can do today; lines 4–7 rebuild each one. A control the role can't
// use is shown disabled with the model's reason under it (the RoleGate
// pattern), never hidden and never refused after a click. After anything here
// saves, onChange() re-reads the steps.
//   Connect  ./ConnectPanel (line 4): the address, Connect through Shopify's
//            approval, the errors; nothing is written to Shopify
//   Import   ImportStep (line 5): live progress, skips, what to do on a failure
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
export function ImportPanel({ step, onChange, onGoStep }) {
  return <ImportStep step={step} onChange={onChange} onChoose={(id) => onGoStep?.(id)} />;
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
