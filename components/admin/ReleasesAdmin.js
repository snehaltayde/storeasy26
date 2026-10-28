"use client";

import { useState } from "react";
import { localInputToIso } from "@/lib/admin/schedule";
import { Card, CardHeader } from "@/components/console/Card";
import { StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Field, Input } from "@/components/console/fields";
import { Table } from "@/components/console/Table";
import { EmptyState } from "@/components/console/bits";
import { ConfirmDialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";

// Releases console (S36 / MC13, redesigned S50): what's live, whether drafts
// differ, publish now / schedule / preview draft / roll back. Validation
// errors surface BEFORE publish (the server re-gates anyway) as persistent
// Banners; publish and rollback confirm via ConfirmDialog; action results
// are toasts.
const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

const HISTORY_COLUMNS = [
  { key: "created_at", header: "When" },
  { key: "note", header: "Note" },
  { key: "content_hash", header: "Hash" },
  { key: "state", header: "", align: "right" },
];

export default function ReleasesAdmin({ initial }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [note, setNote] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [apiErrors, setApiErrors] = useState([]);
  const [resultWarnings, setResultWarnings] = useState([]);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [rollback, setRollback] = useState(null); // release row

  async function call(body) {
    setBusy(true);
    setApiErrors([]);
    try {
      const res = await fetch("/api/admin/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        if (json.releases) setData(json);
        if (json.url) {
          window.open(json.url, "_blank", "noopener");
          toast.success("Preview opened in a new tab (valid 1 hour, this browser only).");
        } else {
          toast.success(json.scheduled ? `Scheduled for ${when(json.scheduled.scheduledFor)}.` : body.action === "rollback" ? "Rolled back — live now." : "Published — live now.");
          setResultWarnings(json.published?.warnings || json.scheduled?.warnings || []);
          setNote("");
          setAt("");
        }
      } else {
        setApiErrors(json.errors ? [json.error, ...json.errors].filter(Boolean) : [json.error || `Failed (${res.status})`]);
      }
      return json;
    } finally {
      setBusy(false);
    }
  }

  const v = data.validation || { ok: true, errors: [], warnings: [] };

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

      <Card>
        <CardHeader
          title="Draft state"
          badge={
            <>
              {data.dirty ? <StatusBadge status="stale" label="Unpublished changes" /> : <StatusBadge status="current" label="In sync with live" />}
              {!data.live && <StatusBadge status="draft" label="No release yet — drafts serve directly" />}
            </>
          }
        />

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

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Release note (optional)" htmlFor="release-note" className="min-w-48 flex-1">
            <Input id="release-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Diwali hero + navy brand" />
          </Field>
          <Button variant="primary" busy={busy} disabled={!v.ok} onClick={() => setConfirmPublish(true)}>
            Publish now
          </Button>
          <Button disabled={busy} onClick={() => call({ action: "preview" })}>
            Preview draft
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="…or publish at (your local time)" htmlFor="release-at">
            <Input id="release-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="w-auto" />
          </Field>
          <Button
            disabled={busy || !v.ok || !at}
            onClick={() => {
              const iso = localInputToIso(at);
              if (!iso) return setApiErrors(["Pick a date and time first."]);
              call({ action: "schedule", note, at: iso });
            }}
          >
            Schedule
          </Button>
        </div>
      </Card>

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
                    {r.scheduled_for && !r.published_at && <span className="ml-2 text-xs text-warning">scheduled {when(r.scheduled_for)}</span>}
                  </span>
                );
              case "content_hash":
                return <span className="font-mono text-xs text-fg-muted">{r.content_hash.slice(0, 12)}</span>;
              case "state":
                return r.id === data.live ? (
                  <StatusBadge status="live" />
                ) : r.published_at ? (
                  <Button size="sm" variant="dangerOutline" disabled={busy} onClick={() => setRollback(r)}>
                    Roll back to this
                  </Button>
                ) : (
                  <span className="text-xs text-fg-subtle">{r.scheduled_for ? "pending" : "never live"}</span>
                );
              default:
                return r[col.key];
            }
          }}
        />
      </Card>

      <ConfirmDialog
        open={confirmPublish}
        onClose={() => setConfirmPublish(false)}
        title="Publish to live?"
        confirmLabel="Publish now"
        body={
          <>
            <p>The current draft snapshot becomes an immutable release and goes live immediately. Rollback always works.</p>
            <p className="mt-1.5">{note.trim() ? <>Note: &ldquo;{note.trim()}&rdquo;</> : "No release note."}</p>
          </>
        }
        onConfirm={() => call({ action: "publish", note })}
      />

      <ConfirmDialog
        open={!!rollback}
        onClose={() => setRollback(null)}
        title="Roll back to this release?"
        tone="danger"
        confirmLabel="Roll back"
        body={
          rollback ? (
            <>
              <p>Point the live storefront back at this release? Drafts are not affected.</p>
              <p className="mt-1.5 font-mono text-xs text-fg-subtle">
                {rollback.content_hash.slice(0, 12)} · {when(rollback.created_at)}
              </p>
            </>
          ) : null
        }
        onConfirm={() => call({ action: "rollback", id: rollback.id })}
      />
    </div>
  );
}
