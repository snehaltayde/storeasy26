"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { PageHeader } from "@/components/console/PageHeader";
import { Card } from "@/components/console/Card";
import { Button } from "@/components/console/Button";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";
import { humanizeStatus } from "@/components/console/status";

// AI insights console (S47 / MC19, redesigned S50). Honest everywhere:
// unconfigured says so (no mock), the budget is visible, every proposal
// shows the facts it cites, and "apply" makes a DRAFT the Releases tab
// ships — the AI cannot publish, refund or touch prices.

// Insight lifecycle chips (new/applied/dismissed) aren't in the shared
// status vocabulary (status.js isn't this slice's file to grow), so the
// tone is computed inline; raw status stays on title like StatusBadge.
const insightTone = (s) => (s === "applied" ? "success" : s === "dismissed" ? "neutral" : "info");

export default function InsightsAdmin({ initial }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [pending, setPending] = useState(null); // one action key at a time
  const [err, setErr] = useState(null);

  async function refresh() {
    const r = await fetch("/api/admin/insights").then((r) => r.json()).catch(() => null);
    if (r?.ok) setData(r);
  }

  async function post(body) {
    const res = await fetch("/api/admin/insights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  }

  async function act(key, body, note = null) {
    setPending(key);
    setErr(null);
    try {
      const r = await post(body);
      if (note) toast.success(typeof note === "function" ? note(r) : note);
      await refresh();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setPending(null);
    }
  }

  const { configured, model, budget, insights } = data;
  const factById = (ins) => Object.fromEntries((ins.facts || []).map((f) => [f.id, f.text]));

  return (
    <>
      <PageHeader
        title="Insights"
        description={
          <>
            Evidence-linked suggestions from this store&rsquo;s own numbers (catalog, sales, zero-result searches — never another store&rsquo;s,
            never shopper PII). The assistant proposes; <strong>you</strong> review, and anything applied is a draft until you publish a release. It
            cannot publish, refund or change prices.
          </>
        }
        actions={
          <Button
            variant="primary"
            icon={<Sparkles size={14} aria-hidden />}
            busy={pending === "generate"}
            disabled={!configured}
            onClick={() => act("generate", { generate: true }, "New insights generated.")}
          >
            {pending === "generate" ? "Thinking…" : "Generate insights"}
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {configured && <Badge tone="neutral">model: {model}</Badge>}
        <Badge tone="neutral">
          {budget.metered
            ? `budget: ${budget.spent.toLocaleString("en-IN")} / ${budget.budget.toLocaleString("en-IN")} tokens this month`
            : `budget: ${budget.budget.toLocaleString("en-IN")} tokens (unmetered in legacy mode)`}
        </Badge>
      </div>

      {!configured && (
        <Banner tone="warning" className="mb-4">
          Not configured — set <code className="font-mono text-xs">ANTHROPIC_API_KEY</code>. Nothing here is mocked.
        </Banner>
      )}
      {err && (
        <Banner tone="danger" className="mb-4">
          {err}
        </Banner>
      )}

      {insights.length === 0 && (
        <Card>
          <EmptyState
            title="No insights yet"
            body={configured ? "Generate the first batch — each one cites the store facts it reasoned from." : "Configure the API key, then generate the first batch."}
          />
        </Card>
      )}

      <ul className="space-y-3">
        {insights.map((ins) => (
          <Card as="li" key={ins.id} className={ins.status === "dismissed" ? "opacity-60" : ""}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
              <Badge tone={insightTone(ins.status)} title={String(ins.status)}>
                {humanizeStatus(ins.status)}
              </Badge>
              <span>{new Date(ins.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
              <span>
                · {ins.model} · {ins.tokens_in + ins.tokens_out} tokens
              </span>
              <span className="ml-auto">
                {ins.status !== "dismissed" ? (
                  <Button size="sm" variant="ghost" busy={pending === `dismiss:${ins.id}`} onClick={() => act(`dismiss:${ins.id}`, { dismiss: { id: ins.id } })}>
                    Dismiss
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" busy={pending === `restore:${ins.id}`} onClick={() => act(`restore:${ins.id}`, { restore: { id: ins.id } })}>
                    Restore
                  </Button>
                )}
              </span>
            </div>
            <ul className="mt-3 space-y-3">
              {ins.proposals.map((p, i) => (
                <li key={i} className="rounded-ctl bg-surface-sunken p-3 text-sm">
                  <p className="font-semibold text-fg">{p.title}</p>
                  <p className="mt-0.5 text-fg-muted">{p.mechanism}</p>
                  <details className="mt-1.5">
                    <summary className="cursor-pointer rounded text-xs text-fg-subtle focus-ring hover:text-fg">Evidence ({p.evidence.length})</summary>
                    <ul className="mt-1.5 space-y-1 border-l-2 border-edge pl-3 text-xs text-fg-muted">
                      {p.evidence.map((e) => (
                        <li key={e}>{factById(ins)[e] || e}</li>
                      ))}
                    </ul>
                  </details>
                  {p.draft && ins.status !== "dismissed" && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-fg-subtle">draft → {p.component}</span>
                      <Button
                        size="sm"
                        busy={pending === `apply:${ins.id}:${i}`}
                        onClick={() => act(`apply:${ins.id}:${i}`, { apply: { id: ins.id, index: i } }, (r) => r.note)}
                      >
                        Apply as draft
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </ul>
    </>
  );
}
