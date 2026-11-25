"use client";

// Phase 3 line 5: /platform/support-access, every open support grant across
// stores (soonest to end first) with Close. Each store links to its page,
// where access is opened and the console entered. Data through
// /api/platform/support?view=open.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LifeBuoy } from "lucide-react";
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

export default function OpenGrants() {
  const [grants, setGrants] = useState(null);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGrants((await supportApi("GET", null, "?view=open")).grants);
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
    { key: "expiresAt", header: "Ends", className: "tabular-nums", cell: (g) => when(g.expiresAt) },
  ];

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6" data-screen="platform-support-access">
      <PageHeader title="Support access" description="Every store with support access open right now. Closing it signs the operator out of that store's console at once." />
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
        <AlertDialogContent>
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
