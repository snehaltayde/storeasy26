"use client";

import { useState } from "react";

// Integrations tab (S34 / MC20): provider cards with connection state, scopes,
// last activity, Test and Revoke. Secrets never reach this component —
// presence flags only.
export default function IntegrationsAdmin({ initial }) {
  const [rows, setRows] = useState(initial);
  const [msg, setMsg] = useState({});
  const [busy, setBusy] = useState(false);

  async function act(provider, action) {
    if (action === "revoke" && !window.confirm(`Revoke ${provider}? Its stored credentials are cleared and dependent jobs will start failing loudly until reconnected.`)) return;
    setBusy(true);
    setMsg((m) => ({ ...m, [provider]: action === "revoke" ? "Revoking…" : "Testing…" }));
    const res = await fetch("/api/admin/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, provider }),
    });
    const data = await res.json().catch(() => ({}));
    if (action === "revoke" && data.integrations) setRows(data.integrations);
    setMsg((m) => ({
      ...m,
      [provider]:
        action === "revoke"
          ? data.ok
            ? `Revoked (${data.cleared} credential field(s) cleared)`
            : data.error || `Failed (${res.status})`
          : `${data.ok ? "✓" : "✗"} ${data.detail || data.error || res.status}`,
    }));
    setBusy(false);
  }

  const dot = (on) => (
    <span className={`inline-block h-2.5 w-2.5 rounded-full ${on ? "bg-lime-500" : "bg-zinc-300"}`} />
  );
  const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null);

  return (
    <div className="space-y-4">
      {rows.map((r) => (
        <div key={r.provider} className="rounded-2xl border border-zinc-200 p-5">
          <div className="flex flex-wrap items-center gap-3">
            {dot(r.connected)}
            <h2 className="text-sm font-bold capitalize">{r.provider}</h2>
            <span className="text-xs text-zinc-400">{r.kind}</span>
            {r.mode && <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${r.mode === "live" ? "bg-red-100 text-red-700" : "bg-zinc-100 text-zinc-500"}`}>{r.mode}</span>}
            {r.uninstalled_at && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">APP UNINSTALLED</span>}
            {r.platform_level && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold text-zinc-500">PLATFORM-LEVEL</span>}
            <span className="ml-auto flex gap-2">
              {r.actions?.includes("test") && (
                <button onClick={() => act(r.provider, "test")} disabled={busy} className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-50">
                  Test
                </button>
              )}
              {r.actions?.includes("revoke") && r.connected && (
                <button onClick={() => act(r.provider, "revoke")} disabled={busy} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50">
                  Revoke
                </button>
              )}
            </span>
          </div>
          <dl className="mt-2 space-y-0.5 text-xs text-zinc-500">
            {r.store_domain && <div>Store: {r.store_domain}</div>}
            {r.scopes && <div className="truncate">Scopes: {r.scopes}</div>}
            {r.checkout_mode && <div>Checkout mode: {r.checkout_mode}</div>}
            {r.webhook !== undefined && <div>Webhook secret: {r.webhook ? "set" : "missing"}</div>}
            {r.collection && <div>Collection: {r.collection}</div>}
            {when(r.last_event_at) && <div>Last webhook: {when(r.last_event_at)}</div>}
            {when(r.last_forward_at) && <div>Last forward: {when(r.last_forward_at)}</div>}
            {r.mock && <div className="text-amber-600">MOCK mode — mail prints to server logs</div>}
            {!r.connected && <div>Connect: {r.connect_hint}</div>}
          </dl>
          {msg[r.provider] && <p className="mt-2 text-xs text-zinc-600">{msg[r.provider]}</p>}
        </div>
      ))}
    </div>
  );
}
