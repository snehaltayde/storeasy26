"use client";

import { useState } from "react";
import Link from "next/link";
import { Circle, CircleCheck } from "lucide-react";
import { Card } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { useToast } from "@/components/console/Toast";
import { cx } from "@/components/console/cx";

// Onboarding checklist (S41 / MC02, redesigned S50). Auto items derive from
// real state and just link where the work happens; manual items (preview,
// test order, launch) are explicit check-offs — launch stays gated until
// everything above it is done (server-enforced too). Errors are persistent
// Banners; check-offs are toasts; the launched state is a success Banner.
// P6-ONBOARD (PUB-12, US-41): a step may carry `actions` (documents stores
// only, the policies step): "Start a privacy page" / "Start a returns page"
// POST /api/admin/policy-start { kind }; "I've read it" POSTs { markRead:
// { id, revision } }; a link action is a link. After each answer the
// checklist is read again (GET /api/admin/setup). A refusal shows its own
// plain words. Items with no actions render as before.
export const POLICY_START_URL = "/api/admin/policy-start";
export const SETUP_URL = "/api/admin/setup";
export const SETUP_WORDS = Object.freeze({
  notLegalAdvice: "These are starting points, not legal advice.",
  failed: "That didn't work, so nothing changed. Try again in a minute.",
  notAllowed: "Only the store owner or an admin can do that, so nothing changed.",
  markedRead: "Marked as read. This page now counts as yours.",
});
const actionKey = (a) => (a.type === "startPolicy" ? `start:${a.kind}` : a.type === "markPolicyRead" ? `read:${a.id}` : `link:${a.href}`);
const launchedOn = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : null);

export default function SetupAdmin({ initial }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [busyStep, setBusyStep] = useState(null);
  const [error, setError] = useState(null);

  if (!data.supported) {
    return <Banner tone="neutral">{data.reason}</Banner>;
  }

  async function mark(step, done) {
    setBusyStep(step);
    setError(null);
    try {
      const res = await fetch("/api/admin/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step, done }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        setData(json);
        toast.success(step === "launch" && done ? "Launched — congratulations!" : done ? "Marked done." : "Undone.");
      } else {
        setError(json.error || `Failed (${res.status})`);
      }
    } finally {
      setBusyStep(null);
    }
  }

  // reads the checklist again; a failed read keeps what is on screen
  async function reload() {
    try {
      const res = await fetch(SETUP_URL, { method: "GET", headers: { Accept: "application/json" } });
      const json = await res.json().catch(() => null);
      if (res.ok && json && json.ok) setData(json);
    } catch {}
  }

  async function act(action) {
    const key = actionKey(action);
    setBusyStep(key);
    setError(null);
    try {
      const body = action.type === "startPolicy" ? { kind: action.kind } : { markRead: { id: action.id, revision: action.revision } };
      let res = null;
      let json = {};
      try {
        res = await fetch(POLICY_START_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        json = (await res.json().catch(() => ({}))) || {};
      } catch {
        res = null;
      }
      if (res && res.ok && json.ok) {
        await reload();
        toast.success(json.message || (action.type === "markPolicyRead" ? SETUP_WORDS.markedRead : "Done."));
      } else {
        // POLICY_PAGE_EXISTS, a 403 or a 409: the server's own plain words
        setError(typeof json.error === "string" && json.error ? json.error : res?.status === 403 ? SETUP_WORDS.notAllowed : SETUP_WORDS.failed);
        if (res && res.status === 409) await reload();
      }
    } finally {
      setBusyStep(null);
    }
  }

  const pct = Math.round((data.doneCount / data.total) * 100);
  const busy = busyStep !== null;

  return (
    <div className="space-y-4">
      {error && <Banner tone="danger">{error}</Banner>}
      {data.launched && (
        <Banner tone="success" title="Launched">
          {launchedOn(data.launchedAt) ? `Launched on ${launchedOn(data.launchedAt)}. ` : ""}
          Publish releases any time; this checklist stays here for reference.
        </Banner>
      )}

      <Card className="p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold text-fg">{data.launched ? "Launched" : "Getting your store live"}</span>
          <span className="text-xs tabular-nums text-fg-muted">
            {data.doneCount}/{data.total}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-valuenow={data.doneCount} aria-valuemin={0} aria-valuemax={data.total} aria-label="Setup progress">
          <div className="h-full rounded-full bg-primary motion-safe:transition-all" style={{ width: `${pct}%` }} />
        </div>
      </Card>

      <ol className="space-y-2">
        {data.items.map((item) => (
          <li key={item.id}>
            <Card as="div" padded={false} className={cx("flex items-start gap-3 p-4", item.done && "bg-surface-sunken", item.gated && "opacity-60")}>
              {item.done ? (
                <CircleCheck size={16} className="mt-0.5 shrink-0 text-success" aria-hidden />
              ) : (
                <Circle size={16} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className={cx("flex items-center gap-2 text-sm font-semibold", item.done ? "text-fg-muted" : "text-fg")}>
                  {item.label}
                  <Badge tone={item.kind === "manual" ? "info" : "neutral"}>{item.kind === "manual" ? "You confirm" : "Auto"}</Badge>
                </p>
                <p className="mt-0.5 text-xs text-fg-muted">{item.hint}</p>
                {Array.isArray(item.actions) && item.actions.length > 0 && (
                  <div className="mt-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.actions.map((a) =>
                        a.type === "link" ? (
                          <Link
                            key={actionKey(a)}
                            href={a.href}
                            className="inline-flex items-center justify-center rounded-ctl border border-edge-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-fg focus-ring hover:bg-surface-muted motion-safe:transition-colors"
                          >
                            {a.label}
                          </Link>
                        ) : (
                          <Button key={actionKey(a)} size="sm" variant="secondary" busy={busyStep === actionKey(a)} disabled={busy && busyStep !== actionKey(a)} onClick={() => act(a)}>
                            {a.label}
                          </Button>
                        ),
                      )}
                    </div>
                    <p className="mt-1.5 text-xs text-fg-muted">{SETUP_WORDS.notLegalAdvice}</p>
                  </div>
                )}
              </div>
              <span className="flex shrink-0 items-center gap-2">
                {!item.done && !item.gated && (
                  <Link
                    href={item.href}
                    className="inline-flex items-center justify-center rounded-ctl border border-edge-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-fg focus-ring hover:bg-surface-muted motion-safe:transition-colors"
                  >
                    Open
                  </Link>
                )}
                {item.kind === "manual" &&
                  (item.done ? (
                    item.id !== "launch" && (
                      <Button size="sm" variant="ghost" busy={busyStep === item.id} disabled={busy && busyStep !== item.id} onClick={() => mark(item.id, false)}>
                        Undo
                      </Button>
                    )
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      busy={busyStep === item.id}
                      disabled={item.gated || (busy && busyStep !== item.id)}
                      onClick={() => mark(item.id, true)}
                    >
                      {item.id === "launch" ? "Launch" : "Mark done"}
                    </Button>
                  ))}
              </span>
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}
