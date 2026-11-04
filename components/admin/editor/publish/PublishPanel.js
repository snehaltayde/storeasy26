"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Banner } from "@/components/console/Banner";
import { Badge } from "@/components/console/Badge";
import { Button } from "@/components/console/Button";
import UndoNotice from "./UndoNotice";
import { WORDS, LEVEL_WORDS, actionLabel, allLoaded, createPublishFlow } from "./publishModel";

// P3-PUBLISHUI (PUB-02, PUB-03, PUB-05, PUB-09): the Publish button and the
// small panel it opens. All props, no store import: the logic is
// createPublishFlow() in publishModel.js, and this file only renders its state.
//
// Props:
//   documents   what Publish sends: [{ id, label, type, revision?, draftHash? }]
//               (one for the editor's Publish; several for "Publish all
//               changes"; a missing revision or hash is read with getDocument)
//   mode        "one" (default) | "all"
//   access      { canPublish, reason } from getDocument (staff: disabled, reason shown)
//   call        documentsApi.call, or the store's wrapper (plan A5)
//   loadChanges(id)                 listChanges (default: call)
//   keepLiveSection(id, sectionId)  the store's server-replace (default: call)
//   documentOf(id)                  { body, revision } the host holds (optional)
//   checkLive(release)              the live release id now (optional)
//   onDocument(doc), onFocus({anchor, documentId, sectionId, field}),
//   onPublished(outcome), onConflict(current), onOpenDocument(id),
//   onCreateHome(), createHomeHref, onOpenEarlierVersions, labels
//   flow        an existing createPublishFlow() (tests, or a host that keeps one)

const levelTone = { blocks: "danger", warns: "warning", inherited: "neutral" };

function ChangeList({ list, canKeep, busy, onKeepLive }) {
  if (!list || list.status === "loading") return <p className="text-[13px] text-fg-muted">{WORDS.loadingChanges}</p>;
  if (list.status === "failed") return <p className="text-[13px] text-danger">{list.message}</p>;
  if (list.firstPublish) {
    return (
      <div className="text-[13px]">
        <p>{list.sections.length ? WORDS.firstPublish : WORDS.firstPublishEmpty}</p>
        {list.sections.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {list.sections.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (!list.rows.length) return <p className="text-[13px] text-fg-muted">{WORDS.nothingChanged}</p>;
  return (
    <ul className="divide-y divide-edge text-[13px]">
      {list.rows.map((r, i) => (
        <li key={i} className="flex items-start justify-between gap-3 py-1.5">
          <div className="min-w-0">
            <p>{r.words}</p>
            {r.affects.length > 0 && <p className="text-fg-muted">{r.affects.join(" · ")}</p>}
          </div>
          {canKeep && r.sectionId && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onKeepLive(r.sectionId)}>
              {WORDS.keepLive}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function IssueRow({ issue, offerSize, hidePublishBoth, busy, onAct, onFocus }) {
  const actions = (issue.actions || []).filter((a) => !(hidePublishBoth && a.type === "publishBoth"));
  const hasOpenField = actions.some((a) => a.type === "openField");
  const level = issue.level || (issue.severity === "error" ? "blocks" : "warns");
  return (
    <li className="py-2 text-[13px]" data-issue="">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={levelTone[level] || "neutral"}>{LEVEL_WORDS[level] || LEVEL_WORDS.warns}</Badge>
        {issue.where && <span className="font-medium text-fg">{issue.where}</span>}
      </div>
      <p className="mt-1">{issue.message}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {actions.map((a, i) =>
          a.type === "openField" ? (
            <a key={i} href={issue.anchor ? `#${issue.anchor}` : undefined} className="text-[13px] underline focus-ring" onClick={(e) => (e.preventDefault(), onAct(a, issue))}>
              {actionLabel(a)}
            </a>
          ) : (
            <Button key={i} size="sm" variant={a.type === "publishBoth" ? "primary" : "secondary"} disabled={busy} onClick={() => onAct(a, issue)}>
              {actionLabel(a, { offerSize })}
            </Button>
          ),
        )}
        {!hasOpenField && issue.anchor && (
          <a href={`#${issue.anchor}`} className="text-[13px] underline focus-ring" onClick={(e) => (e.preventDefault(), onFocus({ anchor: issue.anchor, documentId: issue.documentId, sectionId: issue.sectionId ?? null, field: issue.field ?? null }))}>
            {WORDS.fixIt}
          </a>
        )}
      </div>
    </li>
  );
}

// Issues grouped by document, each group named.
function IssueList({ issues, labelOf, offerSize, hidePublishBoth, busy, onAct, onFocus }) {
  const groups = [];
  for (const i of issues || []) {
    let g = groups.find((x) => x.id === i.documentId);
    if (!g) groups.push((g = { id: i.documentId, issues: [] }));
    g.issues.push(i);
  }
  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div key={g.id || "none"}>
          {groups.length > 1 && <p className="text-[13px] font-semibold text-fg">{labelOf(g.id)}</p>}
          <ul className="divide-y divide-edge">
            {g.issues.map((i, n) => (
              <IssueRow key={n} issue={i} offerSize={offerSize} hidePublishBoth={hidePublishBoth} busy={busy} onAct={onAct} onFocus={onFocus} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Lists({ state, canKeep, onKeepLive }) {
  const many = state.order.length > 1;
  return (
    <div className="space-y-3">
      {state.order.map((id) => (
        <div key={id} data-change-list="">
          {many && <p className="text-[13px] font-semibold text-fg">{state.lists[id]?.label}</p>}
          <ChangeList list={state.lists[id]} canKeep={canKeep} busy={state.busy} onKeepLive={(sectionId) => onKeepLive(id, sectionId)} />
        </div>
      ))}
    </div>
  );
}

export function PublishPanelView({ state, canConfirm = false, access = null, mode = "one", call, on = {}, createHomeHref = "/admin/editor?path=%2F" }) {
  const s = state || { phase: "closed", order: [], lists: {}, items: [] };
  const noop = () => {};
  const h = { open: noop, confirm: noop, close: noop, act: noop, keepLive: noop, retry: noop, focus: noop, openDocument: null, conflict: null, createHome: null, openEarlierVersions: null, document: noop, ...on };
  const staff = access && access.canPublish === false;
  const trigger = mode === "all" ? "Publish all changes" : WORDS.publish;
  const o = s.outcome || {};
  const labelOf = (id) => [...(s.items || []), ...(s.offerItems || []), ...(o.documents || [])].find((d) => d?.id === id)?.label || "This page";
  const offerSize = (o.offer?.publishSet || []).length || 2;

  if (s.phase === "closed") {
    return (
      <div className="space-y-1" data-publish="">
        <Button variant="primary" disabled={staff} onClick={h.open}>
          {trigger}
        </Button>
        {staff && <p className="text-[13px] text-fg-muted">{access.reason || WORDS.staffReason}</p>}
      </div>
    );
  }

  const footer = (confirmLabel) => (
    <div className="flex justify-end gap-2 pt-2">
      <Button onClick={h.close} disabled={s.busy}>
        {WORDS.cancel}
      </Button>
      <Button variant="primary" disabled={!canConfirm} busy={s.busy} onClick={h.confirm}>
        {s.busy ? WORDS.publishing : confirmLabel}
      </Button>
    </div>
  );
  const closeOnly = (
    <div className="flex justify-end pt-2">
      <Button onClick={h.close}>{WORDS.close}</Button>
    </div>
  );

  let content = null;
  switch (s.phase) {
    case "review":
      content = (
        <>
          <p className="text-sm font-semibold text-fg">{WORDS.reviewTitle}</p>
          <Lists state={s} canKeep onKeepLive={h.keepLive} />
          {footer(trigger)}
        </>
      );
      break;
    case "offer": {
      const loaded = allLoaded(s.lists, s.order);
      const confirmLabel = o.reason === "home" ? "Publish with the home page" : actionLabel({ type: "publishBoth" }, { offerSize: s.order.length });
      content = (
        <>
          <p className="text-sm font-semibold text-fg">{WORDS.offerTitle}</p>
          {o.message && <p className="text-[13px]">{o.message}</p>}
          <p className="text-[13px]">{o.reason === "home" ? WORDS.offerHome : WORDS.offerLinks}</p>
          {(o.issues || []).length > 0 && <IssueList issues={o.issues} labelOf={labelOf} offerSize={offerSize} hidePublishBoth busy={s.busy} onAct={h.act} onFocus={h.focus} />}
          <Lists state={s} canKeep={false} onKeepLive={noop} />
          {o.otherBlocks && <p className="text-[13px] text-warning">{WORDS.offerOtherBlocks}</p>}
          {!loaded && <p className="text-[13px] text-fg-muted">{WORDS.offerWaiting}</p>}
          {footer(confirmLabel)}
        </>
      );
      break;
    }
    case "republish":
      content = (
        <>
          <p className="text-sm font-semibold text-fg">{o.title}</p>
          <p className="text-[13px]">{o.words}</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={h.close} disabled={s.busy}>
              {WORDS.cancel}
            </Button>
            <Button variant="primary" busy={s.busy} disabled={!canConfirm} onClick={h.confirm}>
              {WORDS.republishAction}
            </Button>
          </div>
        </>
      );
      break;
    case "blocked":
      content = (
        <>
          <Banner tone="danger" title={WORDS.blockedTitle}>
            {o.message}
          </Banner>
          <IssueList issues={o.issues} labelOf={labelOf} offerSize={offerSize} busy={s.busy} onAct={h.act} onFocus={h.focus} />
          {s.busy && (
            <p className="text-[13px] text-fg-muted" role="status" data-keeps-running="">
              {WORDS.keepsRunning}
            </p>
          )}
          {closeOnly}
        </>
      );
      break;
    case "done": {
      const undoable = (o.published || []).filter((p) => p.undo);
      const undoTarget = o.undoSet
        ? { kind: "set", setId: o.undoSet.setId, members: o.undoSet.members, labels: o.undoSet.labels, revisions: o.undoSet.revisions }
        : undoable.length === 1
          ? { kind: "one", label: undoable[0].label, undo: undoable[0].undo }
          : null;
      const note = !undoTarget ? (o.published || []).find((p) => p.note)?.note || null : null;
      content = (
        <>
          <Banner tone="success" title={o.title}>
            {o.warnings?.length ? WORDS.rodeAlong : null}
          </Banner>
          <ul className="space-y-1 text-[13px]">
            {(o.published || []).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <span>{p.label}</span>
                {p.liveUrl && (
                  <a href={p.liveUrl} target="_blank" rel="noreferrer" className="underline focus-ring">
                    {WORDS.seeLive}
                  </a>
                )}
              </li>
            ))}
          </ul>
          {o.skipped?.length > 0 && <p className="text-[13px] text-fg-muted">{`${WORDS.alreadyLive} ${o.skipped.join(", ")}`}</p>}
          {o.warnings?.length > 0 && <IssueList issues={o.warnings} labelOf={labelOf} offerSize={offerSize} busy={s.busy} onAct={h.act} onFocus={h.focus} />}
          <UndoNotice target={undoTarget} note={note} call={call} access={access} onDocument={h.document} onOpenEarlierVersions={h.openEarlierVersions} />
          {closeOnly}
        </>
      );
      break;
    }
    case "checking":
      content = <p className="text-[13px]" role="status">{o.words}</p>;
      break;
    case "checked":
      content = (
        <>
          <p className="text-[13px]" role="status">
            {o.words}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            {o.live === false && (
              <Button variant="primary" busy={s.busy} onClick={h.retry}>
                {WORDS.tryAgain}
              </Button>
            )}
            <Button onClick={h.close}>{WORDS.close}</Button>
          </div>
        </>
      );
      break;
    case "refused":
      content = (
        <>
          <Banner tone="danger" title={o.title}>
            {o.words}
          </Banner>
          {o.next && <p className="text-[13px]">{o.next}</p>}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            {o.fixAnchor && (
              <Button onClick={() => h.focus({ anchor: o.fixAnchor, documentId: o.fixDocumentId, sectionId: null, field: "meta.slug" })}>Change the address</Button>
            )}
            {o.otherId && h.openDocument && <Button onClick={() => h.openDocument(o.otherId)}>{`Open “${o.otherLabel}”`}</Button>}
            <Button onClick={h.close}>{WORDS.close}</Button>
          </div>
        </>
      );
      break;
    case "conflict":
      content = (
        <>
          <Banner tone="warning" title={o.title}>
            {o.words}
          </Banner>
          {o.by && <p className="text-[13px] text-fg-muted">{WORDS.lastSavedBy(o.by)}</p>}
          {o.conflicts?.length > 0 && (
            <ul className="list-disc pl-5 text-[13px]">
              {o.conflicts.map((c, i) => (
                <li key={i}>{c.words}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2 pt-2">
            {h.conflict && o.current && <Button onClick={() => h.conflict(o.current)}>{WORDS.reviewCurrent}</Button>}
            <Button onClick={h.close}>{WORDS.close}</Button>
          </div>
        </>
      );
      break;
    case "noHome":
      content = (
        <>
          <Banner tone="info" title={o.title}>
            {o.message}
          </Banner>
          <div className="flex justify-end gap-2 pt-2">
            {h.createHome ? (
              <Button variant="primary" onClick={h.createHome}>
                {WORDS.noHomeAction}
              </Button>
            ) : (
              <a href={createHomeHref} className="inline-flex items-center rounded-ctl bg-primary px-3.5 py-2 text-sm font-medium text-primary-fg focus-ring">
                {WORDS.noHomeAction}
              </a>
            )}
            <Button onClick={h.close}>{WORDS.close}</Button>
          </div>
        </>
      );
      break;
    default:
      content = (
        <>
          <Banner tone="danger" title={o.title || WORDS.blockedTitle}>
            {o.words}
          </Banner>
          <div className="flex justify-end gap-2 pt-2">
            {o.retry && (
              <Button variant="primary" busy={s.busy} onClick={h.retry}>
                {WORDS.tryAgain}
              </Button>
            )}
            <Button onClick={h.close}>{WORDS.close}</Button>
          </div>
        </>
      );
  }

  return (
    <section className="w-full max-w-md space-y-3 rounded-card border border-edge bg-surface p-4 text-fg shadow-overlay" aria-label={WORDS.reviewTitle} data-publish="" data-phase={s.phase}>
      {s.notice && <p className="text-[13px] text-fg-muted" role="status">{s.notice}</p>}
      {content}
    </section>
  );
}

export default function PublishPanel(props) {
  const { documents = [], access = null, mode = "one", call, flow: given } = props;
  const flow = useMemo(
    () =>
      given ||
      createPublishFlow({
        call,
        loadChanges: props.loadChanges,
        keepLiveSection: props.keepLiveSection,
        documentOf: props.documentOf,
        checkLive: props.checkLive,
        labels: props.labels,
        onDocument: props.onDocument,
        onFocus: props.onFocus,
        onPublished: props.onPublished,
      }),
    [given], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return (
    <PublishPanelView
      state={state}
      canConfirm={flow.canConfirm()}
      access={access}
      mode={mode}
      call={call}
      createHomeHref={props.createHomeHref}
      on={{
        open: () => flow.open(documents, { access }),
        confirm: () => flow.confirm(),
        close: () => flow.close(),
        act: (a, issue) => flow.act(a, issue),
        keepLive: (id, sectionId) => flow.keepLive(id, sectionId),
        retry: () => flow.retry(),
        focus: (f) => props.onFocus?.(f),
        document: props.onDocument,
        openDocument: props.onOpenDocument || null,
        conflict: props.onConflict || null,
        createHome: props.onCreateHome || null,
        openEarlierVersions: props.onOpenEarlierVersions || null,
      }}
    />
  );
}
