"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/kit/page-header";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { sendJson } from "@/components/admin/offers/ConfirmAction";
import { BudgetMeter } from "./BudgetMeter";
import { RunHistory } from "./RunHistory";
import { ProductPicker } from "./ProductPicker";

// The AI copilot (Phase 9 line 5, docs/UI.md). Every role reads the page; the
// run buttons render only for a role whose action allows them (`can`, from
// lib/ai/view.js; support gets none). Until it is installed the page is an
// install prompt (apps.manage installs). Everything a run makes is a draft or
// an offer that is off; the notice links to each one.
//   initial: copilotView(role) | null (the read failed); role
const API = "/api/admin/copilot";

const TASK_CARDS = [
  { task: "starter", title: "Starter store", description: "A home page draft: a hero, a row of featured products, a short about text and shopper questions. If your home page has unpublished edits, the draft is kept in Earlier versions instead." },
  { task: "product_seo", title: "Product SEO and FAQs", description: "For up to 10 products: a search title, a search description and up to six questions with answers, as drafts in the editor." },
  { task: "offer_ideas", title: "Offer ideas", description: "Up to three offers, created switched off and never more than 30% off. Try each one in the simulator before turning it on." },
];

export function CopilotTasks({ initial, role }) {
  const [data, setData] = useState(initial);
  const [failed, setFailed] = useState(!initial);
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null); // { tone, text, refs, removed }
  const [chosen, setChosen] = useState([]);

  async function reload() {
    try {
      setData(await sendJson(API, "GET"));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  async function run(task) {
    setPending(task);
    setNotice(null);
    try {
      const r = await sendJson(API, "POST", { task, ...(task === "product_seo" ? { productIds: chosen } : {}) });
      setNotice({ tone: r.refs?.length ? "success" : "warning", text: r.message, refs: r.refs || [], removed: r.refs?.length ? r.removed || [] : [] });
      if (task === "product_seo" && r.refs?.length) setChosen([]);
    } catch (e) {
      setNotice({ tone: "error", text: e.message, refs: [], removed: [] });
    } finally {
      setPending(null);
      await reload();
    }
  }

  async function install() {
    setPending("install");
    setNotice(null);
    try {
      await sendJson("/api/admin/apps", "POST", { install: { pluginId: "ai-copilot", scopes: [] } });
    } catch (e) {
      setNotice({ tone: "error", text: e.message, refs: [], removed: [] });
    } finally {
      setPending(null);
      await reload();
    }
  }

  const header = <PageHeader title="Copilot" description="Ask the AI for first drafts. It reads your catalog and brand only, never your customers or orders, and nothing goes live until you publish it." />;

  if (failed || !data) {
    return (
      <>
        {header}
        <EmptyState
          title="We couldn't load the copilot."
          description="Nothing was changed. Try again in a moment."
          action={
            <Button type="button" variant="outline" data-read-control onClick={reload}>
              Try again
            </Button>
          }
        />
      </>
    );
  }

  const { state, can, products, history } = data;

  if (!state.installed) {
    return (
      <>
        {header}
        <Card data-copilot-install>
          <CardHeader>
            <CardTitle>Install the AI copilot</CardTitle>
            <CardDescription>It adds nothing to your storefront. It writes drafts and switched-off offers for you to review, within a daily AI budget.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <RoleGate role={role} action="apps.manage" mode="hide">
              <Button type="button" onClick={install} disabled={pending === "install"} data-copilot-install-button>
                {pending === "install" ? "Installing…" : "Install"}
              </Button>
            </RoleGate>
            <Link href="/admin/apps" data-read-control className="inline-flex min-h-11 items-center rounded-sm text-sm text-primary underline-offset-4 hover:underline md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              See it in Apps
            </Link>
          </CardContent>
        </Card>
        {notice ? (
          <Alert role="alert" variant="destructive" className="mt-4">
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        ) : null}
      </>
    );
  }

  const blocked = state.killed ? "Storeasy has turned the AI copilot off for now." : !state.enabled ? "The AI copilot is turned off in Apps." : !state.configured ? `The copilot isn't set up yet. ${state.reason || ""}` : null;

  return (
    <>
      {header}
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Today's AI budget</CardTitle>
          </CardHeader>
          <CardContent>
            <BudgetMeter usage={state.usage} />
          </CardContent>
        </Card>

        {blocked ? (
          <Alert data-copilot-blocked>
            <AlertDescription>{blocked}</AlertDescription>
          </Alert>
        ) : null}

        {notice ? (
          <Alert role={notice.tone === "error" ? "alert" : "status"} variant={notice.tone === "error" ? "destructive" : "default"} data-copilot-notice={notice.tone}>
            <AlertDescription>
              <p>{notice.text}</p>
              {notice.removed.length ? <p className="mt-1 text-muted-foreground">{notice.removed.join(" ")}</p> : null}
              {notice.refs.length ? (
                <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  {notice.refs.map((ref) => (
                    <Link key={`${ref.kind}:${ref.id}`} href={ref.href} data-read-control data-copilot-draft={ref.kind} className="inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 hover:underline md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                      {ref.kind === "offer" ? `${ref.label} (off, try it in the simulator)` : `Open ${ref.label} in the editor`}
                    </Link>
                  ))}
                </span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-3">
          {TASK_CARDS.map((t) => (
            <Card key={t.task} data-copilot-task={t.task} className="h-full">
              <CardHeader>
                <CardTitle>{t.title}</CardTitle>
                <CardDescription>{t.description}</CardDescription>
              </CardHeader>
              {can[t.task] ? (
                <CardContent className="mt-auto space-y-3">
                  {t.task === "product_seo" ? <ProductPicker products={products} selected={chosen} onChange={setChosen} /> : null}
                  <Button type="button" onClick={() => run(t.task)} disabled={Boolean(blocked) || pending !== null || (t.task === "product_seo" && !chosen.length)} data-copilot-run={t.task}>
                    {pending === t.task ? "Writing drafts…" : "Write drafts"}
                  </Button>
                </CardContent>
              ) : null}
            </Card>
          ))}
        </div>

        <section className="space-y-3">
          <h2 className="text-base font-semibold">Recent runs</h2>
          <RunHistory history={history} />
        </section>
      </div>
    </>
  );
}
