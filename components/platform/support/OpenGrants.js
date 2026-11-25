"use client";

// Phase 3 line 5: /platform/support-access, every open support grant across
// stores (soonest to end first) with Close. Each store links to its page,
// where access is opened and the console entered. Data through
// /api/platform/support?view=open.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LifeBuoy, RefreshCw } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { when } from "@/components/platform/stores/storesWords";
import { supportApi } from "./supportApi";

// "in 3 h 20 min", "in 12 min", "any moment now": how long a grant has left.
// The rows load in the browser only, so this never meets the server render.
function left(iso, now) {
  const ms = Date.parse(iso || "") - now;
  if (!Number.isFinite(ms)) return "";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "any moment now";
  const h = Math.floor(min / 60);
  return `in ${h ? `${h} h ` : ""}${min % 60 || !h ? `${min % 60} min` : ""}`.trim();
}

export default function OpenGrants() {
  const [grants, setGrants] = useState(null);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  const refreshButton = useRef(null);
  const closed = useRef(false);

  const load = useCallback(async () => {
    try {
      setGrants((await supportApi("GET", null, "?view=open")).grants);
      setNow(Date.now());
      setError(null);
    } catch (e) {
      setError(e.message);
      setGrants((g) => g ?? []);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function close() {
    setBusy(true);
    setError(null);
    try {
      await supportApi("POST", { action: "revoke", id: closing.id });
      closed.current = true;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setClosing(null);
      await load();
    }
  }

  const columns = [
    { key: "storeName", header: "Store", cell: (g) => <Link href={`/platform/stores/${encodeURIComponent(g.tenantId)}`} className="font-medium text-primary underline-offset-4 hover:underline">{g.storeName}</Link> },
    { key: "operatorName", header: "Opened by" },
    { key: "reason", header: "Reason", truncate: true },
    { key: "openedAt", header: "Opened", className: "hidden tabular-nums lg:table-cell", cell: (g) => when(g.openedAt) },
    {
      key: "expiresAt",
      header: "Ends",
      className: "tabular-nums",
      cell: (g) => (
        <span className="flex flex-col">
          <span>{when(g.expiresAt)}</span>
          {now > 0 && <span className={Date.parse(g.expiresAt) - now < 3600_000 ? "text-xs text-warning-text" : "text-xs text-muted-foreground"}>{left(g.expiresAt, now)}</span>}
        </span>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6" data-screen="platform-support-access">
      <PageHeader
        title="Support access"
        description={`${grants?.length ? `${grants.length} open, soonest to end first. ` : ""}Closing access signs the operator out of that store's console on their next click.`}
        actions={
          <Button ref={refreshButton} variant="outline" size="sm" onClick={load} disabled={grants === null}>
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        }
      />
      {error && (
        <Alert variant="destructive" role="alert" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DataTable
        label="Open support access"
        columns={columns}
        rows={grants ?? []}
        loading={grants === null}
        empty={<EmptyState icon={LifeBuoy} title="No support access is open" description="Open it from a store's page when a founder asks for help." />}
        rowActions={(g) => (
          <Button type="button" size="sm" variant="destructive" onClick={() => setClosing(g)} data-support="close">
            Close
          </Button>
        )}
      />
      <AlertDialog open={Boolean(closing)} onOpenChange={(o) => !o && setClosing(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            // the closed row is gone: focus lands on Refresh, not the page's top
            if (!closed.current) return;
            closed.current = false;
            e.preventDefault();
            refreshButton.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Close support access to {closing?.storeName}?</AlertDialogTitle>
            <AlertDialogDescription>Anyone in the store's console under this access is signed out of it on their next click.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it open</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                close();
              }}
            >
              {busy ? "Closing…" : "Close"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
