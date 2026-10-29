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
import { VariantPicker } from "@/components/admin/cms/RefPicker";

// S46 commerce-expansion panels (redesigned S50): BundlesPanel + QuizPanel,
// both on the Catalog page. They talk to /api/admin/bundles and
// /api/admin/quiz; money never moves from either. S50 fixes: deletes go
// through ConfirmDialog (the bundle one replaced a click-again-in-an-error-
// banner pattern; the quiz one was entirely unconfirmed), and the ✕ glyph
// buttons became labeled IconButtons.
// (ReturnsPanel was removed in S50 — the Orders page owns its returns view.)

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json;
}

// ---- Bundles (BE31 + SF18) ----------------------------------------------------

const EMPTY_BUNDLE = { id: null, slug: "", title: "", description: "", bundle_price: "", items: [{ variantId: "", quantity: 1 }, { variantId: "", quantity: 1 }] };

export function BundlesPanel({ initial }) {
  const [bundles, setBundles] = useState(initial || []);
  const [form, setForm] = useState(null); // null = closed
  const [compat, setCompat] = useState(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(null); // "draft" | "enable"
  const [toggling, setToggling] = useState(null); // bundle id
  const [err, setErr] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // bundle
  const [pickerRow, setPickerRow] = useState(null); // component index with the variant picker open (S53 B2)

  async function refresh() {
    const data = await fetch("/api/admin/bundles").then((r) => r.json()).catch(() => null);
    if (data?.ok) setBundles(data.bundles);
  }

  async function toggle(b) {
    setToggling(b.id);
    setErr(null);
    try {
      await postJson("/api/admin/bundles", { enable: { id: b.id, enabled: !b.enabled } });
      await refresh();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setToggling(null);
    }
  }

  async function check() {
    setChecking(true);
    setErr(null);
    try {
      const r = await postJson("/api/admin/bundles", { check: { items: form.items, bundle_price: Number(form.bundle_price) } });
      setCompat(r.compat);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setChecking(false);
    }
  }

  async function save(enable) {
    setSaving(enable ? "enable" : "draft");
    setErr(null);
    try {
      await postJson("/api/admin/bundles", { bundle: { ...form, bundle_price: Number(form.bundle_price), enable } });
      setForm(null);
      setCompat(null);
      await refresh();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(null);
    }
  }

  const setItem = (i, patch) => setForm({ ...form, items: form.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  return (
    <Card>
      <CardHeader
        title="Bundles"
        description="A bundle is a set price for a fixed group of variants — applied automatically in the cart through the offers engine. Enabling checks that every component is live and the price actually saves."
        actions={
          <Button size="sm" icon={<Plus size={13} aria-hidden />} onClick={() => { setForm(EMPTY_BUNDLE); setCompat(null); setErr(null); }}>
            New bundle
          </Button>
        }
      />

      {err && !form && <Banner tone="danger" className="mb-3">{err}</Banner>}

      {bundles.length === 0 && !form ? (
        <EmptyState title="No bundles yet" body="Create one to sell a fixed group of variants at a set price." className="py-6" />
      ) : (
        <ul className="space-y-2">
          {bundles.map((b) => (
            <li key={b.id} className="rounded-ctl border border-edge p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-fg">{b.title}</span>
                <span className="font-mono text-xs text-fg-subtle">/bundles/{b.slug}</span>
                <StatusBadge status={b.enabled ? "live" : "draft"} />
                <span className="ml-auto text-xs tabular-nums text-fg-muted">
                  {inr(b.bundle_price)} {b.compat?.componentsSum ? <s className="text-fg-subtle">{inr(b.compat.componentsSum)}</s> : null}
                </span>
              </div>
              {!b.compat?.ok && (
                <Banner tone="warning" className="mt-2">
                  {b.compat?.problems?.join(" · ") || "components unavailable"} — {b.enabled ? "shoppers see it as unavailable" : "can’t be enabled"}
                </Banner>
              )}
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button size="sm" busy={toggling === b.id} disabled={!!toggling && toggling !== b.id} onClick={() => toggle(b)}>
                  {b.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setForm({ id: b.id, slug: b.slug, title: b.title, description: b.description || "", bundle_price: b.bundle_price, items: b.items });
                    setCompat(null);
                    setErr(null);
                  }}
                >
                  Edit
                </Button>
                <Button size="sm" variant="dangerOutline" onClick={() => setConfirmDelete(b)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {form && (
        <div className="mt-4 rounded-ctl border border-edge bg-surface-sunken p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Slug" htmlFor="bundle-slug">
              <Input id="bundle-slug" mono placeholder="starter-stack" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
            </Field>
            <Field label="Title" htmlFor="bundle-title">
              <Input id="bundle-title" placeholder="Starter stack" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Description" htmlFor="bundle-desc" hint="Shown on the bundle page." className="sm:col-span-2">
              <Input id="bundle-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
            <Field label="Bundle price (₹)" htmlFor="bundle-price">
              <Input id="bundle-price" type="number" min="1" value={form.bundle_price} onChange={(e) => setForm({ ...form, bundle_price: e.target.value })} />
            </Field>
          </div>

          <p className="mt-4 text-xs font-medium text-fg-muted">Components — pick a variant from the catalog, or type a product handle (first variant) / variant ID, plus quantity</p>
          {form.items.map((c, i) => (
            <div key={i} className="mt-2 flex items-center gap-2">
              <Input
                mono
                className="flex-1 text-xs"
                aria-label={`Component ${i + 1}`}
                placeholder="product-handle or gid://shopify/ProductVariant/…"
                value={c.variantId}
                onChange={(e) => setItem(i, { variantId: e.target.value.trim() })}
              />
              <Button size="sm" onClick={() => setPickerRow(i)}>
                Choose…
              </Button>
              <Input
                type="number"
                min="1"
                className="w-16"
                aria-label={`Component ${i + 1} quantity`}
                value={c.quantity}
                onChange={(e) => setItem(i, { quantity: Number(e.target.value) || 1 })}
              />
              {form.items.length > 2 && (
                <IconButton label={`Remove component ${i + 1}`} icon={<X size={14} aria-hidden />} onClick={() => setForm({ ...form, items: form.items.filter((_, j) => j !== i) })} />
              )}
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} className="mt-2" onClick={() => setForm({ ...form, items: [...form.items, { variantId: "", quantity: 1 }] })}>
            Add component
          </Button>

          {compat && (
            <Banner
              tone={compat.ok ? "success" : "warning"}
              className="mt-3"
              title={compat.ok ? `Compatible — components sum to ${inr(compat.componentsSum)}, shoppers save ${inr(compat.saving)}` : compat.problems.join(" · ")}
            >
              {compat.components?.length > 0 && (
                <ul className="space-y-0.5">
                  {compat.components.map((c, i) => (
                    <li key={i}>
                      {c.title
                        ? `${c.title}${c.variant_title && c.variant_title !== "Default Title" ? ` — ${c.variant_title}` : ""} ×${c.quantity} (${inr(c.price)})`
                        : `component ${i + 1}: not found`}
                      {c.state === "missing" ? " · missing" : c.available === false ? " · sold out" : ""}
                    </li>
                  ))}
                </ul>
              )}
            </Banner>
          )}

          {err && <Banner tone="danger" className="mt-3">{err}</Banner>}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button busy={checking} disabled={!!saving} onClick={check}>
              Check compatibility
            </Button>
            <Button busy={saving === "draft"} disabled={checking || saving === "enable"} onClick={() => save(false)}>
              Save draft
            </Button>
            <Button variant="primary" busy={saving === "enable"} disabled={checking || saving === "draft"} onClick={() => save(true)}>
              Save &amp; enable
            </Button>
            <Button variant="ghost" disabled={checking || !!saving} onClick={() => { setForm(null); setCompat(null); setErr(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete bundle"
        tone="danger"
        confirmLabel="Delete bundle"
        body={
          confirmDelete && (
            <>
              Removes <strong>{confirmDelete.title}</strong> permanently. Its linked cart offer goes too — shoppers can no longer buy it as a bundle.
            </>
          )
        }
        onConfirm={async () => {
          await postJson("/api/admin/bundles", { remove: { id: confirmDelete.id } });
          await refresh();
        }}
      />

      {/* S53 B2: fills the SAME component field (a variant GID string) the
          form always sent — typed handles/GIDs still work for anything the
          catalog hasn't synced. */}
      <VariantPicker
        open={pickerRow != null}
        onClose={() => setPickerRow(null)}
        title={pickerRow != null ? `Choose component ${pickerRow + 1}` : "Choose a variant"}
        selectedVariantId={pickerRow != null && form?.items[pickerRow]?.variantId?.startsWith("gid://") ? form.items[pickerRow].variantId : undefined}
        onConfirm={({ variantId }) => {
          if (pickerRow != null) setItem(pickerRow, { variantId });
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
