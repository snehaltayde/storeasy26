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
