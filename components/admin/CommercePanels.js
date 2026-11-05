"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { ConfirmDialog } from "@/components/console/Dialog";
import { Field, Input } from "@/components/console/fields";
import { EmptyState } from "@/components/console/bits";
import { Switch } from "@/components/console/Switch";
import { BundleForm, reasonWords } from "@/components/admin/bundles/BundleForm";
import { formatMoney } from "@/lib/format";
import { stateLine } from "@/lib/commerce/bundle-words";

// S46 commerce-expansion panels (redesigned S50): BundlesPanel + QuizPanel,
// both on the Catalog page. They talk to /api/admin/bundles and
// /api/admin/quiz; money never moves from either. S50 fixes: deletes go
// through ConfirmDialog (the bundle one replaced a click-again-in-an-error-
// banner pattern; the quiz one was entirely unconfirmed), and the ✕ glyph
// buttons became labeled IconButtons.
// (ReturnsPanel was removed in S50 — the Orders page owns its returns view.)

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || "Request failed"), { body: json });
  return json;
}

// ---- Bundles (BE31 + SF18; P5-PANEL) -------------------------------------------
//
// P5-PANEL (COM-02): the form is components/admin/bundles/BundleForm.js
// (products picked, never typed; the slug derived; an edit keeps a live
// bundle live). Money is formatMoney with the store's currency. Every
// bundle-state sentence comes from lib/commerce/bundle-words.js, built from
// the structured reasons, never from the legacy problem strings. The card is
// the #bundles anchor the editor links to (/admin/catalog#bundles). A draft
// that would not pass the check is never offered Enable. Turning off or
// deleting a bundle the live home page shows says so first.
// P5-FIX2 (the P5-EDITOR review): when the home page could not be checked
// (usedOnHome null: listBundles could not read the live home), Disable asks
// first too, in neutral words, instead of turning the bundle off at once; the
// Delete confirm says the same. Only usedOnHome === false goes ahead at once.

const HOME_GOES = "Shoppers will stop seeing this bundle on your home page right away.";
export const HOME_UNKNOWN = "We couldn't check whether your home page uses this bundle.";
const homeUnknown = (b) => b != null && b.usedOnHome == null;
// Disable asks first unless the home page was read and does not use it.
export const disableAsksFirst = (b) => b?.usedOnHome !== false;

const reasonList = (reasons, currency) => (reasons || []).map((r) => reasonWords(r, currency)).filter(Boolean);

export function BundlesPanel({ initial, currency }) {
  const [bundles, setBundles] = useState(initial || []);
  const [cur, setCur] = useState(currency);
  const [form, setForm] = useState(null); // null = closed | { key, initial }
  const [toggling, setToggling] = useState(null); // bundle id
  const [err, setErr] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // bundle
  const [confirmOff, setConfirmOff] = useState(null); // bundle on the live home
  const money = (n) => formatMoney(n, cur ?? undefined);

  async function refresh() {
    const data = await fetch("/api/admin/bundles").then((r) => r.json()).catch(() => null);
    if (data?.ok) {
      setBundles(data.bundles);
      if (data.currency) setCur(data.currency);
    }
  }

  async function setEnabled(b, enabled) {
    setToggling(b.id);
    setErr(null);
    try {
      await postJson("/api/admin/bundles", { enable: { id: b.id, enabled } });
      await refresh();
    } catch (e) {
      const said = reasonList(e?.body?.reasons, cur);
      setErr(said.length ? `${b.title}: ${said.join(" · ")}` : String(e?.message || e));
    } finally {
      setToggling(null);
    }
  }

  const openForm = (b) => {
    setErr(null);
    setForm({ key: b ? b.id : `new-${Date.now()}`, initial: b || null });
  };

  return (
    <Card id="bundles">
      <CardHeader
        title="Bundles"
        description="A bundle is a set price for a fixed group of products, applied automatically in the cart. It can be shown to shoppers only when every product is in stock and the price saves money."
        actions={
          <Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={() => openForm(null)}>
            New bundle
          </Button>
        }
      />

      {err && <Banner tone="danger" className="mb-3">{err}</Banner>}

      {bundles.length === 0 && !form ? (
        <EmptyState title="No bundles yet" body="Create one to sell a fixed group of products at a set price." className="py-6" />
      ) : (
        <ul className="space-y-2">
          {bundles.map((b) => {
            const state = b.compat?.state;
            const ready = state === "available";
            const said = reasonList(b.compat?.reasons, cur);
            return (
              <li key={b.id} className="rounded-ctl border border-edge p-3 text-sm" data-bundle-id={b.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{b.title}</span>
                  <span className="font-mono text-xs text-fg-subtle">/bundles/{b.slug}</span>
                  <StatusBadge status={b.enabled ? "live" : "draft"} />
                  {b.usedOnHome && <span className="text-xs text-fg-muted">On your home page</span>}
                  <span className="ml-auto text-xs tabular-nums text-fg-muted">
                    {money(b.bundle_price)} {b.compat?.componentsSum ? <s className="text-fg-subtle">{money(b.compat.componentsSum)}</s> : null}
                  </span>
                </div>
                {state && !ready && (
                  <Banner tone="warning" className="mt-2" title={b.enabled ? stateLine(state, b.compat?.reasons, { currency: cur ?? undefined }) : undefined}>
                    {said.length ? said.join(" · ") : null}
                  </Banner>
                )}
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {b.enabled ? (
                    <Button size="sm" busy={toggling === b.id} disabled={!!toggling && toggling !== b.id} onClick={() => (disableAsksFirst(b) ? setConfirmOff(b) : setEnabled(b, false))}>
                      Disable
                    </Button>
                  ) : ready ? (
                    <Button size="sm" busy={toggling === b.id} disabled={!!toggling && toggling !== b.id} onClick={() => setEnabled(b, true)}>
                      Enable
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => openForm(b)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="dangerOutline" onClick={() => setConfirmDelete(b)}>
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {form && (
        <div className="mt-4">
          <BundleForm key={form.key} initial={form.initial} currency={cur} onSaved={refresh} onCancel={() => setForm(null)} />
        </div>
      )}

      <ConfirmDialog
        open={!!confirmOff}
        onClose={() => setConfirmOff(null)}
        title="Disable bundle"
        tone="danger"
        confirmLabel="Disable"
        body={
          confirmOff && (
            <>
              <strong>{confirmOff.title}</strong> stops being sold as a bundle. {homeUnknown(confirmOff) ? `${HOME_UNKNOWN} Turn it off anyway?` : HOME_GOES}
            </>
          )
        }
        onConfirm={async () => {
          const b = confirmOff;
          await postJson("/api/admin/bundles", { enable: { id: b.id, enabled: false } });
          await refresh();
        }}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete bundle"
        tone="danger"
        confirmLabel="Delete bundle"
        body={
          confirmDelete && (
            <>
              Removes <strong>{confirmDelete.title}</strong> permanently. Its linked cart offer goes too, so shoppers can no longer buy it as a bundle.
              {confirmDelete.usedOnHome ? ` ${HOME_GOES}` : homeUnknown(confirmDelete) ? ` ${HOME_UNKNOWN} Delete it anyway?` : ""}
            </>
          )
        }
        onConfirm={async () => {
          await postJson("/api/admin/bundles", { remove: { id: confirmDelete.id } });
          await refresh();
        }}
      />
    </Card>
  );
}

// ---- Quiz editor (SF19) -------------------------------------------------------

const EMPTY_QUIZ = { slug: "", title: "", intro: "", enabled: true, questions: [{ prompt: "", options: [{ label: "", tags: "" }, { label: "", tags: "" }] }] };

const toEditor = (q) => ({ ...q, questions: q.questions.map((qq) => ({ prompt: qq.prompt, options: qq.options.map((o) => ({ label: o.label, tags: (o.tags || []).join(", ") })) })) });
const fromEditor = (q) => ({ slug: q.slug, title: q.title, intro: q.intro, questions: q.questions.map((qq) => ({ prompt: qq.prompt, options: qq.options.map((o) => ({ label: o.label, tags: o.tags.split(",").map((t) => t.trim()).filter(Boolean) })) })) });

export function QuizPanel({ initial }) {
  const [quizzes, setQuizzes] = useState(initial || []);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(null); // slug being fetched
  const [err, setErr] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // quiz

  async function refresh() {
    const data = await fetch("/api/admin/quiz").then((r) => r.json()).catch(() => null);
    if (data?.ok) setQuizzes(data.quizzes);
  }

  async function openEdit(slug) {
    setOpening(slug);
    setErr(null);
    try {
      const data = await fetch(`/api/admin/quiz?slug=${encodeURIComponent(slug)}`).then((r) => r.json()).catch(() => null);
      if (!data?.ok) throw new Error(data?.error || "Couldn’t load the quiz");
      setForm(toEditor(data.quiz));
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setOpening(null);
    }
  }

  async function saveQuiz() {
    setSaving(true);
    setErr(null);
    try {
      await postJson("/api/admin/quiz", { quiz: fromEditor(form), enabled: form.enabled });
      setForm(null);
      await refresh();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  const setQ = (i, patch) => setForm({ ...form, questions: form.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const setOpt = (i, k, patch) => setQ(i, { options: form.questions[i].options.map((o, l) => (l === k ? { ...o, ...patch } : o)) });

  return (
    <Card>
      <CardHeader
        title="Product-finder quiz"
        description={<>Deterministic — options carry catalog tags, answers tally tags, and the top tags pick matching available products. Same answers, same picks, every time. Lives at /quiz/&lt;slug&gt;.</>}
        actions={
          <Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={() => { setForm(EMPTY_QUIZ); setErr(null); }}>
            New quiz
          </Button>
        }
      />

      {err && !form && <Banner tone="danger" className="mb-3">{err}</Banner>}

      {quizzes.length === 0 && !form ? (
        <EmptyState title="No quizzes yet" body="Build one to guide shoppers to the right products." className="py-6" />
      ) : (
        <ul className="space-y-2 text-sm">
          {quizzes.map((qz) => (
            <li key={qz.slug} className="flex flex-wrap items-center gap-2 rounded-ctl border border-edge px-3 py-2">
              <span className="font-medium text-fg">{qz.title}</span>
              <span className="font-mono text-xs text-fg-subtle">/quiz/{qz.slug}</span>
              <StatusBadge status={qz.enabled ? "live" : "off"} />
              <span className="ml-auto flex gap-2">
                <Button size="sm" busy={opening === qz.slug} disabled={!!opening && opening !== qz.slug} onClick={() => openEdit(qz.slug)}>
                  Edit
                </Button>
                <Button size="sm" variant="dangerOutline" onClick={() => setConfirmDelete(qz)}>
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {form && (
        <div className="mt-4 rounded-ctl border border-edge bg-surface-sunken p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Slug" htmlFor="quiz-slug">
              <Input id="quiz-slug" mono placeholder="find-your-stack" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
            </Field>
            <Field label="Title" htmlFor="quiz-title">
              <Input id="quiz-title" placeholder="Find your stack" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Intro" htmlFor="quiz-intro" hint="Optional — shown above the first question." className="sm:col-span-2">
              <Input id="quiz-intro" value={form.intro} onChange={(e) => setForm({ ...form, intro: e.target.value })} />
            </Field>
          </div>

          {form.questions.map((qq, i) => (
            <div key={i} className="mt-3 rounded-ctl border border-edge bg-surface p-3">
              <div className="flex items-center gap-2">
                <Input className="flex-1" aria-label={`Question ${i + 1}`} placeholder={`Question ${i + 1}`} value={qq.prompt} onChange={(e) => setQ(i, { prompt: e.target.value })} />
                {form.questions.length > 1 && (
                  <IconButton label={`Remove question ${i + 1}`} icon={<X size={14} aria-hidden />} onClick={() => setForm({ ...form, questions: form.questions.filter((_, j) => j !== i) })} />
                )}
              </div>
              {qq.options.map((o, k) => (
                <div key={k} className="mt-2 flex items-center gap-2 pl-3">
                  <Input className="flex-1" aria-label={`Question ${i + 1} option ${k + 1}`} placeholder={`Option ${k + 1}`} value={o.label} onChange={(e) => setOpt(i, k, { label: e.target.value })} />
                  <Input className="flex-1" aria-label={`Question ${i + 1} option ${k + 1} tags`} placeholder="tags, comma, separated" value={o.tags} onChange={(e) => setOpt(i, k, { tags: e.target.value })} />
                  {qq.options.length > 2 && (
                    <IconButton label={`Remove option ${k + 1} of question ${i + 1}`} icon={<X size={14} aria-hidden />} onClick={() => setQ(i, { options: qq.options.filter((_, l) => l !== k) })} />
                  )}
                </div>
              ))}
              {qq.options.length < 6 && (
                <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} className="ml-3 mt-2" onClick={() => setQ(i, { options: [...qq.options, { label: "", tags: "" }] })}>
                  Add option
                </Button>
              )}
            </div>
          ))}
          {form.questions.length < 10 && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={13} aria-hidden />}
              className="mt-3"
              onClick={() => setForm({ ...form, questions: [...form.questions, { prompt: "", options: [{ label: "", tags: "" }, { label: "", tags: "" }] }] })}
            >
              Add question
            </Button>
          )}

          <div className="mt-4 flex items-center gap-2">
            <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Live on the storefront" />
            <span className="text-xs text-fg-muted">Live on the storefront</span>
          </div>

          {err && <Banner tone="danger" className="mt-3">{err}</Banner>}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" busy={saving} onClick={saveQuiz}>
              Save quiz
            </Button>
            <Button variant="ghost" disabled={saving} onClick={() => { setForm(null); setErr(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete quiz"
        tone="danger"
        confirmLabel="Delete quiz"
        body={
          confirmDelete && (
            <>
              Removes <strong>{confirmDelete.title}</strong> permanently — /quiz/{confirmDelete.slug} stops working for shoppers.
            </>
          )
        }
        onConfirm={async () => {
          await postJson("/api/admin/quiz", { remove: { slug: confirmDelete.slug } });
          await refresh();
        }}
      />
    </Card>
  );
}
