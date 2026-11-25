"use client";

import { useState } from "react";
import { FlaskConical, Lock, Plus, Power, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/kit/page-header";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { ConfirmAction, sendJson } from "@/components/admin/offers/ConfirmAction";
import { ACTION_WORDS, RuleSheet, TRIGGER_WORDS } from "./RuleSheet";
import { RunsTable } from "./RunsTable";

// Automations on the new UI (Phase 2 line 9). Admins and owners only
// (settings.read to see, settings.write to change): the page hands this
// screen nothing for any other role and shows PermissionNote instead. Rules
// list with an on/off switch each, New rule and Edit (a sheet), Remove (asks
// first), Dry run (works the rule out against the latest order and sends
// nothing), the kill switch (asks first) and the recent runs with Retry.
//   initial: { disabled, automations, runs, triggers, actions }, role
const API = "/api/admin/automations";

// The no-access page for a role without settings.read (no rules in props).
export function PermissionNote({ role }) {
  return (
    <p data-automations="no-access" className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3.5 py-2.5 text-sm text-muted-foreground">
      <Lock aria-hidden className="size-4 shrink-0" />
      <span>Your role{role ? ` (${role})` : ""} can&rsquo;t view automations — ask an owner or admin.</span>
    </p>
  );
}

const conditionWords = (r) => {
  const c = r.conditions || {};
  const out = [];
  if (c.min_total != null) out.push(`total at least ${c.min_total}`);
  if (c.payment_method) out.push(c.payment_method === "cod" ? "cash on delivery" : "paid online");
  return out.length ? out.join(", ") : "every time";
};
const quietWords = (r) => (r.quiet_start ? `${r.quiet_start}–${r.quiet_end}` : "None");

export function RulesList({ initial, role }) {
  const [data, setData] = useState(initial);
  const [retrying, setRetrying] = useState(false);
  const [sheet, setSheet] = useState(null); // { rule } | null
  const [confirm, setConfirm] = useState(null); // { kind: "remove", rule } | { kind: "kill" }
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null); // { tone, text }

  async function refresh() {
    try {
      setData(await sendJson(API, "GET"));
    } catch (e) {
      setNotice({ tone: "error", text: e.message });
    }
  }
  async function act(key, body, done) {
    setPending(key);
    setNotice(null);
    try {
      const r = await sendJson(API, "POST", body);
      if (done) setNotice(done(r));
      await refresh();
    } catch (e) {
      setNotice({ tone: "error", text: e.message });
    } finally {
      setPending(null);
    }
  }

  // The first read failed: plain words and Try again (a fresh GET). Only
  // admins and owners reach this component, so it needs no read mark.
  if (!data) {
    return (
      <>
        <PageHeader title="Automations" />
        <EmptyState
          title="Couldn't read your automations just now."
          description="Nothing is lost. Try again in a moment."
          action={
            <Button
              type="button"
              variant="outline"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  setData(await sendJson(API, "GET"));
                } catch {
                  /* still failing: the same note stays */
                } finally {
                  setRetrying(false);
                }
              }}
            >
              Try again
            </Button>
          }
        />
      </>
    );
  }

  const { disabled, automations = [], runs = [], triggers, actions } = data;
  return (
    <>
      <PageHeader
        title="Automations"
        description="Rules that send one email when something happens in your store, with a daily limit and quiet hours. A dry run sends nothing."
        actions={
          <>
            <RoleGate role={role} action="settings.write" mode="hide">
              <Button type="button" variant={disabled ? "default" : "outline"} className={disabled ? undefined : "text-destructive hover:text-destructive"} onClick={() => setConfirm({ kind: "kill" })} data-automations="kill-switch">
                {disabled ? <Power aria-hidden /> : <PowerOff aria-hidden />}
                {disabled ? "Turn automations back on" : "Turn all off"}
              </Button>
            </RoleGate>
            <RoleGate role={role} action="settings.write" mode="hide">
              <Button type="button" variant={disabled ? "outline" : "default"} onClick={() => setSheet({ rule: null })}>
                <Plus aria-hidden />
                New rule
              </Button>
            </RoleGate>
          </>
        }
      />
      {disabled && (
        <p role="note" data-automations="disabled" className="mb-4 flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2.5 text-sm text-warning-text">
          <PowerOff aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>All automations are off. No rule runs, whatever its own switch says, until you turn them back on.</span>
        </p>
      )}
      {notice && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={`mb-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${notice.tone === "error" ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-info/30 bg-info/5 text-foreground"}`}
          data-automations="notice"
        >
          {notice.tone !== "error" && <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />}
          <span>{notice.text}</span>
        </p>
      )}

      <div className="space-y-4">
        <Card data-automations="rules">
          <CardHeader>
            <CardTitle>Rules</CardTitle>
            <CardDescription>Each switch turns one rule on or off. A dry run works a rule out against your latest order and sends nothing.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              label="Rules"
          rows={automations}
          rowKey={(r) => r.id}
          columns={[
            { key: "name", header: "Rule", truncate: true },
            { key: "trigger", header: "When", cell: (r) => `${TRIGGER_WORDS[r.trigger] || r.trigger}, ${conditionWords(r)}` },
            { key: "action", header: "Then", cell: (r) => ACTION_WORDS[r.action?.kind] || r.action?.kind },
            { key: "cap_per_day", header: "A day", align: "right", cell: (r) => <span className="font-mono tabular-nums">{r.cap_per_day}</span> },
            { key: "quiet", header: "Quiet hours", cell: (r) => <span className={r.quiet_start ? "font-mono tabular-nums" : "text-muted-foreground"}>{quietWords(r)}</span> },
            {
              key: "enabled",
              header: "On",
              cell: (r) => (
                <Switch checked={!!r.enabled} disabled={pending === `enable:${r.id}`} aria-label={`${r.enabled ? "Turn off" : "Turn on"} ${r.name}`} onCheckedChange={(v) => act(`enable:${r.id}`, { enable: { id: r.id, enabled: v } })} />
              ),
            },
          ]}
          rowActions={(r) => (
            <div className="flex justify-end gap-1">
              <RoleGate role={role} action="settings.write" mode="hide">
                <Button type="button" variant="ghost" size="sm" disabled={pending === `dry:${r.id}`} onClick={() => act(`dry:${r.id}`, { dry_run: { id: r.id } }, (x) => ({ tone: "ok", text: `Dry run on ${x.sample === "SYNTHETIC-ORDER" ? "a made-up order" : `order ${x.sample}`}: ${x.reason}` }))}>
                  Dry run
                </Button>
              </RoleGate>
              <RoleGate role={role} action="settings.write" mode="hide">
                <Button type="button" variant="ghost" size="sm" onClick={() => setSheet({ rule: r })}>
                  Edit
                </Button>
              </RoleGate>
              <RoleGate role={role} action="settings.write" mode="hide">
                <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirm({ kind: "remove", rule: r })}>
                  Remove
                </Button>
              </RoleGate>
            </div>
          )}
              empty={<EmptyState title="No rules yet." description="A rule sends one email when an order is placed or a return is asked for." className="py-6" />}
            />
          </CardContent>
        </Card>

        <Card data-automations="runs">
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
            <CardDescription>The last 30 things your rules did, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            <RunsTable role={role} runs={runs} rules={automations} retrying={pending?.startsWith("retry:") ? pending.slice(6) : null} onRetry={(run) => act(`retry:${run.id}`, { retry: { run: run.id } }, (x) => ({ tone: x.status === "done" ? "ok" : "error", text: `Retry: ${x.reason}` }))} />
          </CardContent>
        </Card>
      </div>

      <RuleSheet open={!!sheet} onOpenChange={(v) => !v && setSheet(null)} rule={sheet?.rule || null} triggers={triggers} actions={actions} onSaved={refresh} />
      <ConfirmAction
        open={!!confirm}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={confirm?.kind === "remove" ? `Remove "${confirm.rule.name}"?` : disabled ? "Turn automations back on?" : "Turn all automations off?"}
        body={confirm?.kind === "remove" ? "The rule is deleted and stops running. Its past runs stay in the list." : disabled ? "Every rule that is switched on starts running again from the next order." : "No rule runs until you turn them back on. Nothing already sent is undone."}
        confirmLabel={confirm?.kind === "remove" ? "Remove rule" : disabled ? "Turn back on" : "Turn all off"}
        destructive={confirm?.kind === "remove" || (confirm?.kind === "kill" && !disabled)}
        onConfirm={async () => {
          const body = confirm.kind === "remove" ? { remove: { id: confirm.rule.id } } : { disable_all: { disabled: !disabled } };
          await sendJson(API, "POST", body);
          await refresh();
        }}
      />
    </>
  );
}
