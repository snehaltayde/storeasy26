"use client";

// Phase 3 line 6: the Provisioning runs tab (was ProvisionRunsPanel). The last
// 20 runs with each step's state; a failed run can be resumed (only unfinished
// steps run again, against real state) or abandoned (what the run registered is
// taken back; a database is never deleted), the second behind a typed run id.
// A resumed run that finishes may hand back the store's console password: it
// is shown once, here, with Copy, and is gone on the next load.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton } from "@/components/kit/copy-button";
import { EmptyState } from "@/components/kit/empty-state";
import { ConfirmDialog, LoadError, Notice, opsGet, opsPost, when } from "./opsShared";

const RUN = { running: ["Running", "info"], done: ["Done", "success"], failed: ["Failed", "danger"], compensated: ["Abandoned", "muted"] };
const STEP = { done: "success", running: "info", failed: "danger", pending: "muted", skipped: "muted", compensated: "muted" };
const FAILURE_KIND = { retry_exhausted: "Gave up after 5 tries", needs_operator: "Needs an operator", lapsed: "Signup lapsed" };

export default function ProvisionRuns() {
  const [state, setState] = useState({ loading: true, error: null, runs: null });
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [abandoning, setAbandoning] = useState(null);
  const [secret, setSecret] = useState(null); // { run, tenant, password }, this page view only

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, runs: (await opsGet("provisions")).runs });
    } catch (e) {
      setState((s) => ({ loading: false, error: String(e?.message || e), runs: s.runs }));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function resume(run) {
    setBusy(run.id);
    setNotice(null);
    try {
      const j = await opsPost("provisions", { action: "resume", run: run.id });
      if (j.generated?.admin_password) setSecret({ run: run.id, tenant: run.tenant_id, password: j.generated.admin_password });
      setNotice({
        tone: j.failedStep ? "error" : "success",
        text: j.queued ? "Resumed. The signup's job picks it up in the background; refresh in a minute." : j.failedStep ? `Resumed, and it stopped again at ${j.failedStep}.` : `Run ${run.id} resumed.`,
      });
    } catch (e) {
      setNotice({ tone: "error", text: String(e?.message || e) });
    } finally {
      setBusy(null);
      load();
    }
  }

  const runs = state.runs;
  return (
    <section aria-labelledby="ops-runs-title" className="space-y-4" data-ops-tab="provisioning">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="ops-runs-title" className="text-base font-semibold">
            Provisioning runs
          </h2>
          <p className="text-sm text-muted-foreground">Resume re-runs only unfinished steps. Abandon takes back what a failed run registered; databases are never deleted.</p>
        </div>
        <Button size="sm" variant="outline" disabled={state.loading} onClick={load}>
          <RefreshCw aria-hidden /> Refresh
        </Button>
      </div>

      {secret && (
        <Alert variant="warning" data-ops-secret>
          <AlertTitle>
            {secret.tenant}: the store&apos;s console password (run {secret.run})
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>Shown once. Hand it to the merchant now; it isn&apos;t stored anywhere you can read it again.</p>
            <CopyButton value={secret.password} label="the console password" id="ops-run-secret" />
            <Button size="xs" variant="ghost" onClick={() => setSecret(null)}>
              I&apos;ve copied it
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Notice notice={notice} onClose={() => setNotice(null)} />
      {state.error && <LoadError what="provisioning runs" error={state.error} onRetry={load} />}

      {!runs && state.loading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 rounded-card" />
          ))}
        </div>
      )}
      {runs && runs.length === 0 && <EmptyState title="No provisioning runs yet." description="Each store made with New store, and each self-serve signup, records a resumable run here." />}
      {runs && runs.length > 0 && (
        <ul className="space-y-2">
          {runs.map((r) => {
            const [label, tone] = RUN[r.status] || [r.status, "muted"];
            return (
              <li key={r.id} data-ops-run={r.id}>
                <Card size="sm">
                  <CardContent className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold">{r.tenant_id}</span>
                      <span className="font-mono text-xs text-muted-foreground">{r.id}</span>
                      <Badge variant={tone}>{label}</Badge>
                      {r.signup && (
                        <Badge variant="outline" data-provision-signup={r.signup.status}>
                          {r.signup.source === "operator" ? "Created by Storeasy" : "Self-serve signup"}
                        </Badge>
                      )}
                      {r.signup?.failureKind && (
                        <Badge variant="danger" data-provision-failure-kind={r.signup.failureKind}>
                          {FAILURE_KIND[r.signup.failureKind] || r.signup.failureKind}
                        </Badge>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">{when(r.created_at)}</span>
                    </div>
                    <ol className="flex flex-wrap gap-1.5" aria-label="Steps">
                      {r.steps.map((s) => (
                        <li key={s.name} title={s.detail || undefined}>
                          <Badge variant={STEP[s.status] || "muted"}>
                            {s.name} · {s.status}
                          </Badge>
                        </li>
                      ))}
                    </ol>
                    {r.error && <p className="text-xs break-words text-destructive">{r.error}</p>}
                    {r.status === "failed" && (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={busy != null} onClick={() => resume(r)}>
                          {busy === r.id ? "Resuming…" : "Resume"}
                        </Button>
                        <Button size="sm" variant="destructive" disabled={busy != null} onClick={() => setAbandoning(r)}>
                          Abandon
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={!!abandoning}
        onOpenChange={(o) => !o && setAbandoning(null)}
        title={`Abandon run ${abandoning?.id}?`}
        description={`This takes back what the run registered for ${abandoning?.tenant_id}. The database is never deleted. A run you abandon can't be resumed.`}
        confirmLabel="Abandon run"
        typed={abandoning?.id}
        typedLabel="Type the run id"
        onConfirm={async () => {
          const r = abandoning;
          await opsPost("provisions", { action: "compensate", run: r.id });
          setNotice({ tone: "success", text: `Run ${r.id} abandoned.` });
          load();
        }}
      />
    </section>
  );
}
