"use client";

import { useState } from "react";
import { Card } from "@/components/console/Card";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Button } from "@/components/console/Button";
import { DangerDialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";

// Integrations tab (S34 / MC20, redesigned S50): provider cards with
// connection state, scopes, last activity, Test and Revoke. Secrets never
// reach this component — presence flags only. Revoke now goes through a
// typed DangerDialog (the provider key) instead of window.confirm; test
// results land as toasts.

// Connection state chip. `connected`/`unconfigured` aren't in the shared
// status map (status.js isn't part of this slice), so the tone mapping the
// map would carry lives here; raw state stays on title, like StatusBadge.
const CONNECTION = {
  connected: { tone: "success", label: "Connected" },
  unreachable: { tone: "danger", label: "Unreachable" },
  unconfigured: { tone: "neutral", label: "Not connected" },
};

const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null);

export default function IntegrationsAdmin({ initial }) {
  const toast = useToast();
  const [rows, setRows] = useState(initial);
  const [testing, setTesting] = useState(null); // provider key under test
  const [lastTest, setLastTest] = useState({}); // provider → true (ok) | false (failed)
  const [revoking, setRevoking] = useState(null); // provider row pending the danger dialog

  async function post(action, provider) {
    const res = await fetch("/api/admin/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, provider }),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function test(provider) {
    setTesting(provider);
    try {
      const { res, data } = await post("test", provider);
      setLastTest((m) => ({ ...m, [provider]: !!data.ok }));
      const detail = data.detail || data.error || `HTTP ${res.status}`;
      if (data.ok) toast.success(`${provider}: ${detail}`);
      else toast.error(`${provider}: ${detail}`);
    } finally {
      setTesting(null);
    }
  }

  async function revoke(provider) {
    const { res, data } = await post("revoke", provider);
    if (!data.ok) throw new Error(data.error || `Failed (${res.status})`);
    if (data.integrations) setRows(data.integrations);
    setLastTest((m) => ({ ...m, [provider]: undefined }));
    toast.success(`${provider} revoked — ${data.cleared} credential field(s) cleared`);
  }

  const connectionState = (r) => (!r.connected ? "unconfigured" : lastTest[r.provider] === false ? "unreachable" : "connected");

  return (
    <div className="space-y-4">
      {rows.map((r) => {
        const state = CONNECTION[connectionState(r)];
        return (
          <Card key={r.provider}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold capitalize text-fg">{r.provider}</h2>
              <Badge tone={state.tone} title={connectionState(r)}>
                {state.label}
              </Badge>
              {r.kind && <Badge tone="neutral">{r.kind}</Badge>}
              {r.mode && <Badge tone={r.mode === "live" ? "danger" : "neutral"}>{r.mode}</Badge>}
              {r.uninstalled_at && <StatusBadge status="uninstalled" label="App uninstalled" />}
              {r.platform_level && <Badge tone="neutral">Platform-level</Badge>}
              <span className="ml-auto flex gap-2">
                {r.actions?.includes("test") && (
                  <Button size="sm" busy={testing === r.provider} disabled={!!testing} onClick={() => test(r.provider)}>
                    Test
                  </Button>
                )}
                {r.actions?.includes("revoke") && r.connected && (
                  <Button size="sm" variant="dangerOutline" onClick={() => setRevoking(r)}>
                    Revoke
                  </Button>
                )}
              </span>
            </div>
            <dl className="mt-2 space-y-0.5 text-xs text-fg-muted">
              {r.store_domain && <div>Store: {r.store_domain}</div>}
              {r.scopes && <div className="truncate">Scopes: {r.scopes}</div>}
              {r.checkout_mode && <div>Checkout mode: {r.checkout_mode}</div>}
              {r.webhook !== undefined && <div>Webhook secret: {r.webhook ? "set" : "missing"}</div>}
              {r.collection && <div>Collection: {r.collection}</div>}
              {when(r.last_event_at) && <div>Last webhook: {when(r.last_event_at)}</div>}
              {when(r.last_forward_at) && <div>Last forward: {when(r.last_forward_at)}</div>}
              {r.mock && <div className="text-warning">MOCK mode — mail prints to server logs</div>}
              {!r.connected && <div>Connect: {r.connect_hint}</div>}
            </dl>
          </Card>
        );
      })}

      <DangerDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.provider}?`}
        confirmLabel="Revoke"
        typedConfirmation={revoking?.provider}
        body={`Stored credentials for ${revoking?.provider} are cleared and queued jobs using it stop — they fail loudly until you reconnect.`}
        onConfirm={() => revoke(revoking.provider)}
      />
    </div>
  );
}
