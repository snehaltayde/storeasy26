"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { Input, Textarea } from "@/components/console/fields";
import { Switch } from "@/components/console/Switch";
import { ConfirmDialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";
import { saveBlock, resetBlock, getStorefrontView } from "./api";
import { ConflictBanner } from "./ConflictBanner";
import { useDirtyGuard } from "./useDirtyGuard";
import PreviewFrame from "./PreviewFrame";

// Product-pages editor (S52): the GLOBAL pdp_extras accordions, shown under
// the description on EVERY product page. The view feeds this editor the RAW
// list — including enabled:false rows — and the editor round-trips them: the
// old screen was fed the filtered (renderer) list, so a disabled accordion
// silently vanished on the next save. Show/Hide is therefore a real state
// here (Hidden badge), not a delete.
//
// Wire contract (S35, via ./api): save with the loaded revision (number =
// CAS, null = expect-create); a 409 renders ConflictBanner, whose overwrite
// re-sends with the revision OMITTED. 422 renders a persistent Banner.

const MAX = 8;

const seedRows = (v) => (Array.isArray(v) ? v.map((x) => ({ title: x?.title ?? "", html: x?.html ?? "", enabled: x?.enabled !== false })) : []);
// An empty list saves as null = "no extras" (the block's default).
const rowsValue = (rows) => (rows.length ? rows.map((r) => ({ title: r.title, html: r.html, enabled: !!r.enabled })) : null);

export default function PdpExtrasEditor({ initial }) {
  const toast = useToast();
  const [rows, setRows] = useState(() => seedRows(initial.blocks.pdp_extras));
  const [snap, setSnap] = useState(() => JSON.stringify(seedRows(initial.blocks.pdp_extras)));
  const [rev, setRev] = useState(initial.revisions?.pdp_extras ?? null);
  const [customized, setCustomized] = useState(!!initial.customized?.pdp_extras);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [errors, setErrors] = useState(null); // string[] | null
  const [removeIdx, setRemoveIdx] = useState(null); // row index pending ConfirmDialog
  const [confirmReset, setConfirmReset] = useState(false);

  const dirty = JSON.stringify(rows) !== snap;
  useDirtyGuard(dirty);

  async function run(fn, toastText) {
    setBusy(true);
    const res = await fn();
    if (res.ok) {
      setConflict(false);
      setErrors(null);
      setRev(res.revisions?.pdp_extras ?? null);
      setCustomized(!!res.customized?.pdp_extras);
      const fresh = seedRows(res.blocks?.pdp_extras);
      setRows(fresh);
      setSnap(JSON.stringify(fresh));
      toast.success(toastText);
    } else if (res.conflict) {
      setErrors(null);
      setConflict(true);
    } else {
      setConflict(false);
      setErrors(res.errors || [res.error || "Request failed"]);
    }
    setBusy(false);
    return res;
  }

  const save = () => run(() => saveBlock("pdp_extras", rowsValue(rows), rev), "Saved as a draft — publish from Publishing");
  const overwrite = () => run(() => saveBlock("pdp_extras", rowsValue(rows)), "Overwrote their version — publish from Publishing"); // revision OMITTED
  const takeTheirs = () => run(() => getStorefrontView(), "Loaded their version — your edits were discarded");
  const reset = () => run(() => resetBlock("pdp_extras"), "Reset to default — publish from Publishing");

  const patch = (i, p) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i, d) =>
    setRows((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const c = [...r];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });

  return (
    <div className="space-y-4">
      <Card id="accordions">
        <CardHeader
          title="Accordions on every product page"
          description="Shown under the description on every product — shipping, returns, lab reports. HTML is sanitized on save. Hidden accordions keep their content and don't render on the storefront."
          badge={
            <>
              <Badge tone={customized ? "accent" : "neutral"}>{customized ? "Customized" : "Default"}</Badge>
              {dirty && <Badge tone="warning">Unsaved</Badge>}
            </>
          }
          actions={
            <>
              {customized && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmReset(true)}>
                  Reset to default
                </Button>
              )}
              <Button size="sm" variant="primary" busy={busy} disabled={!dirty} onClick={save}>
                Save
              </Button>
            </>
          }
        />
        {conflict && (
          <div className="mb-4">
            <ConflictBanner what="the product-page accordions" busy={busy} onTakeTheirs={takeTheirs} onOverwrite={overwrite} />
          </div>
        )}
        {errors && (
          <Banner tone="danger" title="Fix these to save" className="mb-4">
            {errors.map((e, i) => (
              <p key={i}>{e}</p>
            ))}
          </Banner>
        )}

        <p className="mb-3 text-xs text-fg-muted">
          {rows.length} / {MAX} accordions · drag-free ordering with the arrows — the storefront renders them top to bottom
        </p>
        {rows.length === 0 && (
          <p className="mb-3 text-sm text-fg-muted">No accordions yet — product pages show just the description. Add your first below.</p>
        )}
        <ul className="space-y-2">
          {rows.map((row, i) => (
            <li key={i} className="rounded-ctl border border-edge p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={`Accordion ${i + 1} title`}
                  className="w-48 flex-1"
                  maxLength={80}
                  placeholder="Accordion title (e.g. Shipping & delivery)"
                  value={row.title}
                  onChange={(e) => patch(i, { title: e.target.value })}
                />
                {!row.enabled && <Badge tone="warning">Hidden</Badge>}
                <span className="flex items-center gap-2 text-xs text-fg-muted">
                  <Switch
                    checked={row.enabled}
                    onChange={(v) => patch(i, { enabled: v })}
                    label={`Show accordion ${i + 1} on product pages`}
                  />
                  {row.enabled ? "Shown" : "Hidden"}
                </span>
                <span className="flex shrink-0 items-center">
                  <IconButton label={`Move accordion ${i + 1} up`} icon={<ArrowUp size={14} aria-hidden />} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton
                    label={`Move accordion ${i + 1} down`}
                    icon={<ArrowDown size={14} aria-hidden />}
                    disabled={i === rows.length - 1}
                    onClick={() => move(i, 1)}
                  />
                  <IconButton
                    label={`Duplicate accordion ${i + 1}`}
                    icon={<Copy size={14} aria-hidden />}
                    disabled={rows.length >= MAX}
                    onClick={() => setRows((r) => [...r.slice(0, i + 1), { ...r[i] }, ...r.slice(i + 1)])}
                  />
                  <IconButton label={`Remove accordion ${i + 1}`} icon={<Trash2 size={14} aria-hidden />} onClick={() => setRemoveIdx(i)} />
                </span>
              </div>
              <Textarea
                mono
                aria-label={`Accordion ${i + 1} HTML`}
                className="mt-2 min-h-24"
                maxLength={10000}
                placeholder="<p>Content — scripts and event handlers are stripped on save</p>"
                value={row.html}
                onChange={(e) => patch(i, { html: e.target.value })}
              />
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          className="mt-3"
          icon={<Plus size={13} aria-hidden />}
          disabled={rows.length >= MAX}
          onClick={() => setRows((r) => [...r, { title: "", html: "", enabled: true }])}
        >
          Add accordion ({rows.length}/{MAX})
        </Button>

        <ConfirmDialog
          open={removeIdx != null}
          onClose={() => setRemoveIdx(null)}
          title="Remove this accordion?"
          body={`“${rows[removeIdx ?? -1]?.title || `Accordion ${(removeIdx ?? 0) + 1}`}” and its content leave the list (want it off the storefront but kept? use Hide instead). Nothing is saved until you press Save.`}
          confirmLabel="Remove"
          tone="danger"
          onConfirm={() => setRows((r) => r.filter((_, j) => j !== removeIdx))}
        />
        <ConfirmDialog
          open={confirmReset}
          onClose={() => setConfirmReset(false)}
          title="Reset the product-page accordions?"
          body="This discards your draft and returns the block to its default (no accordions). The live site keeps the published version until your next publish."
          confirmLabel="Reset to default"
          tone="danger"
          onConfirm={reset}
        />
      </Card>

      {/* Honest pointer, not a duplicate editor: per-product presentation
          lives in Catalog and applies immediately (outside publishing). */}
      <Card>
        <CardHeader
          title="Per-product accordions & badges"
          description="Modules for ONE product (ingredients, usage, specs) and its card badge live with the product itself, in Catalog — and apply immediately, outside publishing."
          actions={
            <Link
              href="/admin/catalog"
              className="inline-flex items-center gap-1.5 rounded-ctl border border-edge-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-fg focus-ring hover:bg-surface-muted"
            >
              Open Catalog <ArrowRight size={13} aria-hidden />
            </Link>
          }
        />
      </Card>

      <PreviewFrame to="/" description="Your browser only — open any product in the preview to see the accordions under its description." />
    </div>
  );
}
