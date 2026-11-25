"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { outcomeOf } from "../editor/publish/publishModel";

// Phase 6 line 1 (docs/plans/phase-6.md feature 9, the Phase 5 rule): the
// studio's Publish. Every document with a draft is listed with a checkbox;
// only the documents this session changed (studioModel.touched) that still
// differ from live are ticked; the rest sit under "Other drafts", unticked.
// Pending saves of every open document are flushed first, then one
// publishSet goes out with each ticked document's revision and draftHash
// (an open document's from its own store, after the flush; any other's read
// when the dialog opened, so a colleague's later edit is a 409). A refusal
// (blockers, a 409) is said in plain words with "Go to the fix". Only storefront.publish opens it (StudioTopBar).
//
// The logic is plain functions (node suites drive them):
//   publishRows(documents, { touched })  → { ticked: [...], other: [...] }
//   createPublishRun({ api, stores, touched, current })
//     prepare()          flush every store, then list the drafts
//     publish(ids, rows) the publishSet answer
export const PUBLISH_WORDS = Object.freeze({
  title: "Publish your changes",
  intro: "Choose what goes live. Shoppers see it at once.",
  other: "Other drafts",
  session: "Changed in this session",
  otherEdits: "Has other edits",
  none: "Nothing has changed since the last publish, so there is nothing to publish.",
  flushing: "Saving your last changes…",
  notSaved: "Your latest changes aren't saved yet, so nothing was published. They are still here.",
  publish: "Publish",
  publishing: "Publishing…",
  cancel: "Cancel",
  fix: "Go to the fix",
  noneTicked: "Tick at least one page to publish.",
  notListed: "That page wasn't in the list when it opened. Close this and publish again.",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function publishRows(documents, { touched = [] } = {}) {
  const mine = new Set(touched);
  const drafts = (Array.isArray(documents) ? documents : []).filter((d) => isObj(d) && typeof d.id === "string" && d.unpublishedChanges === true && !d.archivedAt);
  const row = (d) => ({ id: d.id, label: d.label || "Untitled", type: d.type, touched: mine.has(d.id), why: mine.has(d.id) ? PUBLISH_WORDS.session : PUBLISH_WORDS.otherEdits });
  // touched first, in the order the session first changed them
  const ticked = [...touched].map((id) => drafts.find((d) => d.id === id)).filter(Boolean).map(row);
  const other = drafts.filter((d) => !mine.has(d.id)).map(row);
  return { ticked, other };
}

export function createPublishRun({ api, stores = () => [], current = () => null }) {
  const open = () => (typeof stores === "function" ? stores() : stores).filter(Boolean);
  const shown = new Map(); // id → { revision, draftHash } read by prepare()
  async function prepare() {
    for (const s of open()) {
      const f = await s.beforeNavigate();
      if (!f || !f.ok) return { ok: false, message: f?.conflict ? f.message : PUBLISH_WORDS.notSaved, conflict: !!f?.conflict, id: s.getState().id };
    }
    const r = await api.call("listDocuments", true);
    if (!r?.ok || !Array.isArray(r.data?.documents)) return { ok: false, message: r?.message || PUBLISH_WORDS.notSaved };
    // the version of every draft that isn't open here, as the dialog shows
    // it: Publish sends exactly this, so an edit made after the dialog
    // opened is a 409, never published unseen
    shown.clear();
    const mine = new Set(open().map((s) => s.getState().id));
    for (const d of r.data.documents) {
      if (!isObj(d) || d.unpublishedChanges !== true || d.archivedAt || mine.has(d.id)) continue;
      const g = await api.call("getDocument", d.id);
      if (!g?.ok || !isObj(g.data?.document)) return { ok: false, message: g?.message || PUBLISH_WORDS.notSaved, id: d.id };
      shown.set(d.id, { revision: g.data.document.revision, draftHash: g.data.document.draftHash });
    }
    return { ok: true, documents: r.data.documents };
  }
  async function publish(ids, labels = {}) {
    const want = [...new Set(ids)];
    if (!want.length) return { outcome: { phase: "error", title: PUBLISH_WORDS.noneTicked, words: PUBLISH_WORDS.noneTicked } };
    const byId = new Map(open().map((s) => [s.getState().id, s]));
    const items = [];
    for (const id of want) {
      const s = byId.get(id);
      if (s) {
        const f = await s.beforeNavigate();
        if (!f || !f.ok) return { outcome: { phase: "error", title: PUBLISH_WORDS.notSaved, words: f?.message || PUBLISH_WORDS.notSaved }, id };
        const st = s.getState();
        items.push({ id, revision: st.revision, draftHash: st.draftHash, label: labels[id] });
        continue;
      }
      const v = shown.get(id);
      if (!v) return { outcome: { phase: "error", title: PUBLISH_WORDS.notListed, words: PUBLISH_WORDS.notListed }, id };
      items.push({ id, revision: v.revision, draftHash: v.draftHash, label: labels[id] });
    }
    // an open store in the set sends it (it flushes and holds its own
    // autosave, and marks itself published); otherwise the api does
    const cur = current();
    const sender = (cur && want.includes(cur.getState().id) && cur) || want.map((id) => byId.get(id)).find(Boolean) || null;
    const list = items.map(({ id, revision, draftHash }) => ({ id, revision, draftHash }));
    const result = sender ? await sender.publishSet(list) : await api.call("publishSet", list);
    return { result, items, outcome: outcomeOf(result, { items, labels }) };
  }
  return { prepare, publish };
}

// where "Go to the fix" goes for an outcome: [{ id, sectionId, words }]
export function fixesOf(outcome) {
  if (!isObj(outcome)) return [];
  if (Array.isArray(outcome.issues) && outcome.issues.length) {
    return outcome.issues
      .filter((i) => isObj(i) && typeof i.documentId === "string" && (i.level === "blocks" || i.severity === "error" || !i.level))
      .map((i) => ({ id: i.documentId, sectionId: typeof i.sectionId === "string" ? i.sectionId : null, words: i.message || "" }));
  }
  if (outcome.phase === "conflict") {
    const ids = outcome.conflicts?.length ? outcome.conflicts.map((c) => ({ id: c.id, sectionId: null, words: c.words })) : outcome.current?.id ? [{ id: outcome.current.id, sectionId: null, words: outcome.words }] : [];
    return ids.filter((x) => typeof x.id === "string");
  }
  return [];
}

function Row({ row, checked, onChecked, busy }) {
  const box = `publish-${row.id}`;
  return (
    <li className="flex items-start gap-3 rounded-md px-1 py-2 hover:bg-muted/50" data-publish-row={row.id} data-publish-ticked={checked ? "" : undefined}>
      <Checkbox id={box} className="mt-0.5" aria-describedby={`${box}-why`} checked={checked} disabled={busy} onCheckedChange={(v) => onChecked(row.id, v === true)} />
      <label htmlFor={box} className="min-w-0 flex-1 cursor-pointer text-sm leading-snug">
        <span className="block truncate font-medium text-foreground">{row.label}</span>
        <span id={`${box}-why`} className="block text-xs text-muted-foreground">{row.why}</span>
      </label>
    </li>
  );
}

// open: the prepared rows ({ ticked, other }) or null; run: createPublishRun
export default function StudioPublishDialog({ open, rows, run, onClose, onDone, onFix }) {
  const [checked, setChecked] = useState(() => Object.fromEntries((rows?.ticked || []).map((r) => [r.id, true])));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const all = [...(rows?.ticked || []), ...(rows?.other || [])];
  const labels = Object.fromEntries(all.map((r) => [r.id, r.label]));
  const set = (id, v) => setChecked((c) => ({ ...c, [id]: v }));
  const ids = all.filter((r) => checked[r.id]).map((r) => r.id);
  const go = async () => {
    setBusy(true);
    setOutcome(null);
    const r = await run.publish(ids, labels);
    setBusy(false);
    if (r.outcome?.phase === "done") return onDone?.(r);
    setOutcome(r.outcome);
  };
  const fixes = fixesOf(outcome);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose?.()}>
      <DialogContent data-studio-publish-dialog="">
        <DialogHeader>
          <DialogTitle>{PUBLISH_WORDS.title}</DialogTitle>
          <DialogDescription>{all.length ? PUBLISH_WORDS.intro : PUBLISH_WORDS.none}</DialogDescription>
        </DialogHeader>
        {rows?.ticked?.length > 0 && (
          <ul aria-label={PUBLISH_WORDS.session} data-publish-group="session">
            {rows.ticked.map((r) => (
              <Row key={r.id} row={r} checked={!!checked[r.id]} onChecked={set} busy={busy} />
            ))}
          </ul>
        )}
        {rows?.other?.length > 0 && (
          <section aria-label={PUBLISH_WORDS.other} className="space-y-1 border-t border-border pt-3" data-publish-group="other">
            <h3 className="text-sm font-semibold text-foreground">{PUBLISH_WORDS.other}</h3>
            <ul>
              {rows.other.map((r) => (
                <Row key={r.id} row={r} checked={!!checked[r.id]} onChecked={set} busy={busy} />
              ))}
            </ul>
          </section>
        )}
        {outcome && (
          <div role="alert" className="space-y-1 text-sm" data-publish-outcome={outcome.phase}>
            <p className="font-medium text-destructive">{outcome.title}</p>
            {outcome.words && outcome.words !== outcome.title && <p className="text-muted-foreground">{outcome.words || outcome.message}</p>}
            {outcome.message && !outcome.words && <p className="text-muted-foreground">{outcome.message}</p>}
            {fixes.length > 0 && (
              <ul className="space-y-1">
                {fixes.map((f, i) => (
                  <li key={`${f.id}-${f.sectionId}-${i}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-xs">{`${labels[f.id] || "A page"}: ${f.words}`}</span>
                    <Button type="button" size="xs" variant="outline" onClick={() => onFix?.(f)} data-publish-fix={f.id}>
                      {PUBLISH_WORDS.fix}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onClose?.()}>
            {PUBLISH_WORDS.cancel}
          </Button>
          <Button type="button" disabled={busy || !ids.length} aria-busy={busy} onClick={go} data-studio-publish-go="">
            {busy ? PUBLISH_WORDS.publishing : PUBLISH_WORDS.publish}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
