"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Button } from "@/components/console/Button";
import { StatusBadge } from "@/components/console/Badge";
import { Field, Input, Textarea } from "@/components/console/fields";
import { ConfirmDialog } from "@/components/console/Dialog";
import { SkeletonText, ErrorState, EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/kit/toast";

// Case-study authoring for the marketing site's /customers (MK06). Publishing
// is gated on the server: documented consent + a measurement record.
const CS_FIELDS = [
  ["slug", "Slug"],
  ["title", "Title"],
  ["tenant_id", "Tenant (slug)"],
  ["consent_ref", "Consent ref (who approved, when, how)"],
  ["period", "Measurement period"],
  ["baseline", "Baseline"],
  ["method", "Method"],
  ["limitations", "Limitations"],
  ["confounders", "Confounders (or 'none known')"],
  ["quote", "Quote (with usage rights)"],
  ["quote_by", "Quote attribution"],
];
const EMPTY_RESULT = { metric: "", before: "", after: "" };
const EMPTY_CASE = { slug: "", title: "", tenant_id: "", consent_ref: "", period: "", baseline: "", method: "", limitations: "", confounders: "", results: [EMPTY_RESULT], quote: "", quote_by: "", body: "" };

export default function CaseStudiesPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cs, setCs] = useState(null); // case-study form
  const [deleting, setDeleting] = useState(null);
  const toast = useToast();

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch("/api/platform/case-studies");
      if (res.ok) setData(await res.json());
      else setErr(res.status === 401 ? "Your operator session has ended. Sign in again, then try again." : "The server didn't return the list. Try again in a moment.");
    } catch {
      setErr("The console couldn't reach the server. Check your connection and try again.");
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // throws on failure so ConfirmDialog can surface it inline; `what` names the
  // action in plain words ("save the draft"), `done` is the success toast.
  async function post(body, what, done) {
    let res;
    try {
      res = await fetch("/api/platform/case-studies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new Error(`Couldn't ${what}: the server didn't answer. Check your connection and try again.`);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = res.status === 401 ? "your operator session has ended — sign in again" : j.error && res.status !== 500 ? j.error : "something went wrong on the server — try again";
      throw new Error(`Couldn't ${what}: ${why}.`);
    }
    toast.success(done);
    refresh();
    return j;
  }

  // non-dialog actions: failures land as error toasts
  async function act(body, what, done) {
    setBusy(true);
    try {
      return await post(body, what, done);
    } catch (e) {
      toast.error(String(e?.message || e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const caseStudies = data?.caseStudies || [];
  const setResult = (i, k, v) => setCs({ ...cs, results: cs.results.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });

  return (
    <Card id="case-studies">
      <CardHeader
        title="Case studies (marketing site)"
        description="Publishing is gated: documented merchant consent + measurement period/method/results + limitations/confounders — a lift claim without its measurement record cannot publish."
        actions={
          <Button size="sm" onClick={() => setCs(EMPTY_CASE)}>
            New case study
          </Button>
        }
      />
      {err && <ErrorState title="Couldn't load case studies" detail={err} onRetry={refresh} />}
      {!data && !err && <SkeletonText lines={4} />}
      {data && caseStudies.length === 0 && !cs && (
        <EmptyState
          title="No case studies yet — write the first one as a draft."
          className="py-6"
          action={
            <Button size="sm" onClick={() => setCs(EMPTY_CASE)}>
              New case study
            </Button>
          }
        />
      )}
      {data && caseStudies.length > 0 && (
        <ul className="mt-2 space-y-1.5 text-xs text-fg-muted">
          {caseStudies.map((c) => (
            <li key={c.slug} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-fg">{c.title}</span>
              <span className="text-fg-subtle">/customers/{c.slug}</span>
              <StatusBadge status={c.published ? "live" : "draft"} label={c.published ? "Published" : "Draft"} />
              {!c.published && c.publishBlocks.length > 0 && (
                <span className="text-warning">
                  blocked: {c.publishBlocks[0]}
                  {c.publishBlocks.length > 1 ? ` (+${c.publishBlocks.length - 1})` : ""}
                </span>
              )}
              <span className="ml-auto flex gap-1.5">
                <Button size="sm" aria-label={`Edit ${c.title}`} onClick={() => setCs({ ...c, results: c.results.length ? c.results : [EMPTY_RESULT] })}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  aria-label={`${c.published ? "Unpublish" : "Publish"} ${c.title}`}
                  disabled={busy}
                  onClick={() =>
                    act(
                      { publish_case: { slug: c.slug, published: !c.published } },
                      c.published ? "unpublish this case study" : "publish this case study",
                      c.published ? `“${c.title}” is no longer on /customers.` : `“${c.title}” is live on /customers.`
                    )
                  }
                >
                  {c.published ? "Unpublish" : "Publish"}
                </Button>
                <Button size="sm" variant="dangerOutline" aria-label={`Delete ${c.title}`} disabled={busy} onClick={() => setDeleting(c)}>
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {cs && (
        <div className="mt-3 grid gap-3 rounded-ctl border border-edge bg-surface p-4 sm:grid-cols-2">
          {CS_FIELDS.map(([k, label]) => (
            <Field key={k} label={label} htmlFor={`cs-${k}`}>
              <Input id={`cs-${k}`} value={cs[k] || ""} onChange={(e) => setCs({ ...cs, [k]: e.target.value })} />
            </Field>
          ))}
          <Field label="Narrative body" htmlFor="cs-body" className="sm:col-span-2">
            <Textarea id="cs-body" value={cs.body || ""} onChange={(e) => setCs({ ...cs, body: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <p className="text-xs font-semibold text-fg">Measured results (before → after)</p>
            {cs.results.map((r, i) => (
              <div key={i} className="mt-1.5 flex gap-2">
                <Input aria-label={`Result ${i + 1} metric`} placeholder="metric" className="flex-1" value={r.metric} onChange={(e) => setResult(i, "metric", e.target.value)} />
                <Input aria-label={`Result ${i + 1} before`} placeholder="before" className="w-24" value={r.before} onChange={(e) => setResult(i, "before", e.target.value)} />
                <Input aria-label={`Result ${i + 1} after`} placeholder="after" className="w-24" value={r.after} onChange={(e) => setResult(i, "after", e.target.value)} />
              </div>
            ))}
            <Button size="sm" className="mt-2" onClick={() => setCs({ ...cs, results: [...cs.results, EMPTY_RESULT] })}>
              Add result
            </Button>
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button variant="primary" size="sm" busy={busy} onClick={async () => (await act({ case_study: cs }, "save the draft", cs.published ? "Draft saved. It is off /customers until you publish it again." : "Draft saved.")) && setCs(null)}>
              Save draft
            </Button>
            <Button size="sm" onClick={() => setCs(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete case study “${deleting?.title}”?`}
        tone="danger"
        confirmLabel="Delete case study"
        body="Removes the draft and its measurement record. A published page is taken down. This can't be undone."
        onConfirm={() => post({ delete_case: { slug: deleting.slug } }, "delete this case study", "Case study deleted.")}
      />
    </Card>
  );
}
