"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { StatusBadge } from "@/components/console/Badge";
import { Field, Input } from "@/components/console/fields";
import { ConfirmDialog } from "@/components/console/Dialog";
import { SkeletonText, ErrorState, EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Incidents panel (S43 / OP12, redesigned S50): open/update/resolve with
// INTERNAL notes kept apart from the PUBLIC message merchants see in their
// console banner.
export default function IncidentsPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null); // load failure → ErrorState
  const [actErr, setActErr] = useState(null); // action failure → Banner
  const [f, setF] = useState({ title: "", tenant: "", publicMessage: "", internalNote: "" });
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(null); // incident to resolve
  const toast = useToast();

  const load = useCallback(() => {
    setErr(null);
    return fetch("/api/platform/incidents")
      .then((r) => r.json())
      .then((j) => (j.ok ? setData(j) : setErr(j.error || "failed")))
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function post(body) {
    const res = await fetch("/api/platform/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      setData(json);
      return json;
    }
    throw new Error(json.error || `failed (${res.status})`);
  }

  async function openIncident() {
    setBusy(true);
    setActErr(null);
    try {
      await post({ action: "open", title: f.title, tenant: f.tenant.trim() || null, publicMessage: f.publicMessage, internalNote: f.internalNote });
      setF({ title: "", tenant: "", publicMessage: "", internalNote: "" });
      toast.success("Incident opened");
    } catch (e) {
      setActErr(String(e?.message || e));
    }
    setBusy(false);
  }

  return (
    <Card id="incidents">
      <CardHeader
        title="Incidents"
        description="Public message shows in affected merchant consoles while open; internal notes never leave this page."
      />
      {err && <ErrorState title="Couldn't load incidents" detail={err} onRetry={load} />}
      {!data && !err && <SkeletonText lines={4} />}
      {data && (
        <>
          {actErr && (
            <Banner tone="danger" className="mb-3">
              {actErr}
            </Banner>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Title" htmlFor="inc-title" required>
              <Input id="inc-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
            </Field>
            <Field label="Tenant" htmlFor="inc-tenant" hint="Blank = platform-wide.">
              <Input id="inc-tenant" mono value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })} />
            </Field>
            <Field label="Public message" htmlFor="inc-public" hint="Merchants see this.">
              <Input id="inc-public" value={f.publicMessage} onChange={(e) => setF({ ...f, publicMessage: e.target.value })} />
            </Field>
            <Field label="Internal note" htmlFor="inc-internal">
              <Input id="inc-internal" value={f.internalNote} onChange={(e) => setF({ ...f, internalNote: e.target.value })} />
            </Field>
          </div>
          <div className="mt-3">
            <Button variant="primary" size="sm" busy={busy} disabled={!f.title.trim()} onClick={openIncident}>
              Open incident
            </Button>
          </div>

          {data.incidents.length === 0 ? (
            <EmptyState title="No incidents recorded" body="Open one above when a tenant or the platform is degraded." />
          ) : (
            <ul className="mt-4 space-y-2">
              {data.incidents.map((i) => (
                <li key={i.id} className={`rounded-ctl border p-3 text-sm ${i.status === "open" ? "border-warning-edge bg-warning-bg/30" : "border-edge opacity-70"}`}>
                  <p className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={i.status} />
                    <span className="font-semibold text-fg">{i.title}</span>
                    <span className="text-xs text-fg-subtle">
                      {i.tenant_id || "platform-wide"} ·{" "}
                      {new Date(i.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                    {i.status === "open" && (
                      <Button size="sm" className="ml-auto" onClick={() => setResolving(i)}>
                        Resolve
                      </Button>
                    )}
                  </p>
                  {i.public_message && <p className="mt-1 text-xs text-info">public: {i.public_message}</p>}
                  {i.internal_note && <p className="mt-0.5 text-xs text-fg-muted">internal: {i.internal_note}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!resolving}
        onClose={() => setResolving(null)}
        title={`Resolve “${resolving?.title}”?`}
        confirmLabel="Resolve"
        body="The public message disappears from affected merchant consoles."
        onConfirm={async () => {
          await post({ action: "resolve", id: resolving.id });
          toast.success("Incident resolved");
        }}
      />
    </Card>
  );
}
