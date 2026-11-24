"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Button } from "@/components/console/Button";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { DangerDialog } from "@/components/console/Dialog";
import { SecretReveal } from "@/components/console/Copy";
import { SkeletonText, ErrorState, EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Provisioning runs panel (S41 / OP04, redesigned S50): per-step state, safe
// resume of failed runs (steps are idempotent — no duplicate resources),
// conservative compensation. Done runs are history, not buttons.
// Phase 1 line 2: a run a self-serve signup made carries `signup`
// ({ status, failureKind }); resuming it queues the signup's own job.
// Line 9: a store an operator created (signup.source "operator") reads "Created by Storeasy".
const FAILURE_KIND = {
  retry_exhausted: "Gave up after 5 tries",
  needs_operator: "Needs an operator",
  lapsed: "Signup lapsed",
};

export default function ProvisionRunsPanel() {
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null); // run id being resumed
  const [rollingBack, setRollingBack] = useState(null); // run pending typed confirmation
  const [generated, setGenerated] = useState(null); // {run, password}
  const toast = useToast();

  const load = useCallback(() => {
    setErr(null);
    return fetch("/api/platform/provisions")
      .then((r) => r.json())
      .then((j) => (j.ok ? setRuns(j.runs) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function act(action, run) {
    const res = await fetch("/api/platform/provisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, run: run.id }),
    });
    const json = await res.json().catch(() => ({}));
    if (!(res.ok && json.ok)) throw new Error(json.error || `failed (${res.status})`);
    if (json.generated?.admin_password) setGenerated({ run: run.id, password: json.generated.admin_password });
    load();
    return json;
  }

  async function resume(run) {
    setBusy(run.id);
    try {
      const json = await act("resume", run);
      toast.success(json.queued ? `Run ${run.id} queued; the signup's job picks it up` : `Run ${run.id} resumed`);
    } catch (e) {
      toast.error(String(e?.message || e));
    }
    setBusy(null);
  }

  return (
    <Card id="provisioning">
      <CardHeader
        title="Provisioning runs"
        description="Resume re-runs only unfinished steps against real state (no duplicate resources). Roll-back deregisters what a failed run created — databases are never deleted automatically."
      />
      {err && <ErrorState title="Couldn't load provisioning runs" detail={err} onRetry={load} />}
      {!runs && !err && <SkeletonText lines={3} />}
      {generated && (
        <div className="mb-3">
          <SecretReveal label={`Run ${generated.run} finished — console password`} value={generated.password} note="Shown once — hand it to the merchant now." />
        </div>
      )}
      {runs && runs.length === 0 && <EmptyState title="No provisioning runs yet" body="Each store you create with New store, and each self-serve signup, records a resumable run here." />}
      {runs && runs.length > 0 && (
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.id} className="rounded-ctl border border-edge p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-fg">{r.tenant_id}</span>
                <span className="font-mono text-xs text-fg-subtle">{r.id}</span>
                <StatusBadge status={r.status} />
                {r.signup && (
                  <span data-provision-signup={r.signup.status}>
                    <Badge tone="info" title={`${r.signup.source === "operator" ? "Store setup" : "Signup"} ${r.signup.status}`}>
                      {r.signup.source === "operator" ? "Created by Storeasy" : "Self-serve signup"}
                    </Badge>
                  </span>
                )}
                {r.signup?.failureKind && (
                  <span data-provision-failure-kind={r.signup.failureKind}>
                    <StatusBadge status="failed" label={FAILURE_KIND[r.signup.failureKind] || r.signup.failureKind} />
                  </span>
                )}
                <span className="ml-auto text-xs text-fg-subtle">
                  {new Date(r.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {r.steps.map((s) => (
                  <span key={s.name} title={s.detail || undefined}>
                    <StatusBadge status={s.status} label={`${s.name} · ${s.status}`} />
                  </span>
                ))}
              </div>
              {r.error && <p className="mt-1.5 text-xs text-danger">{r.error}</p>}
              {r.status === "failed" && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="primary" busy={busy === r.id} onClick={() => resume(r)}>
                    Resume
                  </Button>
                  <Button size="sm" variant="dangerOutline" disabled={busy === r.id} onClick={() => setRollingBack(r)}>
                    Roll back
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <DangerDialog
        open={!!rollingBack}
        onClose={() => setRollingBack(null)}
        title={`Roll back run ${rollingBack?.id}?`}
        confirmLabel="Roll back"
        typedConfirmation={rollingBack?.id}
        body="Deregisters what this failed run created. The database is never deleted — compensation is deliberately conservative."
        onConfirm={async () => {
          await act("compensate", rollingBack);
          toast.success(`Run ${rollingBack.id} rolled back`);
        }}
      />
    </Card>
  );
}
