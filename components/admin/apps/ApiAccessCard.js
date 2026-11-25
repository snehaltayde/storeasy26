"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Pencil, Plus, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { roleAllows } from "@/lib/platform/authz";
import { AppRefusal } from "@/components/admin/apps/AppRefusal";
import { CreateTokenDialog } from "@/components/admin/apps/CreateTokenDialog";
import { CallLog } from "@/components/admin/apps/CallLog";
import { CardLoading } from "@/components/admin/apps/CardLoading";
import { NO_MANAGE, postApp, shortDate } from "@/components/admin/apps/app-words";

// A custom app's API access (Phase 4 line 4), read from
// GET /api/admin/apps/[id]/tokens: what the app may see (Edit narrows at once;
// adding a permission asks again in the same words as at creation), its
// tokens (name, tok_ id, permissions, who made it and when, expiry, last use,
// Active / Expiring soon / Expired / Revoked), Create token and Revoke
// (admin and owner; RoleGate'd for staff and support). Then the Calls list
// for audit.read holders. Never shows a token after the dialog that made it.
//   install: the install view (custom apps only); role: the actor's role
const TOKEN_STATES = Object.freeze({
  active: ["Active", "success"],
  expiring: ["Expiring soon", "warning"],
  expired: ["Expired", "muted"],
  revoked: ["Revoked", "muted"],
});
const when = (iso) => (iso ? shortDate(iso) : "—");

export function ApiAccessCard({ install, role }) {
  const toast = useToast();
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [scopes, setScopes] = useState([]);
  const [widen, setWiden] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const base = `apps/${encodeURIComponent(install.id)}/tokens`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/${base}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error);
      setView(json);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [base]);
  useEffect(() => {
    load();
  }, [load, install.status]);

  async function saveScopes(confirm = false) {
    setBusy("scopes");
    setError(null);
    const r = await postApp(base, { scopes: { scopes, confirm } });
    setBusy(null);
    if (!r.ok) {
      if (r.code === "CONFIRM_WIDEN") {
        const offered = new Map(view.offered.map((s) => [s.scope, s.words]));
        setWiden(scopes.filter((s) => !view.scopes.some((x) => x.scope === s)).map((s) => offered.get(s) ?? s));
        return;
      }
      setError(r.error);
      return;
    }
    setWiden(null);
    setEditing(false);
    toast.success("The app's permissions were saved. Every token follows them from now on.");
    await load();
  }

  async function revoke(tok) {
    setBusy("revoke");
    setError(null);
    const r = await postApp(base, { revoke: tok.id });
    setBusy(null);
    setRevoking(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    toast.success(`${tok.name} was revoked. Calls with it stop working now.`);
    await load();
  }

  if (!view) {
    return failed ? (
      <Card data-apps="api-access">
        <CardHeader>
          <CardTitle>API access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>We couldn't load this app's API access. Nothing was changed.</p>
          <Button type="button" variant="outline" size="sm" data-read-control onClick={() => load()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    ) : (
      <CardLoading title="API access" />
    );
  }

  const columns = [
    { key: "name", header: "Name", truncate: true },
    { key: "id", header: "Token", cell: (k) => <span className="font-mono text-xs text-muted-foreground">{`sea_${k.id}…`}</span> },
    {
      key: "scopes",
      header: "Can see",
      cell: (k) => (
        <span className="flex flex-wrap gap-1">
          {k.scopes.length ? k.scopes.map((s) => <Badge key={s} variant="outline" className="font-mono">{s}</Badge>) : <span className="text-muted-foreground">Its own name only</span>}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      cell: (k) => (
        <span className="block leading-snug">
          {when(k.createdAt)}
          {k.createdByName && <span className="block text-xs text-muted-foreground">{`by ${k.createdByName}`}</span>}
        </span>
      ),
    },
    { key: "expiresAt", header: "Expires", cell: (k) => when(k.expiresAt) },
    { key: "lastUsedAt", header: "Last used", cell: (k) => (k.lastUsedAt ? when(k.lastUsedAt) : <span className="text-muted-foreground">Never</span>) },
    {
      key: "status",
      header: "Status",
      cell: (k) => {
        const [label, tone] = TOKEN_STATES[k.status] ?? [k.status, "muted"];
        return (
          <Badge variant={tone} data-token-status={k.status}>
            {label}
          </Badge>
        );
      },
    },
  ];
  const active = view.tokens.filter((k) => k.status === "active" || k.status === "expiring").length;

  return (
    <Card data-apps="api-access">
      <CardHeader>
        <CardTitle>API access</CardTitle>
        <CardDescription>Tokens let this app read your store through the Storeasy API. A token can only see what you allow here, and every call is recorded.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="api-scopes" className="space-y-2">
          <h3 id="api-scopes" className="text-sm font-medium text-foreground">
            What the app can see
          </h3>
          {editing ? (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                saveScopes(false);
              }}
            >
              {view.offered.map((s) => (
                <div key={s.scope} className="flex items-start gap-2">
                  <Checkbox id={`api-scope-${s.scope}`} checked={scopes.includes(s.scope)} onCheckedChange={(v) => setScopes((x) => (v === true ? [...new Set([...x, s.scope])] : x.filter((y) => y !== s.scope)))} data-scope={s.scope} />
                  <Label htmlFor={`api-scope-${s.scope}`} className="font-normal leading-snug">
                    {s.words}
                  </Label>
                </div>
              ))}
              <p className="text-[13px] text-muted-foreground">Taking a permission away applies to every token at once. Customer details are never shared.</p>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy === "scopes"} data-apps="scopes-save">
                  {busy === "scopes" ? "Saving…" : "Save"}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy === "scopes"} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              {view.scopes.length ? (
                <ul className="space-y-1 text-sm">
                  {view.scopes.map((s) => (
                    <li key={s.scope} className="flex gap-2" data-api-scope={s.scope}>
                      <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      {s.words}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing yet. Its tokens can only read the app's own name.</p>
              )}
              <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-apps="scopes-edit"
                  onClick={() => {
                    setScopes(view.scopes.map((s) => s.scope));
                    setError(null);
                    setEditing(true);
                  }}
                >
                  <Pencil aria-hidden="true" />
                  Edit permissions
                </Button>
              </RoleGate>
            </>
          )}
        </section>
        <AppRefusal>{error}</AppRefusal>
        <section aria-labelledby="api-tokens" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="api-tokens" className="text-sm font-medium text-foreground">
              {`Tokens (${active} of ${view.maxActive} active)`}
            </h3>
            <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
              <Button type="button" variant="outline" size="sm" disabled={active >= view.maxActive} data-apps="token-new" onClick={() => setCreating(true)}>
                <Plus aria-hidden="true" />
                Create token
              </Button>
            </RoleGate>
          </div>
          <DataTable
            label="API tokens"
            columns={columns}
            rows={view.tokens}
            rowActions={(k) =>
              k.status === "revoked" ? null : (
                <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
                  <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" data-token-revoke={k.id} onClick={() => setRevoking(k)}>
                    Revoke
                  </Button>
                </RoleGate>
              )
            }
            empty={<EmptyState icon={KeyRound} title="No tokens yet" description="Create a token when this app needs to read your store through the API." />}
          />
        </section>
        {roleAllows(role, "audit.read") && <CallLog installId={install.id} />}
      </CardContent>
      {creating && <CreateTokenDialog open={creating} onOpenChange={setCreating} installId={install.id} view={view} onCreated={load} />}
      <AlertDialog open={Boolean(revoking)} onOpenChange={(v) => !v && busy !== "revoke" && setRevoking(null)}>
        <AlertDialogContent data-apps="revoke-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{`Revoke ${revoking?.name ?? "this token"}?`}</AlertDialogTitle>
            <AlertDialogDescription>Calls with this token stop working right away. This can't be undone; you can create a new token instead.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "revoke"}>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={busy === "revoke"} data-apps="revoke-go" onClick={() => revoke(revoking)}>
              {busy === "revoke" ? "Revoking…" : "Revoke token"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(widen)} onOpenChange={(v) => !v && busy !== "scopes" && setWiden(null)}>
        <AlertDialogContent data-apps="widen-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{`Give ${install.name} more access?`}</AlertDialogTitle>
            <AlertDialogDescription>Its tokens will be able to:</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-1 text-sm">
            {(widen ?? []).map((w) => (
              <li key={w} className="flex gap-2">
                <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                {w}
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-muted-foreground">Customer names, emails, phone numbers and addresses are never shared.</p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "scopes"}>Cancel</AlertDialogCancel>
            <Button type="button" disabled={busy === "scopes"} data-apps="widen-go" onClick={() => saveScopes(true)}>
              {busy === "scopes" ? "Saving…" : "Approve"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
