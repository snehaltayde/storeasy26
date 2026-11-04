"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleCheck, ExternalLink } from "lucide-react";
import { localInputToIso } from "@/lib/admin/schedule";
import { diffItemInfo } from "@/components/admin/cms/labels";
import { editorDestination } from "@/lib/admin/editor-entry";
import { startPreview, NETWORK_ERROR } from "@/components/admin/cms/api";
// DOC-04: publish issues are the same structured shape as save issues. The
// server sends no positions; "Section 2 (Banner / CTA)" is worked out here
// from each issue's section id against the sections being published, both
// before publishing and in the warnings that come back after it.
import { issueLines, resultWarningLines } from "@/lib/cms/issues";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { Table } from "@/components/console/Table";
import { EmptyState, PermissionNote } from "@/components/console/bits";
import { ConfirmDialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";

// Publishing console (S36 / MC13, redesigned S52): the diff — WHAT will
// publish — leads, as linked chips into the right editor. Then publish now
// (confirm lists the changes), schedule (honest about snapshot-now and
// no re-validation), history with rollback and cancel-schedule, preview.
// Validation errors surface BEFORE publish (the server re-gates anyway) as
// persistent Banners; every POST returns the full view, so state refreshes
// from the response. S55: `canPublish` (computed by the SERVER page from
// storefront.publish — staff edit, admin+ publish) gates every go-live
// control; the server still owns the real permission check. Preview stays
// open to everyone who can edit.
const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

const HISTORY_COLUMNS = [
  { key: "created_at", header: "When" },
  { key: "note", header: "Note" },
  { key: "content_hash", header: "Hash" },
  { key: "state", header: "State", align: "right" },
];

// P4-ED05 (ED-05): with cmsMode "documents" each diff chip links to its editor
// destination (editorDestination), never an old screen. The Publishing page
// shows this panel only on legacy stores today; the prop keeps the links
// right wherever it is shown. Every other mode is unchanged.
export default function ReleasesAdmin({ initial, canPublish = true, cmsMode = null }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [note, setNote] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(null); // "schedule" | "preview" | dialog action name
  const [apiErrors, setApiErrors] = useState([]);
  const [resultWarnings, setResultWarnings] = useState([]);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [rollback, setRollback] = useState(null); // release row
  const [cancelRow, setCancelRow] = useState(null); // scheduled release row

  async function call(body) {
    setBusy(body.action);
    setApiErrors([]);
    try {
      const res = await fetch("/api/admin/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        if (json.releases) setData(json); // every mutating POST returns the full view
        // DOC-04: the change went through but the view couldn't be read, so
        // what this page shows is out of date. Say so; don't claim a failure.
        if (json.notice) setResultWarnings([json.notice]);
        return json;
      }
      // S53 (0B-1): the publish was bound to the hash we DISPLAYED; drafts
      // moved since — adopt the fresh view so the diff shows what changed.
      if (res.status === 409 && json.code === "DRAFTS_CHANGED") {
        if (json.releases) setData(json);
        setApiErrors([json.error || "Drafts changed since you reviewed them — review the updated list, then publish again."]);
        return { ok: false, error: json.error };
      }
      const msgs = Array.isArray(json.issues)
        ? [json.error, ...issueLines(json.issues, json.sections, "error")].filter(Boolean)
        : json.errors
          ? [json.error, ...json.errors].filter(Boolean)
          : [json.error || `Something went wrong on our side (error ${res.status}), so nothing was published. Your live store hasn't changed. Try again in a minute.`];
      setApiErrors(msgs);
      return { ok: false, error: msgs.join(" — ") };
    } catch {
      const msg = NETWORK_ERROR.replace("nothing was saved", "nothing was published");
      setApiErrors([msg]);
      return { ok: false, error: msg };
    } finally {
      setBusy(null);
    }
  }

  async function onPreview() {
    setBusy("preview");
    setApiErrors([]);
    try {
      const r = await startPreview("/");
      if (!r.ok) {
        toast.error(r.error || (r.errors || []).join("; ") || "Preview failed.");
        return;
      }
      window.open("/", "_blank", "noopener");
      toast.success("Preview opened in a new tab — drafts visible to you only.");
    } finally {
      setBusy(null);
    }
  }

  const rawV = data.validation || { ok: true, errors: [], warnings: [] };
  const v = Array.isArray(rawV.issues)
    ? { ...rawV, errors: issueLines(rawV.issues, rawV.sections, "error"), warnings: issueLines(rawV.issues, rawV.sections, "warning") }
    : rawV;
  const diff = data.diff || { firstPublish: !data.live, dirty: !!data.dirty, items: [] };
  const diffItems = diff.items || [];
  const readyToPublish = v.ok && !!data.dirty; // content gate; canPublish is the ROLE gate
  const diffLabels = diffItems.map((it) => diffItemInfo(it).label);

  return (
    <div className="space-y-4">
      {apiErrors.length > 0 && (
        <Banner tone="danger">
          {apiErrors.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </Banner>
      )}
      {resultWarnings.length > 0 && (
        <Banner tone="warning">
          {resultWarnings.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </Banner>
      )}

      {/* 1 · What will publish — the diff leads */}
      <Card>
        <CardHeader
          title="What will publish"
          badge={data.dirty ? <StatusBadge status="stale" label="Unpublished changes" /> : <StatusBadge status="current" label="In sync with live" />}
          description="Each chip links to its editor. This is the item-level draft-vs-live difference — exactly what the next publish changes."
          actions={
            <Button size="sm" icon={<ExternalLink size={13} aria-hidden />} busy={busy === "preview"} disabled={!!busy && busy !== "preview"} onClick={onPreview}>
              Preview draft
            </Button>
          }
        />

        {diff.firstPublish && (
          <Banner tone="warning" className="mb-3">
            Never published — drafts currently serve directly to shoppers; the first publish freezes them into a release.
          </Banner>
        )}
        {!v.ok && (
          <Banner tone="danger" title="Fix before publishing" className="mb-3">
            <ul className="list-disc space-y-1 pl-4">
              {v.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </Banner>
        )}
        {v.warnings?.length > 0 && (
          <Banner tone="warning" className="mb-3">
            <ul className="list-disc space-y-1 pl-4">
              {v.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Banner>
        )}

        {diffItems.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {diffItems.map((item) => {
              const info = diffItemInfo(item);
              return (
                <li key={`${item.type}:${item.key}`}>
                  <Link
                    href={cmsMode === "documents" ? editorDestination(info.href) : info.href}
                    className="inline-flex items-center gap-2 rounded-ctl border border-edge bg-surface px-2.5 py-1.5 text-xs font-medium text-fg focus-ring hover:border-edge-strong hover:bg-surface-muted motion-safe:transition-colors"
                  >
                    {info.label}
                    <Badge tone={info.tone}>{info.changeLabel}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : diff.firstPublish ? (
          <p className="text-sm text-fg-muted">The first release snapshots every draft as-is — publish below to freeze the current state.</p>
        ) : (
          <EmptyState
            icon={<CircleCheck size={20} aria-hidden />}
            title="In sync with live"
            body={`Drafts match the live release${data.liveHash ? ` (${data.liveHash.slice(0, 12)})` : ""} — nothing to publish.`}
          />
        )}

        {/* S60: approval of THIS candidate — bound to the draft hash, so any
            edit makes it disappear instead of blessing unreviewed content. */}
        {data.dirty && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-3 text-sm">
            {data.approval ? (
              <>
                <Badge tone="success">Approved</Badge>
                <span className="text-fg-muted">
                  This exact candidate ({String(data.draftHash || "").slice(0, 12)}) was approved by <span className="font-medium text-fg">{data.approval.actor}</span>{" "}
                  on {new Date(data.approval.created_at).toLocaleString()}
                  {data.approval.note ? ` — “${data.approval.note}”` : ""}. Any draft edit withdraws it.
                </span>
              </>
            ) : (
              <>
                <Badge tone="neutral">Not approved</Badge>
                <span className="text-fg-muted">No one has approved this candidate yet. Approval is a record, not a gate — publishing still works.</span>
                {canPublish && (
                  <Button
                    size="sm"
                    busy={busy === "approve"}
                    disabled={!!busy && busy !== "approve"}
                    onClick={async () => {
                      const json = await call({ action: "approve", expectedDraftHash: data.draftHash });
                      if (json.ok) toast.success("Candidate approved — bound to this exact draft state");
                    }}
                  >
                    Approve this candidate
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </Card>

      {/* 2+3 · Publish now / schedule */}
      <Card>
        <CardHeader title="Publish" description="Publishing snapshots the current drafts into an immutable release and flips live to it. Rollback always works." />

        {/* S55: the ONE role note on this screen — the go-live controls below (and
            rollback/cancel in History) disable with it. Preview stays enabled. */}
        {!canPublish && <PermissionNote className="mb-3" need="publish — you can edit drafts and preview, but an admin or owner takes them live" />}

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Release note (optional)" htmlFor="release-note" className="min-w-48 flex-1">
            <Input id="release-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Diwali hero + navy brand" />
          </Field>
          <Button variant="primary" disabled={!canPublish || !readyToPublish || !!busy} onClick={() => setConfirmPublish(true)}>
            Publish now
          </Button>
        </div>

        <div className="mt-4 border-t border-edge pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="…or publish at (your local time)" htmlFor="release-at">
              <Input id="release-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="w-auto" />
            </Field>
            <Button
              busy={busy === "schedule"}
              disabled={(!!busy && busy !== "schedule") || !canPublish || !readyToPublish || !at}
              onClick={async () => {
                const iso = localInputToIso(at);
                if (!iso) return setApiErrors(["Pick a date and time first."]);
                const json = await call({ action: "schedule", note, at: iso, expectedDraftHash: data.draftHash });
                if (json.ok) {
                  toast.success(`Scheduled for ${when(json.scheduled?.scheduledFor)} — the pending release is in the history below.`);
                  setResultWarnings([...(json.notice ? [json.notice] : []), ...resultWarningLines(json.scheduled)]);
                  setNote("");
                  setAt("");
                }
              }}
            >
              Schedule
            </Button>
          </div>
          <p className="mt-2 text-xs text-fg-muted">
            The snapshot is taken now — edits made after scheduling are NOT included. Scheduled publishes aren&rsquo;t re-validated. You can cancel a pending
            schedule from the history below.
          </p>
        </div>
      </Card>

      {/* 4 · History */}
      <Card>
        <CardHeader title="History" />
        <Table
          columns={HISTORY_COLUMNS}
          rows={data.releases}
          empty={
            <EmptyState
              title="Nothing published yet"
              body="The storefront serves your drafts directly until the first release."
            />
          }
          renderCell={(r, col) => {
            switch (col.key) {
              case "created_at":
                return <span className="whitespace-nowrap text-xs text-fg-muted">{when(r.created_at)}</span>;
              case "note":
                return (
                  <span className="block max-w-72 truncate" title={r.note || undefined}>
                    {r.note || <span className="text-fg-subtle">no note</span>}
                  </span>
                );
              case "content_hash":
                return <span className="font-mono text-xs text-fg-muted">{r.content_hash.slice(0, 12)}</span>;
              case "state":
                if (r.id === data.live) return <StatusBadge status="live" />;
                if (r.scheduled_for && !r.published_at)
                  return (
                    <span className="inline-flex items-center gap-2">
                      <span className="whitespace-nowrap text-xs text-warning">Scheduled for {when(r.scheduled_for)}</span>
                      <Button size="sm" variant="dangerOutline" disabled={!canPublish || !!busy} onClick={() => setCancelRow(r)}>
                        Cancel schedule
                      </Button>
                    </span>
                  );
                if (r.published_at)
                  return (
                    <Button size="sm" variant="dangerOutline" disabled={!canPublish || !!busy} onClick={() => setRollback(r)}>
                      Roll back to this
                    </Button>
                  );
                return <span className="text-xs text-fg-subtle">never live</span>;
              default:
                return r[col.key];
            }
          }}
        />
      </Card>

      {/* Publish confirm — lists exactly what goes live */}
      <ConfirmDialog
        open={confirmPublish}
        onClose={() => setConfirmPublish(false)}
        title="Publish to live?"
        confirmLabel="Publish now"
        body={
          <>
            {diffLabels.length > 0 ? (
              <>
                <p>This goes live for shoppers immediately:</p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                  {diffLabels.slice(0, 8).map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
                {diffLabels.length > 8 && <p className="mt-1">…and {diffLabels.length - 8} more.</p>}
              </>
            ) : (
              <p>The current draft snapshot becomes an immutable release and goes live immediately.</p>
            )}
            <p className="mt-1.5">{note.trim() ? <>Note: &ldquo;{note.trim()}&rdquo;</> : "No release note."} Rollback always works.</p>
          </>
        }
        onConfirm={async () => {
          // bound to the hash whose diff the merchant is LOOKING at (S53)
          const json = await call({ action: "publish", note, expectedDraftHash: data.draftHash });
          if (!json.ok) throw new Error(json.error); // keeps the dialog open, shows the reason
          toast.success("Published — live now.");
          setResultWarnings([...(json.notice ? [json.notice] : []), ...resultWarningLines(json.published)]);
          setNote("");
        }}
      />

      {/* Rollback confirm */}
      <ConfirmDialog
        open={!!rollback}
        onClose={() => setRollback(null)}
        title="Roll back to this release?"
        tone="danger"
        confirmLabel="Roll back"
        body={
          rollback ? (
            <>
              <p>Point the live storefront back at this release? Your drafts stay untouched — this only changes what shoppers see.</p>
              <p className="mt-1.5 font-mono text-xs text-fg-subtle">
                {rollback.content_hash.slice(0, 12)} · {when(rollback.created_at)}
              </p>
            </>
          ) : null
        }
        onConfirm={async () => {
          const json = await call({ action: "rollback", id: rollback.id });
          if (!json.ok) throw new Error(json.error);
          toast.success("Rolled back — live now.");
        }}
      />

      {/* Cancel-schedule confirm */}
      <ConfirmDialog
        open={!!cancelRow}
        onClose={() => setCancelRow(null)}
        title="Cancel this scheduled publish?"
        tone="danger"
        confirmLabel="Cancel schedule"
        body={
          cancelRow ? (
            <>
              <p>The pending job and its never-published release are deleted. Drafts are untouched — you can schedule again any time.</p>
              <p className="mt-1.5 text-xs text-fg-subtle">
                Scheduled for {when(cancelRow.scheduled_for)}
                {cancelRow.note ? <> · &ldquo;{cancelRow.note}&rdquo;</> : null}
              </p>
            </>
          ) : null
        }
        onConfirm={async () => {
          const json = await call({ action: "cancel", id: cancelRow.id });
          if (!json.ok) throw new Error(json.error); // 409 "too late" text surfaces here and in the banner
          toast.success("Schedule cancelled — nothing will publish.");
        }}
      />
    </div>
  );
}
