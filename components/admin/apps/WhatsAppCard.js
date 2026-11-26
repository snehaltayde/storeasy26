"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Pencil } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { CardLoading } from "@/components/admin/apps/CardLoading";
import { NO_MANAGE, postApp, shortDate } from "@/components/admin/apps/app-words";

// The WhatsApp app's card (Phase 9 line 3), read from
// GET /api/admin/apps/[id]/whatsapp: whether messages can go out, the four
// templates (edit the words, Meta template name and language; Approve: only
// approved templates send, and any edit returns one to draft), the limits,
// and the last 50 messages (phones masked for support). Editing and
// approving are owner and admin only (RoleGate'd for staff and support).
//   install: the install view; role: the actor's role
const KIND_TONE = { approved: "success", draft: "secondary" };
const STATUS_WORDS = { sent: "Sent", queued: "Sending", failed: "Failed" };

function TemplateRow({ t, role, busy, onSave, onApprove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ body: t.body, provider_template: t.providerTemplate, language: t.language });
  useEffect(() => setDraft({ body: t.body, provider_template: t.providerTemplate, language: t.language }), [t.body, t.providerTemplate, t.language]);
  const id = `wa-${t.kind}`;
  return (
    <li className="space-y-2 rounded-md border p-3" data-wa-template={t.kind} data-wa-status={t.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t.words}</span>
        {t.marketing && <Badge variant="outline">Marketing</Badge>}
        <Badge variant={KIND_TONE[t.status] ?? "secondary"}>{t.status === "approved" ? "Approved" : "Draft"}</Badge>
        <span className="ml-auto flex gap-2">
          <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
            <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)} data-wa-edit={t.kind}>
              <Pencil aria-hidden="true" /> Edit
            </Button>
          </RoleGate>
          {t.status !== "approved" && (
            <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
              <Button size="sm" onClick={() => onApprove(t.kind)} disabled={busy === `approve:${t.kind}`} data-wa-approve={t.kind}>
                <Check aria-hidden="true" /> Approve
              </Button>
            </RoleGate>
          )}
        </span>
      </div>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onSave(t.kind, draft)) setEditing(false);
          }}
        >
          <Label htmlFor={`${id}-body`}>Message</Label>
          <Textarea id={`${id}-body`} rows={4} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-name`}>Meta template name</Label>
              <Input id={`${id}-name`} value={draft.provider_template} onChange={(e) => setDraft({ ...draft, provider_template: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-lang`}>Language</Label>
              <Input id={`${id}-lang`} value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })} />
            </div>
          </div>
          <Button size="sm" type="submit" disabled={busy === `save:${t.kind}`}>
            Save as draft
          </Button>
        </form>
      ) : (
        <p className="whitespace-pre-line text-sm text-muted-foreground">{t.body}</p>
      )}
    </li>
  );
}

export function WhatsAppCard({ install, role }) {
  const toast = useToast();
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const base = `apps/${encodeURIComponent(install.id)}/whatsapp`;

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
  }, [load, install.status, install.updatedAt]);

  async function act(what, body, done) {
    setBusy(what);
    setError(null);
    const r = await postApp(base, body);
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    setView(r);
    toast.success(done);
    return true;
  }

  if (failed) return <p className="text-sm text-muted-foreground">The WhatsApp details couldn&apos;t be loaded. Reload the page to try again.</p>;
  if (!view) return <CardLoading title="WhatsApp" />;
  const c = view.caps;
  return (
    <Card data-apps="whatsapp" data-wa-connected={view.connection.connected ? "yes" : "no"}>
      <CardHeader>
        <CardTitle>WhatsApp</CardTitle>
        <CardDescription data-wa-connection={view.connection.provider ?? "none"}>{view.connection.words}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <section aria-labelledby="wa-templates" className="space-y-2">
          <h3 id="wa-templates" className="text-sm font-medium">Templates</h3>
          <p className="text-sm text-muted-foreground">
            Only approved templates send. Fields: {view.vars.map((v) => `{${v}}`).join(" ")}. Your Meta template&apos;s {"{{1}}"}, {"{{2}}"} … take the fields in the order they appear here.
          </p>
          <ul className="space-y-2">
            {view.templates.map((t) => (
              <TemplateRow
                key={t.kind}
                t={t}
                role={role}
                busy={busy}
                onSave={(kind, d) => act(`save:${kind}`, { template: { kind, ...d } }, "Saved as a draft. Approve it to start sending it.")}
                onApprove={(kind) => act(`approve:${kind}`, { approve: kind }, "Approved. This message can now send.")}
              />
            ))}
          </ul>
        </section>
        <section aria-labelledby="wa-limits" className="space-y-1 text-sm">
          <h3 id="wa-limits" className="font-medium">Limits</h3>
          <p className="text-muted-foreground" data-wa-caps>
            Cart reminder after {c.delayHours} h idle, once per cart. Offers and reminders: at most {c.perPhoneDay} a day and {c.perPhoneWeek} a week per phone, {c.dailyCap} a day for the store, never from {c.quietFrom}:00 to {String(c.quietTo).padStart(2, "0")}:00. Change the delay and the store limit in Settings.
          </p>
        </section>
        <section aria-labelledby="wa-log" className="space-y-2">
          <h3 id="wa-log" className="text-sm font-medium">Messages</h3>
          {view.log.length ? (
            <ul className="divide-y text-sm" data-wa-log>
              {view.log.map((m) => (
                <li key={m.id} className="flex flex-wrap gap-x-3 py-1.5" data-wa-log-kind={m.kind}>
                  <span className="font-medium">{view.templates.find((t) => t.kind === m.kind)?.words ?? m.kind}</span>
                  <span className="font-mono">{m.to}</span>
                  <span>{STATUS_WORDS[m.status] ?? m.status}</span>
                  <span className="ml-auto text-muted-foreground">{shortDate(m.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No messages yet.</p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
