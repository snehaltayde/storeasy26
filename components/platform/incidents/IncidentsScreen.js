"use client";

// Phase 3 line 4: the operator's incidents. Open first, then resolved, 50 a
// page, for every store, platform-wide only, or one store. Open an incident
// (title, scope, public message, internal note) with a preview of the banner
// merchants will see; post updates, edit the internal note, resolve with an
// optional closing message, and read the timeline (audit_log incident.* rows).
// The internal note is operators only: it is never in the banner or in an
// audit row. Data through /api/platform/incidents.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, Info, Lock, Plus, RefreshCw, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { incidentBannerTitle } from "@/lib/platform/incident-words";
import { fmtTime } from "@/components/platform/flags/flagWords";

const selectClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-muted px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const TIMELINE_WORDS = { open: "Opened", update: "Update posted", note: "Internal note edited", resolve: "Resolved" };
const DOT = { open: "bg-warning", update: "bg-info", note: "bg-muted-foreground/50", resolve: "bg-success" };

async function api(method, body, query = "") {
  const res = await fetch(`/api/platform/incidents${query}`, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.assign("/platform");
    return new Promise(() => {});
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(json?.error || "That didn't work. Try again.");
  return json;
}

// The banner as the merchant console shows it (components/admin/shell/ConsoleNotices.js):
// an info notice with the icon, the title in semibold and the message under it,
// drawn on a sunken strip that stands for the top of the merchant's content area.
export function BannerPreview({ incident }) {
  return (
    <figure data-banner-preview className="space-y-1.5">
      <figcaption className="text-xs font-medium text-muted-foreground">What merchants see{incident.tenant_id ? " in this store's console" : " in every store's console"}</figcaption>
      <div className="rounded-card border border-border bg-muted/60 p-2">
        {incident.public_message ? (
          <Alert variant="info" role="note" className="bg-card px-3.5 py-2.5">
            <Info aria-hidden />
            <AlertTitle className="font-semibold">{incidentBannerTitle(incident)}</AlertTitle>
            <AlertDescription className="text-[0.8125rem] leading-snug text-info">{incident.public_message}</AlertDescription>
          </Alert>
        ) : (
          <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">No banner: merchants see nothing until there is a public message.</p>
        )}
      </div>
    </figure>
  );
}

const PrivateHint = ({ children, id }) => (
  <p id={id} className="flex items-start gap-1.5 text-xs text-muted-foreground">
    <Lock aria-hidden className="mt-px size-3 shrink-0" />
    <span>{children}</span>
  </p>
);

const scopeWords = (inc, storeName) => (inc.tenant_id ? storeName.get(inc.tenant_id) || inc.store_name || inc.tenant_id : "Platform-wide");

export default function IncidentsScreen() {
  const [scope, setScope] = useState("all");
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [notice, setNotice] = useState(null);
  const [opening, setOpening] = useState(false);
  const [selected, setSelected] = useState(null); // an incident id
  const openButton = useRef(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api("GET", null, `?${new URLSearchParams({ scope, page: String(page) })}`);
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e?.message || e) }));
    }
  }, [scope, page]);
  useEffect(() => {
    load();
  }, [load]);

  const stores = state.data?.stores || [];
  const storeName = useMemo(() => new Map(stores.map((s) => [s.id, s.name])), [stores]);
  const rows = state.data?.incidents || [];
  const current = rows.find((r) => r.id === selected) || null;

  async function act(body, words) {
    setNotice(null);
    try {
      const j = await api("POST", body);
      setNotice({ tone: "success", text: words });
      await load();
      return j.incident || true;
    } catch (e) {
      setNotice({ tone: "destructive", text: String(e?.message || e) });
      return false;
    }
  }

  const columns = [
    {
      key: "title",
      header: "Incident",
      cell: (i) => (
        <button type="button" className="block max-w-[13rem] min-w-0 lg:max-w-[22rem] rounded-sm py-1 text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => setSelected(i.id)} data-read-control data-incident-row={i.id}>
          <div className={i.status === "open" ? "truncate font-medium text-foreground" : "truncate font-medium text-muted-foreground"}>{i.title}</div>
          <div className="truncate text-xs text-muted-foreground">{scopeWords(i, storeName)}</div>
        </button>
      ),
    },
    { key: "status", header: "Status", cell: (i) => (i.status === "open" ? <Badge variant="warning">Open</Badge> : <Badge variant="muted">Resolved</Badge>) },
    { key: "public_message", header: "Public message", truncate: true, className: "text-muted-foreground", cell: (i) => i.public_message || "None, so no banner" },
    { key: "created_at", header: "Opened", className: "hidden tabular-nums lg:table-cell", cell: (i) => fmtTime(i.created_at) },
    { key: "resolved_at", header: "Resolved", className: "hidden tabular-nums lg:table-cell", cell: (i) => (i.resolved_at ? fmtTime(i.resolved_at) : <span className="text-muted-foreground">—</span>) },
  ];

  const total = state.data?.total || 0;
  const pageSize = state.data?.pageSize || 50;
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <PageHeader
        title="Incidents"
        description={
          state.data
            ? `${state.data.openCount ? `${state.data.openCount} open now.` : "Nothing open."} Merchants see an open incident's public message as a banner in their console.`
            : "Merchants see an open incident's public message as a banner in their console."
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}>
              <RefreshCw className="size-3.5" aria-hidden /> Refresh
            </Button>
            <Button ref={openButton} size="sm" onClick={() => setOpening(true)}>
              <Plus className="size-3.5" aria-hidden /> Open an incident
            </Button>
          </>
        }
      />

      <div className="mb-4 flex max-w-sm items-center gap-3">
        <Label htmlFor="incident-scope" className="shrink-0">
          Show
        </Label>
        <select
          id="incident-scope"
          className={selectClass}
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">Every incident</option>
          <option value="platform">Platform-wide only</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.id})
            </option>
          ))}
        </select>
      </div>

      {notice && (
        <Alert variant={notice.tone} className="mb-4 pr-10" role="status" data-incidents-notice>
          <AlertDescription>{notice.text}</AlertDescription>
          <Button variant="ghost" size="icon-xs" className="absolute top-2 right-2" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <X aria-hidden />
          </Button>
        </Alert>
      )}
      {state.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>{state.error}</span>
            <Button variant="outline" size="sm" onClick={load}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <DataTable
        label="Incidents"
        columns={columns}
        rows={rows}
        loading={state.loading && !state.data}
        empty={
          <EmptyState
            icon={CircleCheck}
            title={scope === "all" ? "No incidents yet." : "No incidents here."}
            description="Open one when something is wrong that merchants should hear about."
            action={
              <Button size="sm" variant="outline" onClick={() => setOpening(true)}>
                Open an incident
              </Button>
            }
          />
        }
        footer={{ offset: (page - 1) * pageSize, total, onPrevious: page > 1 ? () => setPage(page - 1) : null, onNext: page * pageSize < total ? () => setPage(page + 1) : null }}
      />

      {opening && (
        <OpenDialog
          stores={stores}
          returnFocus={openButton}
          onClose={() => setOpening(false)}
          onOpen={async (body) => {
            const inc = await act({ action: "open", ...body }, `Opened “${body.title}”.`);
            if (inc) {
              setOpening(false);
              if (inc.id) setSelected(inc.id);
            }
          }}
        />
      )}

      <IncidentSheet key={current?.id || "none"} incident={current} storeName={storeName} onClose={() => setSelected(null)} act={act} />
    </div>
  );
}

function OpenDialog({ stores, onClose, onOpen, returnFocus }) {
  const [f, setF] = useState({ title: "", tenant: "", publicMessage: "", internalNote: "" });
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!f.title.trim()) return;
    setBusy(true);
    await onOpen({ title: f.title.trim(), tenant: f.tenant || null, publicMessage: f.publicMessage, internalNote: f.internalNote });
    setBusy(false);
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(e) => {
          // back to "Open an incident" (the dialog has no trigger of its own)
          e.preventDefault();
          returnFocus?.current?.focus();
        }}
      >
        <form onSubmit={submit} className="space-y-4" data-incident-form>
          <DialogHeader>
            <DialogTitle>Open an incident</DialogTitle>
            <DialogDescription>The public message shows as a banner in the affected consoles until you resolve it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="incident-title">Title</Label>
            <Input id="incident-title" required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="incident-store">Who it affects</Label>
            <select id="incident-store" className={selectClass} value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })}>
              <option value="">Every store (platform-wide)</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="incident-public">Public message</Label>
            <Textarea id="incident-public" rows={2} maxLength={500} value={f.publicMessage} onChange={(e) => setF({ ...f, publicMessage: e.target.value })} aria-describedby="incident-public-hint" />
            <p id="incident-public-hint" className="text-xs text-muted-foreground">Shown to merchants. Leave it empty to track the incident without a banner.</p>
          </div>
          <BannerPreview incident={{ tenant_id: f.tenant || null, title: f.title || "Title", public_message: f.publicMessage.trim() || null }} />
          <div className="space-y-1.5">
            <Label htmlFor="incident-note">Internal note</Label>
            <Textarea id="incident-note" rows={3} maxLength={2000} value={f.internalNote} onChange={(e) => setF({ ...f, internalNote: e.target.value })} aria-describedby="incident-note-hint" />
            <PrivateHint id="incident-note-hint">Operators only. Never shown to merchants and never written to the audit log.</PrivateHint>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !f.title.trim()}>
              {busy ? "Opening…" : "Open incident"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IncidentSheet({ incident, storeName, onClose, act }) {
  const [update, setUpdate] = useState("");
  const [note, setNote] = useState(incident?.internal_note || "");
  const [closing, setClosing] = useState("");
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(null);
  const [timeline, setTimeline] = useState({ loading: false, rows: [], error: null, n: 0 });
  const id = incident?.id;
  const open = incident?.status === "open";

  useEffect(() => {
    if (!id) return;
    let live = true;
    setTimeline((t) => ({ ...t, loading: true, error: null }));
    api("GET", null, `?timeline=${encodeURIComponent(id)}`)
      .then((j) => live && setTimeline((t) => ({ ...t, loading: false, rows: j.timeline || [] })))
      .catch((e) => live && setTimeline((t) => ({ ...t, loading: false, error: String(e?.message || e) })));
    return () => {
      live = false;
    };
  }, [id, timeline.n]);
  const refreshTimeline = () => setTimeline((t) => ({ ...t, n: t.n + 1 }));

  async function run(kind, body, words, after) {
    setBusy(kind);
    const done = await act(body, words);
    setBusy(null);
    if (done) {
      after?.();
      refreshTimeline();
    }
  }

  return (
    <Sheet open={!!incident} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg" data-incident-sheet={id}>
        {incident && (
          <>
            <SheetHeader className="gap-2 border-b border-border pb-4">
              <div className="flex items-center gap-2">
                {open ? <Badge variant="warning">Open</Badge> : <Badge variant="muted">Resolved</Badge>}
                <span className="truncate text-xs text-muted-foreground">{scopeWords(incident, storeName)}</span>
              </div>
              <SheetTitle className="text-[1.125rem] leading-snug">{incident.title}</SheetTitle>
              <SheetDescription className="tabular-nums">
                Opened {fmtTime(incident.created_at)}
                {incident.resolved_at ? `, resolved ${fmtTime(incident.resolved_at)}` : ""}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-6 px-4 pb-6">
              {open && <BannerPreview incident={incident} />}

              {open && (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (update.trim()) run("update", { action: "update", id, publicMessage: update }, "Update posted. Merchants see the new message.", () => setUpdate(""));
                  }}
                >
                  <Label htmlFor="incident-update">Post an update</Label>
                  <Textarea id="incident-update" rows={2} maxLength={500} value={update} onChange={(e) => setUpdate(e.target.value)} placeholder="The new public message" aria-describedby="incident-update-hint" />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p id="incident-update-hint" className="text-xs text-muted-foreground">
                      Replaces the banner&apos;s message.
                    </p>
                    <Button type="submit" size="sm" disabled={busy === "update" || !update.trim()}>
                      {busy === "update" ? "Posting…" : "Post update"}
                    </Button>
                  </div>
                </form>
              )}

              <form
                className="space-y-2 rounded-card border border-dashed border-border p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  run("note", { action: "note", id, internalNote: note }, "Internal note saved.");
                }}
              >
                <Label htmlFor="incident-note-edit">Internal note</Label>
                <Textarea id="incident-note-edit" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby="incident-note-edit-hint" />
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <PrivateHint id="incident-note-edit-hint">Operators only. The timeline records that it changed, never what it says.</PrivateHint>
                  <Button type="submit" size="sm" variant="outline" disabled={busy === "note" || note === (incident.internal_note || "")}>
                    {busy === "note" ? "Saving…" : "Save note"}
                  </Button>
                </div>
              </form>

              {open && (
                <section aria-labelledby="incident-resolve-heading" className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-destructive/30 px-3 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <h3 id="incident-resolve-heading" className="text-sm font-medium">
                      Resolve
                    </h3>
                    <p className="text-xs text-muted-foreground">Takes the banner down. You can&apos;t reopen it.</p>
                  </div>
                  <Button variant="destructive" size="sm" onClick={() => setResolving(true)}>
                    Resolve incident
                  </Button>
                </section>
              )}

              <Separator />
              <section aria-labelledby="incident-timeline-heading">
                <h3 id="incident-timeline-heading" className="mb-3 text-base font-semibold">
                  Timeline
                </h3>
                {timeline.loading && timeline.rows.length === 0 && (
                  <div className="space-y-4" aria-busy="true" aria-label="Loading the timeline">
                    {[0, 1].map((i) => (
                      <div key={i} className="space-y-1.5 pl-6">
                        <Skeleton className="h-3.5 w-28" />
                        <Skeleton className="h-3 w-56" />
                      </div>
                    ))}
                  </div>
                )}
                {timeline.error && (
                  <Alert variant="destructive">
                    <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span>{timeline.error}</span>
                      <Button variant="outline" size="sm" onClick={refreshTimeline}>
                        Try again
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
                {!timeline.loading && !timeline.error && timeline.rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>}
                <ol className="relative space-y-4 before:absolute before:top-1.5 before:bottom-1.5 before:left-[5px] before:w-px before:bg-border" data-incident-timeline>
                  {timeline.rows.map((r, i) => (
                    <li key={i} className="relative pl-6 text-sm">
                      <span aria-hidden className={`absolute top-1.5 left-0 size-[11px] rounded-full border-2 border-background ${DOT[r.kind] || "bg-muted-foreground/50"}`} />
                      <div className="font-medium">{TIMELINE_WORDS[r.kind] || r.kind}</div>
                      {r.message && <div className="text-foreground">{r.message}</div>}
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {r.by}, <span className="tabular-nums">{fmtTime(r.at)}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            </div>

            <AlertDialog open={resolving} onOpenChange={setResolving}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogMedia className="bg-destructive/10 text-destructive">
                    <CircleCheck aria-hidden />
                  </AlertDialogMedia>
                  <AlertDialogTitle>Resolve “{incident.title}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {`The banner leaves ${incident.tenant_id ? `${scopeWords(incident, storeName)}'s console` : "every store's console"} on the next page load, and the incident can't be reopened. A closing message is kept in the timeline.`}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-1.5">
                  <Label htmlFor="incident-closing">Closing message (optional)</Label>
                  <Textarea id="incident-closing" rows={2} maxLength={500} value={closing} onChange={(e) => setClosing(e.target.value)} />
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it open</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => run("resolve", { action: "resolve", id, closingMessage: closing || null }, `Resolved “${incident.title}”.`, () => setClosing(""))}>
                    Resolve
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
