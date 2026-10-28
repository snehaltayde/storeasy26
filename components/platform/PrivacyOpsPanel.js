"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { StatusBadge } from "@/components/console/Badge";
import { DangerDialog } from "@/components/console/Dialog";
import { SkeletonText, ErrorState, EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Privacy ops (S43 / OP11, redesigned S50): the fleet's privacy-request queue
// + manual execution of pending/manual redactions (audited). Unreachable
// tenants are listed as such, never silently skipped. Execution deletes
// shopper data, so it sits behind a typed confirmation.
export default function PrivacyOpsPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [redacting, setRedacting] = useState(null); // row pending typed confirmation
  const toast = useToast();

  const load = useCallback(() => {
    setErr(null);
    return fetch("/api/platform/privacy")
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function redact(row) {
    const res = await fetch("/api/platform/privacy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "redact", tenant: row.tenant, requestId: row.id }),
    });
    const json = await res.json().catch(() => ({}));
    if (!(res.ok && json.ok)) throw new Error(json.error || `failed (${res.status})`);
    toast.success(`Redaction executed for ${row.tenant} · ${row.id}`);
    load();
  }

  const unreachable = data?.requests?.filter((r) => r.unreachable) || [];
  const rows = data?.requests?.filter((r) => !r.unreachable) || [];
  const open = rows.filter((r) => r.status !== "done");

  return (
    <Card id="privacy">
      <CardHeader title="Privacy ops" description="Fleet privacy-request queue; manual redactions are audited." />
      {err && <ErrorState title="Couldn't load the privacy queue" detail={err} onRetry={load} />}
      {!data && !err && <SkeletonText lines={3} />}
      {data && (
        <>
          {unreachable.map((r, i) => (
            <Banner key={i} tone="danger" className="mb-2">
              {r.tenant}: unreachable ({r.error}) — its queue is NOT included above
            </Banner>
          ))}
          {rows.length === 0 && open.length === 0 ? (
            <EmptyState title="Queue clear" body="No open privacy requests across the fleet." />
          ) : (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-ctl border border-edge p-3 text-sm">
                  <StatusBadge status={r.status} />
                  <span className="font-medium text-fg">{r.tenant}</span>
                  <span className="text-fg-muted">{String(r.kind || "").replace(/_/g, " ")}</span>
                  <span className="text-xs text-fg-subtle">{r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN") : ""}</span>
                  {r.status !== "done" && (
                    <Button size="sm" variant="dangerOutline" className="ml-auto" onClick={() => setRedacting(r)}>
                      Execute redaction
                    </Button>
                  )}
                  {r.notes && <span className="w-full text-xs text-fg-subtle">{r.notes}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <DangerDialog
        open={!!redacting}
        onClose={() => setRedacting(null)}
        title={`Execute redaction — ${redacting?.tenant} · ${redacting?.id}`}
        confirmLabel="Execute redaction"
        typedConfirmation="REDACT"
        body="PII is scrubbed; money rows are retained. This deletes shopper data and cannot be undone."
        onConfirm={() => redact(redacting)}
      />
    </Card>
  );
}
