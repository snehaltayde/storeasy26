"use client";

import { useState } from "react";
import Link from "next/link";
import { PlugZap, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardAction, CardDescription } from "@/components/ui/card";
import { PageHeader } from "@/components/kit/page-header";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { roleAllows } from "@/lib/platform/authz";
import { fmtDate } from "@/components/admin/media/media-words";
import { sendJson } from "@/components/admin/offers/ConfirmAction";

// Insights on the new UI (Phase 2 line 9, docs/UI.md). Ideas from this
// store's own numbers (lib/ai/insights.js: no shopper details, never another
// store's). Generate shows the budget left; with no AI provider set up it is
// disabled and the page says "not set up", nothing is mocked. Apply saves a
// DRAFT and links to the editor; only a founder's Publish puts it live.
// Writers (storefront.write) get Generate, Apply, Dismiss and Restore;
// support gets none of them in the markup. Reads (Try again, Show the
// numbers, Open in editor) carry data-read-control.
//   initial: { configured, budget, insights } | null (the read failed); role
const API = "/api/admin/insights";
const STATUS = { proposed: ["New", "info"], applied: ["Saved as draft", "success"], dismissed: ["Dismissed", "muted"] };
const EDITOR_DOC = { hero: "doc_home", announcement: "doc_announcement" };
const PLACE = { hero: "the home page's hero", announcement: "the announcement bar" };

export function budgetLine(budget) {
  if (!budget) return null;
  const n = (v) => Number(v || 0).toLocaleString("en-IN");
  return budget.metered ? `${n(budget.remaining)} of ${n(budget.budget)} tokens left this month` : `Up to ${n(budget.budget)} tokens a month (not metered on this store)`;
}

export function InsightsList({ initial, role }) {
  const [data, setData] = useState(initial);
  const [failed, setFailed] = useState(!initial);
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null); // { tone, text, editor? }
  const canWrite = roleAllows(role, "storefront.write");

  async function reload() {
    try {
      const r = await sendJson(API, "GET");
      setData(r);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  async function act(key, body, done) {
    setPending(key);
    setNotice(null);
    try {
      const r = await sendJson(API, "POST", body);
      if (done) setNotice(done(r));
      await reload();
    } catch (e) {
      setNotice({ tone: "error", text: e.message });
    } finally {
      setPending(null);
    }
  }

  const configured = !!data?.configured;
  const spent = data?.budget?.metered && data.budget.remaining <= 0;
  const generateReason = !configured ? "Insights aren't set up for this store yet." : spent ? "This month's budget is used up." : null;

  const header = (
    <PageHeader
      title="Insights"
      description="Ideas from your own store's numbers. Applying one saves a draft; nothing goes live until you publish it."
      actions={
        data && (
          <RoleGate role={role} action="storefront.write" mode="hide">
            <Button
              type="button"
              disabled={!!generateReason || pending === "generate"}
              title={generateReason || undefined}
              onClick={() => act("generate", { generate: true }, (r) => ({ tone: "ok", text: `${r.insight?.proposals?.length || 0} new ideas.` }))}
            >
              <Sparkles aria-hidden />
              {pending === "generate" ? "Thinking…" : "Generate ideas"}
            </Button>
          </RoleGate>
        )
      }
    />
  );

  if (failed || !data) {
    return (
      <>
        {header}
        <EmptyState
          title="Couldn't read your insights just now."
          description="Nothing is lost. Try again in a moment."
          action={
            <Button type="button" variant="outline" data-read-control onClick={reload}>
              Try again
            </Button>
          }
        />
      </>
    );
  }

  const { insights = [] } = data;
  return (
    <>
      {header}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted-foreground" data-insights="budget">
        {configured ? <span className="font-mono tabular-nums">{budgetLine(data.budget)}</span> : null}
        {canWrite && configured && spent && <span className="text-warning-text">{generateReason}</span>}
        {!canWrite && <span>You have read-only access to insights.</span>}
      </div>
      {!configured && (
        <div role="note" data-insights="not-configured" className="mb-4 flex items-start gap-3 rounded-card border border-dashed border-border bg-card px-4 py-3.5">
          <PlugZap aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-foreground">Not set up</p>
            <p className="text-sm text-muted-foreground">Insights aren&rsquo;t set up for this store yet, so no ideas can be made. Ideas made before stay here.</p>
          </div>
        </div>
      )}
      {notice && (
        <div role={notice.tone === "error" ? "alert" : "status"} className={`mb-4 flex flex-wrap items-center gap-2 text-sm ${notice.tone === "error" ? "text-destructive" : "text-foreground"}`}>
          <span>{notice.text}</span>
          {notice.editor && (
            <Link href={notice.editor} data-read-control className="font-medium text-primary underline-offset-4 hover:underline">
              Open in editor
            </Link>
          )}
        </div>
      )}

      {insights.length === 0 ? (
        // Not set up and nothing made before: the note above already says it all.
        !configured ? null : <EmptyState title="No ideas yet." description={configured && canWrite ? "Generate the first ones: each idea names the numbers it came from." : "Ideas appear here once someone generates them."} />
      ) : (
        <ul className="space-y-3" data-insights="list">
          {insights.map((ins) => {
            const facts = Object.fromEntries((ins.facts || []).map((f) => [f.id, f.text]));
            const [label, tone] = STATUS[ins.status] || ["Unknown", "muted"];
            return (
              <li key={ins.id}>
                <Card data-insight={ins.id} className={ins.status === "dismissed" ? "opacity-70" : undefined}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Badge variant={tone}>{label}</Badge>
                      <span className="text-sm font-normal text-muted-foreground">{fmtDate(ins.created_at)}</span>
                    </CardTitle>
                    <CardDescription>{ins.proposals.length === 1 ? "1 idea" : `${ins.proposals.length} ideas`}</CardDescription>
                    {canWrite && (
                      <CardAction>
                        {ins.status === "dismissed" ? (
                          <RoleGate role={role} action="storefront.write" mode="hide">
                            <Button type="button" variant="ghost" size="sm" disabled={pending === `restore:${ins.id}`} onClick={() => act(`restore:${ins.id}`, { restore: { id: ins.id } })}>
                              Restore
                            </Button>
                          </RoleGate>
                        ) : (
                          <RoleGate role={role} action="storefront.write" mode="hide">
                            <Button type="button" variant="ghost" size="sm" disabled={pending === `dismiss:${ins.id}`} onClick={() => act(`dismiss:${ins.id}`, { dismiss: { id: ins.id } })}>
                              Dismiss
                            </Button>
                          </RoleGate>
                        )}
                      </CardAction>
                    )}
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-3">
                      {ins.proposals.map((p, i) => (
                        <li key={i} className="rounded-md border border-border p-3">
                          <p className="text-base font-medium text-foreground">{p.title}</p>
                          <p className="mt-0.5 text-sm text-muted-foreground">{p.mechanism}</p>
                          {p.evidence?.length > 0 && (
                            <details className="mt-2 text-[0.8125rem]">
                              <summary data-read-control className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                                Show the numbers ({p.evidence.length})
                              </summary>
                              <ul className="mt-1.5 space-y-1 border-l-2 border-border pl-3 text-muted-foreground">
                                {p.evidence.map((e) => (
                                  <li key={e}>{facts[e] || e}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                          {p.draft && ins.status !== "dismissed" && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted-foreground">
                              <span>Changes {PLACE[p.component] || p.component}</span>
                              <RoleGate role={role} action="storefront.write" mode="hide">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={pending === `apply:${ins.id}:${i}`}
                                  onClick={() =>
                                    act(`apply:${ins.id}:${i}`, { apply: { id: ins.id, index: i } }, (r) => ({ tone: "ok", text: r.note, editor: EDITOR_DOC[r.applied] ? `/admin/editor?doc=${EDITOR_DOC[r.applied]}` : null }))
                                  }
                                >
                                  Apply as draft
                                </Button>
                              </RoleGate>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
