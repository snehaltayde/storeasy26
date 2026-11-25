"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportStepBody, POLL_MS } from "@/components/admin/onboarding/ImportStep";

// The first import's card on the dashboard (Phase 2 line 1): onboarding's
// ImportStepBody with the same view (lib/admin/sync-view.js), shown while a
// first import runs, failed or stalled. It re-reads GET /api/admin/sync every
// few seconds while the import runs and the tab is visible, and refreshes the
// page once it finishes. "Run again" is gate (gateAction("sync.run", role)):
// a role without it sees the button disabled with the reason. Reconnecting
// Shopify is a settings.write step, so a role without it isn't offered it.
const LIVE = new Set(["running", "retrying"]);

async function readSync() {
  const res = await fetch("/api/admin/sync", { headers: { Accept: "application/json" }, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  return res.ok && data.sync ? data.sync : null;
}

const withoutReconnect = (view) => (view?.problem ? { ...view, problem: { ...view.problem, next: view.problem.next.filter((n) => n.id !== "reconnect") } } : view);

// title: the card's heading (Settings → Products from Shopify names it so, Phase 2 line 7)
export function SyncCard({ initial, gate, canReconnect, title = "Bringing in your products" }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const live = LIVE.has(view?.state);

  useEffect(() => {
    if (!live) return undefined;
    const timer = setTimeout(async () => {
      if (document.visibilityState !== "visible") return setView((v) => ({ ...v }));
      const next = await readSync().catch(() => null);
      if (!next) return setView((v) => ({ ...v }));
      setView(next);
      if (!LIVE.has(next.state)) router.refresh();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [view]);

  async function act(body) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const data = (await res?.json().catch(() => ({}))) || {};
    if (res?.ok && data.ok && data.sync) setView(data.sync);
    else setError(res?.status === 429 ? "That was a lot of tries in a row. Wait a minute, then try again." : data.error || "Couldn't start. Check your connection, then try again.");
    setBusy(false);
  }

  const id = view?.canRetry ? "retry_sync" : "start_sync";
  return (
    <Card data-dashboard="sync">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ImportStepBody
          view={canReconnect ? view : withoutReconnect(view)}
          gate={{ id, ...gate }}
          busy={busy}
          error={error}
          onAct={act}
          onReconnect={() => router.push("/admin/onboarding?step=connect")}
        />
      </CardContent>
    </Card>
  );
}
