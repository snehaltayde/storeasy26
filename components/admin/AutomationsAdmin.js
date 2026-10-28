"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardFooter, CardHeader } from "@/components/console/Card";
import { Button } from "@/components/console/Button";
import { StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Table } from "@/components/console/Table";
import { Field, Input, Select, Textarea } from "@/components/console/fields";
import { ConfirmDialog } from "@/components/console/Dialog";
import { EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Automations console (S49 / MC28, redesigned S50). The UI repeats what the
// engine enforces: bounded triggers/actions, consent on shopper emails,
// frequency caps, quiet hours, dedupe, dry runs, and the disable-all
// switch. S50: disable-all and rule deletion now confirm via dialog (delete
// used to be an unconfirmed ✕); dry-run results toast AND persist in the
// run history.

const EMPTY = { name: "", trigger: "order_placed", conditions: { min_total: "", payment_method: "" }, action: { kind: "notify_merchant", subject: "", text: "" }, cap_per_day: 25, quiet_start: "", quiet_end: "" };

const RUN_COLUMNS = [
  { key: "status", header: "Status", width: "6rem" },
  { key: "event_key", header: "Event" },
  { key: "reason", header: "Reason" },
  { key: "created_at", header: "When", align: "right" },
  { key: "retry", header: "", width: "4rem" },
];

export default function AutomationsAdmin({ initial }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [form, setForm] = useState(null);
  const [editId, setEditId] = useState(null);
  const [pending, setPending] = useState(null); // one action key at a time
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null); // {kind: disable_all} | {kind: remove, id, name}

  async function refresh() {
    const r = await fetch("/api/admin/automations").then((r) => r.json()).catch(() => null);
    if (r?.ok) setData(r);
  }

  async function post(body) {
    const res = await fetch("/api/admin/automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  }

  // non-dialog actions: busy on the button, failures land in the banner
  async function act(key, body, okNote = null) {
    setPending(key);
    setErr(null);
    try {
      await post(body);
      if (okNote) toast.success(okNote);
      await refresh();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setPending(null);
    }
  }

  async function dryRun(a) {
    setPending(`dry:${a.id}`);
    setErr(null);
    try {
      const r = await post({ dry_run: { id: a.id } });
      toast.info(`Dry run on ${r.sample}: ${r.reason}`);
      await refresh(); // the dry run also lands in the run history below
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setPending(null);
    }
  }

  async function saveRule() {
    setPending("save");
    setErr(null);
    try {
      const payload = {
        ...form,
        quiet_start: form.quiet_start || null,
        quiet_end: form.quiet_end || null,
        conditions: {
          ...(form.conditions.min_total !== "" ? { min_total: Number(form.conditions.min_total) } : {}),
          ...(form.conditions.payment_method ? { payment_method: form.conditions.payment_method } : {}),
        },
      };
      await post({ automation: payload, id: editId, enabled: false });
      toast.success("Saved (paused — enable it when ready).");
      setForm(null);
      setEditId(null);
      await refresh();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setPending(null);
    }
  }

  const { disabled, automations, runs } = data;

  return (
    <>
      <PageHeader
        title="Automations"
        description="Bounded rules: a trigger, optional conditions, one action. Shopper emails send ONLY when the triggering order carried marketing consent. Every rule has a daily cap and optional quiet hours; the same event can never fire a rule twice. Dry runs send nothing."
        actions={
          <>
            {disabled ? (
              <Button variant="primary" busy={pending === "reenable"} onClick={() => act("reenable", { disable_all: { disabled: false } }, "Automations re-enabled.")}>
                Re-enable automations
              </Button>
            ) : (
              <Button variant="dangerOutline" onClick={() => setConfirm({ kind: "disable_all" })}>
                Disable ALL
              </Button>
            )}
            <Button
              icon={<Plus size={14} aria-hidden />}
              onClick={() => {
                setForm(EMPTY);
                setEditId(null);
                setErr(null);
              }}
            >
              New rule
            </Button>
          </>
        }
      />

      {disabled && (
        <Banner tone="danger" className="mb-4">
          Disable-all is active — no automation runs, regardless of its own switch.
        </Banner>
      )}
      {err && (
        <Banner tone="danger" className="mb-4">
          {err}
        </Banner>
      )}

      {automations.length === 0 && !form && (
        <Card>
          <EmptyState
            title="No rules yet"
            body="Rules save paused — nothing sends until you enable one."
            action={
              <Button
                size="sm"
                onClick={() => {
                  setForm(EMPTY);
                  setEditId(null);
                }}
              >
                New rule
              </Button>
            }
          />
        </Card>
      )}

      <ul className="space-y-3">
        {automations.map((a) => (
          <Card as="li" key={a.id}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={disabled ? "halted" : a.enabled ? "on" : "paused"} />
              <span className="font-semibold text-fg">{a.name}</span>
              <span className="text-xs text-fg-muted">
                {a.trigger} → {a.action.kind} · cap {a.cap_per_day}/day
                {a.quiet_start ? ` · quiet ${a.quiet_start}–${a.quiet_end}` : ""}
                {a.conditions.min_total != null ? ` · total ≥ ₹${a.conditions.min_total}` : ""}
                {a.conditions.payment_method ? ` · ${a.conditions.payment_method} only` : ""}
              </span>
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                <Button size="sm" busy={pending === `dry:${a.id}`} onClick={() => dryRun(a)}>
                  Dry run
                </Button>
                <Button size="sm" busy={pending === `enable:${a.id}`} onClick={() => act(`enable:${a.id}`, { enable: { id: a.id, enabled: !a.enabled } })}>
                  {a.enabled ? "Pause" : "Enable"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setForm({
                      name: a.name,
                      trigger: a.trigger,
                      conditions: { min_total: a.conditions.min_total ?? "", payment_method: a.conditions.payment_method ?? "" },
                      action: a.action,
                      cap_per_day: a.cap_per_day,
                      quiet_start: a.quiet_start || "",
                      quiet_end: a.quiet_end || "",
                    });
                    setEditId(a.id);
                    setErr(null);
                  }}
                >
                  Edit
                </Button>
                <Button size="sm" variant="dangerOutline" onClick={() => setConfirm({ kind: "remove", id: a.id, name: a.name })}>
                  Delete
                </Button>
              </span>
            </div>
          </Card>
        ))}
      </ul>

      {form && (
        <Card className="mt-5">
          <CardHeader title={editId ? "Edit rule" : "New rule"} description="Rules always save paused — enable them once you've dry-run the result." />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Rule name" htmlFor="auto-name">
              <Input id="auto-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Trigger" htmlFor="auto-trigger">
              <Select id="auto-trigger" value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })}>
                <option value="order_placed">When an order is placed</option>
                <option value="return_requested">When a return is requested</option>
              </Select>
            </Field>
            <Field label="Only if total ≥ (₹)" htmlFor="auto-min-total" hint="optional">
              <Input
                id="auto-min-total"
                type="number"
                min="0"
                value={form.conditions.min_total}
                onChange={(e) => setForm({ ...form, conditions: { ...form.conditions, min_total: e.target.value } })}
              />
            </Field>
            <Field label="Only this payment method" htmlFor="auto-payment" hint="optional">
              <Select id="auto-payment" value={form.conditions.payment_method} onChange={(e) => setForm({ ...form, conditions: { ...form.conditions, payment_method: e.target.value } })}>
                <option value="">any</option>
                <option value="cod">cod</option>
                <option value="razorpay">razorpay</option>
              </Select>
            </Field>
            <Field label="Action" htmlFor="auto-action">
              <Select id="auto-action" value={form.action.kind} onChange={(e) => setForm({ ...form, action: { ...form.action, kind: e.target.value } })}>
                <option value="notify_merchant">Email the store (support address)</option>
                <option value="email_customer">Email the shopper (needs their marketing consent on the order)</option>
              </Select>
            </Field>
            <Field label="Subject" htmlFor="auto-subject" hint="optional">
              <Input id="auto-subject" value={form.action.subject} onChange={(e) => setForm({ ...form, action: { ...form.action, subject: e.target.value } })} />
            </Field>
            <Field label="Message text" htmlFor="auto-text" className="sm:col-span-2">
              <Textarea id="auto-text" value={form.action.text} onChange={(e) => setForm({ ...form, action: { ...form.action, text: e.target.value } })} />
            </Field>
            <Field label="Cap per day" htmlFor="auto-cap">
              <Input id="auto-cap" type="number" min="1" max="500" value={form.cap_per_day} onChange={(e) => setForm({ ...form, cap_per_day: Number(e.target.value) || 25 })} />
            </Field>
            <div className="flex gap-2">
              <Field label="Quiet from" htmlFor="auto-quiet-start" hint="optional" className="flex-1">
                <Input id="auto-quiet-start" type="time" value={form.quiet_start} onChange={(e) => setForm({ ...form, quiet_start: e.target.value })} />
              </Field>
              <Field label="until" htmlFor="auto-quiet-end" className="flex-1">
                <Input id="auto-quiet-end" type="time" value={form.quiet_end} onChange={(e) => setForm({ ...form, quiet_end: e.target.value })} />
              </Field>
            </div>
          </div>
          <CardFooter>
            <Button variant="primary" busy={pending === "save"} onClick={saveRule}>
              Save rule (paused)
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setForm(null);
                setEditId(null);
              }}
            >
              Cancel
            </Button>
          </CardFooter>
        </Card>
      )}

      {runs.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Run history" description="Every fire, skip, dry run and failure — dedupe means an event key appears at most once per rule." />
          <Table
            dense
            columns={RUN_COLUMNS}
            rows={runs}
            renderCell={(r, col) => {
              switch (col.key) {
                case "status":
                  return <StatusBadge status={r.status} />;
                case "event_key":
                  return <span className="font-mono text-xs text-fg-muted">{r.event_key}</span>;
                case "reason":
                  return <span className="text-xs text-fg-muted">{r.reason}</span>;
                case "created_at":
                  return (
                    <span className="whitespace-nowrap text-xs text-fg-subtle">
                      {new Date(r.created_at).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
                    </span>
                  );
                case "retry":
                  return r.status === "failed" ? (
                    <Button size="sm" variant="ghost" busy={pending === `retry:${r.id}`} onClick={() => act(`retry:${r.id}`, { retry: { run: r.id } })}>
                      Retry
                    </Button>
                  ) : null;
                default:
                  return r[col.key];
              }
            }}
          />
        </Card>
      )}

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        tone="danger"
        title={confirm?.kind === "disable_all" ? "Disable ALL automations?" : `Delete "${confirm?.name}"?`}
        confirmLabel={confirm?.kind === "disable_all" ? "Disable all" : "Delete rule"}
        body={
          confirm?.kind === "disable_all"
            ? "Every rule stops immediately — nothing fires, regardless of each rule's own switch, until you re-enable. Nothing is queued for later; events that occur while disabled are simply never acted on."
            : "The rule is removed permanently. Its past runs stay in the history."
        }
        onConfirm={async () => {
          if (confirm.kind === "disable_all") {
            await post({ disable_all: { disabled: true } });
          } else {
            await post({ remove: { id: confirm.id } });
            toast.success("Rule deleted");
          }
          await refresh();
        }}
      />
    </>
  );
}
