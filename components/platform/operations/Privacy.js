"use client";

// Phase 3 line 6: the Privacy requests tab (was PrivacyOpsPanel). Every active
// store's privacy requests in one list, newest first, with no shopper email,
// phone or customer id (the server leaves them out). An open request can be
// carried out here: erasure scrubs the shopper's details from orders and
// events and can't be undone, so the operator types the store's name first.
// A store that couldn't be read is named, never silently left out.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { ConfirmDialog, LoadError, Notice, opsGet, opsPost, when } from "./opsShared";

const KIND = { data_request: "Data request", customer_redact: "Erase a shopper", shop_redact: "Erase the shop" };
const STATUS = { pending: ["Open", "warning"], manual: ["Needs an operator", "danger"], done: ["Done", "success"] };

export default function Privacy() {
  const [state, setState] = useState({ loading: true, error: null, requests: null });
  const [openOnly, setOpenOnly] = useState(true);
  const [notice, setNotice] = useState(null);
  const [erasing, setErasing] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, requests: (await opsGet("privacy")).requests });
    } catch (e) {
      setState((s) => ({ loading: false, error: String(e?.message || e), requests: s.requests }));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const all = state.requests || [];
  const unreachable = all.filter((r) => r.unreachable);
  const rows = all.filter((r) => !r.unreachable && (!openOnly || r.status !== "done"));

  const columns = [
    { key: "storeName", header: "Store", cell: (r) => r.storeName || r.tenant },
    { key: "kind", header: "Request", cell: (r) => KIND[r.kind] || r.kind },
    {
      key: "status",
      header: "State",
      cell: (r) => {
        const [label, tone] = STATUS[r.status] || [r.status, "muted"];
        return (
          <Badge variant={tone} data-privacy-status={r.status}>
            {label}
          </Badge>
        );
      },
    },
    { key: "created_at", header: "Received", cell: (r) => when(r.created_at) },
    { key: "notes", header: "Notes", truncate: true, cell: (r) => r.notes || "—" },
  ];

  return (
    <section aria-labelledby="ops-privacy-title" className="space-y-4" data-ops-tab="privacy">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="ops-privacy-title" className="text-base font-semibold">
            Privacy requests
          </h2>
          <p className="text-sm text-muted-foreground">Every active store&apos;s requests. Shopper details stay in the store; carrying out an erasure is audited.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" aria-pressed={!openOnly} onClick={() => setOpenOnly((v) => !v)}>
            {openOnly ? "Show done too" : "Open requests only"}
          </Button>
          <Button size="sm" variant="outline" disabled={state.loading} onClick={load}>
            <RefreshCw aria-hidden /> Refresh
          </Button>
        </div>
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />
      {state.error && <LoadError what="privacy requests" error={state.error} onRetry={load} />}
      {unreachable.map((r) => (
        <Alert key={r.tenant} variant="warning" data-privacy-unreachable={r.tenant}>
          <AlertDescription>
            {r.storeName || r.tenant}: {r.error} Its requests aren&apos;t in the list below.
          </AlertDescription>
        </Alert>
      ))}

      {(state.requests || state.loading) && (
        <DataTable
          label="Privacy requests"
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.tenant}:${r.id}`}
          loading={!state.requests && state.loading}
          rowActions={(r) =>
            r.status !== "done" ? (
              <Button size="xs" variant="destructive" onClick={() => setErasing(r)} aria-label={`Carry out request ${r.id} for ${r.storeName || r.tenant}`}>
                Carry out
              </Button>
            ) : null
          }
          empty={<EmptyState title={openOnly ? "No open privacy requests across the stores." : "No privacy requests yet."} />}
        />
      )}

      <ConfirmDialog
        open={!!erasing}
        onOpenChange={(o) => !o && setErasing(null)}
        title={`Carry out this request for ${erasing?.storeName || erasing?.tenant}?`}
        description="The shopper's name, email, phone and address are scrubbed from the store's orders and events. Order totals stay. This can't be undone."
        confirmLabel="Erase the shopper's details"
        typed={erasing?.storeName || erasing?.tenant}
        typedLabel="Type the store's name"
        onConfirm={async () => {
          const r = erasing;
          const j = await opsPost("privacy", { action: "redact", tenant: r.tenant, requestId: r.id });
          setNotice({
            tone: "success",
            text: j.result?.already ? "That request was already done." : `Done: ${j.result?.orders ?? 0} orders and ${j.result?.events ?? 0} events scrubbed in ${r.storeName || r.tenant}.`,
          });
          load();
        }}
      />
    </section>
  );
}
