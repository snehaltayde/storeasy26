"use client";

// Phase 3 line 4: the operator's feature flags. The list (key, description,
// state in words, critical, expiry, who changed it last and when), search,
// create and edit, per-store overrides, the emergency disable, delete, and each
// flag's history from audit_log. Data through /api/platform/flags.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, MoreHorizontal, Pencil, Plus, PowerOff, RefreshCw, Search, Store, Trash2, X, Zap } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { FLAG_ACTION_WORDS, FLAG_KEY_PATTERN, disableWords, fallbackWords, flagState, fmtTime } from "./flagWords";

const selectClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-muted px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

async function api(method, body, query = "") {
  const res = await fetch(`/api/platform/flags${query}`, {
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

// datetime-local wants "YYYY-MM-DDTHH:mm" (shown and read as UTC here)
const toLocalInput = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16) : "");
const fromLocalInput = (v) => (v ? new Date(`${v}:00Z`).toISOString() : null);

export default function FlagsScreen() {
  const [state, setState] = useState({ loading: true, error: null, flags: [], stores: [] });
  const [q, setQ] = useState("");
  const [notice, setNotice] = useState(null);
  const [editing, setEditing] = useState(null); // {} new, or a flag
  const [overrides, setOverrides] = useState(null); // a flag's key
  const [history, setHistory] = useState(null); // a flag's key
  const [confirm, setConfirm] = useState(null); // { kind: "disable" | "delete", flag }
  // Dialogs and sheets opened from a row's menu hand focus back to that row's
  // "…" button when they close (the menu item they came from is gone by then);
  // if the row went away (deleted), focus goes to the search box.
  const returnTo = useRef(null);
  const newFlagButton = useRef(null);
  const restoreFocus = useCallback((e) => {
    const key = returnTo.current;
    e.preventDefault();
    returnTo.current = null;
    const el = key ? document.querySelector(`[data-flag-actions="${CSS.escape(key)}"]`) || document.getElementById("flag-search") : newFlagButton.current;
    el?.focus();
  }, []);
  const from = (key, fn) => () => {
    returnTo.current = key;
    fn();
  };

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const j = await api("GET");
      setState({ loading: false, error: null, flags: j.flags || [], stores: j.stores || [] });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e?.message || e) }));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const storeName = useMemo(() => new Map(state.stores.map((s) => [s.id, s.name])), [state.stores]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return state.flags;
    return state.flags.filter((f) => `${f.key} ${f.description || ""}`.toLowerCase().includes(needle));
  }, [state.flags, q]);

  async function act(body, words) {
    setNotice(null);
    try {
      await api("POST", body);
      setNotice({ tone: "success", text: words });
      await load();
      return true;
    } catch (e) {
      setNotice({ tone: "destructive", text: String(e?.message || e) });
      return false;
    }
  }

  const columns = [
    {
      key: "key",
      header: "Flag",
      className: "w-full max-w-0 min-w-[10rem] lg:min-w-[13rem]",
      cell: (f) => (
        <div className="min-w-0 py-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={f.expired ? "truncate font-mono text-[0.8125rem] text-muted-foreground" : "truncate font-mono text-[0.8125rem] text-foreground"}>{f.key}</span>
            {f.critical && (
              <Zap role="img" aria-label="Critical" className="size-3.5 shrink-0 text-warning lg:hidden" />
            )}
          </div>
          {f.description && <FlagDescription text={f.description} />}
        </div>
      ),
    },
    {
      key: "state",
      header: "State",
      cell: (f) => {
        const s = flagState(f);
        return (
          <Badge variant={s.tone} data-flag-state>
            {s.label}
          </Badge>
        );
      },
    },
    {
      key: "critical",
      header: "Critical",
      className: "hidden lg:table-cell",
      cell: (f) =>
        f.critical ? (
          <Badge variant="warning">
            <Zap aria-hidden /> Critical
          </Badge>
        ) : (
          <span className="text-muted-foreground">No</span>
        ),
    },
    {
      key: "expires_at",
      header: "Expires",
      className: "min-w-[8.5rem] max-w-[8.5rem] whitespace-normal lg:max-w-none lg:whitespace-nowrap",
      cell: (f) => <span className={f.expired ? "text-muted-foreground tabular-nums line-through decoration-muted-foreground/60" : "tabular-nums"}>{f.expires_at ? fmtTime(f.expires_at) : "Never"}</span>,
    },
    {
      key: "updated",
      header: "Last change",
      className: "hidden lg:table-cell",
      cell: (f) => (
        <div className="max-w-[11rem] text-xs leading-tight">
          <div className="truncate">{f.updated_by_name || "—"}</div>
          <div className="text-muted-foreground tabular-nums">{fmtTime(f.updated_at)}</div>
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <PageHeader
        title="Feature flags"
        description="Turn features on or off for every store, or one store at a time. What a store has paid for lives in Billing, not here."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}>
              <RefreshCw className="size-3.5" aria-hidden /> Refresh
            </Button>
            <Button ref={newFlagButton} size="sm" onClick={() => setEditing({})}>
              <Plus className="size-3.5" aria-hidden /> New flag
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="relative w-full max-w-sm">
          <Label htmlFor="flag-search" className="sr-only">
            Search flags
          </Label>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="flag-search" type="search" placeholder="Search by key or description" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        {!state.loading || state.flags.length ? (
          <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
            {q.trim() ? `${rows.length} of ${state.flags.length} flags` : `${state.flags.length} ${state.flags.length === 1 ? "flag" : "flags"}`}
          </p>
        ) : null}
      </div>

      {notice && (
        <Alert variant={notice.tone} className="mb-4 pr-10" role="status" data-flags-notice>
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
        label="Feature flags"
        columns={columns}
        rows={rows}
        rowKey={(f) => f.key}
        loading={state.loading && !state.flags.length}
        empty={
          <EmptyState
            title={q ? `No flag matches “${q}”.` : "No flags yet."}
            description={q ? null : "A flag that doesn't exist counts as its code's default, usually on."}
            action={q ? null : <Button size="sm" onClick={() => setEditing({})}>New flag</Button>}
          />
        }
        rowActions={(f) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Actions for ${f.key}`} data-flag-actions={f.key}>
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onSelect={from(f.key, () => setEditing(f))}>
                <Pencil aria-hidden /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={from(f.key, () => setOverrides(f.key))}>
                <Store aria-hidden /> Store overrides
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={from(f.key, () => setHistory(f.key))}>
                <History aria-hidden /> History
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={from(f.key, () => setConfirm({ kind: "disable", flag: f }))}>
                <PowerOff aria-hidden /> Emergency disable
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={from(f.key, () => setConfirm({ kind: "delete", flag: f }))}>
                <Trash2 aria-hidden /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      />

      {editing && <FlagDialog flag={editing} onCloseAutoFocus={restoreFocus} onClose={() => setEditing(null)} onSave={(flag, isNew) => act({ flag }, isNew ? `Created ${flag.key}.` : `Saved ${flag.key}.`)} />}

      <OverridesSheet
        flag={state.flags.find((f) => f.key === overrides) || null}
        stores={state.stores}
        storeName={storeName}
        onClose={() => setOverrides(null)}
        onCloseAutoFocus={restoreFocus}
        onSet={(tenant, on) => act({ override: { key: overrides, tenant, on } }, on == null ? `Removed the override for ${storeName.get(tenant) || tenant}.` : `${storeName.get(tenant) || tenant} is now ${on ? "on" : "off"}.`)}
      />

      <HistorySheet flagKey={history} onClose={() => setHistory(null)} onCloseAutoFocus={restoreFocus} />

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent onCloseAutoFocus={restoreFocus}>
          {confirm?.kind === "disable" && (
            <>
              <AlertDialogHeader>
                <AlertDialogMedia className="bg-destructive/10 text-destructive">
                  <PowerOff aria-hidden />
                </AlertDialogMedia>
                <AlertDialogTitle>Switch this flag off everywhere?</AlertDialogTitle>
                <AlertDialogDescription>
                  This turns the flag off for every store and clears its store overrides. {disableWords(confirm.flag.critical)}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <ConfirmFacts flag={confirm.flag} />
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => act({ disable: { key: confirm.flag.key } }, `${confirm.flag.key} is off for every store.`)}>
                  Switch off now
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
          {confirm?.kind === "delete" && (
            <>
              <AlertDialogHeader>
                <AlertDialogMedia className="bg-destructive/10 text-destructive">
                  <Trash2 aria-hidden />
                </AlertDialogMedia>
                <AlertDialogTitle>Delete this flag?</AlertDialogTitle>
                <AlertDialogDescription>
                  The flag and its store overrides go away and can&apos;t be brought back. {fallbackWords(confirm.flag.fallback)} Its history stays.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <ConfirmFacts flag={confirm.flag} />
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => act({ remove: { key: confirm.flag.key } }, `Deleted ${confirm.flag.key}.`)}>
                  Delete flag
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// A long description truncates to the column; the whole of it shows in a
// tooltip on hover or focus (docs/UI.md "Crowded").
function FlagDescription({ text }) {
  if (text.length <= 70) return <div className="truncate text-xs text-muted-foreground">{text}</div>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={0} className="truncate rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {text}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  );
}

// What the confirm is about to change: the key, its state now, and its overrides.
function ConfirmFacts({ flag }) {
  const s = flagState(flag);
  const n = Object.keys(flag.tenants || {}).length;
  return (
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-md border border-border bg-muted/60 px-3 py-2.5 text-sm">
      <dt className="text-muted-foreground">Flag</dt>
      <dd className="min-w-0 truncate font-mono text-[0.8125rem]">{flag.key}</dd>
      <dt className="text-muted-foreground">Now</dt>
      <dd className="flex flex-wrap items-center gap-1.5">
        <Badge variant={s.tone}>{s.label}</Badge>
        {flag.critical && (
          <Badge variant="warning">
            <Zap aria-hidden /> Critical
          </Badge>
        )}
      </dd>
      <dt className="text-muted-foreground">Overrides</dt>
      <dd>{n ? `${n} ${n === 1 ? "store" : "stores"}` : "None"}</dd>
    </dl>
  );
}

// The history's shape while it loads.
function HistorySkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading history">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-1.5 pl-5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-48" />
        </div>
      ))}
    </div>
  );
}

function FlagDialog({ flag, onClose, onSave, onCloseAutoFocus }) {
  const isNew = !flag.key;
  const [f, setF] = useState({
    key: flag.key || "ff_",
    description: flag.description || "",
    default_on: !!flag.default_on,
    critical: !!flag.critical,
    expires: toLocalInput(flag.expires_at),
  });
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const keyOk = FLAG_KEY_PATTERN.test(f.key);
  const showKeyError = !keyOk && (touched || f.key !== "ff_");

  async function submit(e) {
    e.preventDefault();
    if (!keyOk) return;
    setBusy(true);
    const ok = await onSave({ key: f.key, description: f.description, default_on: f.default_on, critical: f.critical, expires_at: fromLocalInput(f.expires), tenants: flag.tenants || {} }, isNew);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={submit} className="space-y-4" data-flag-form>
          <DialogHeader>
            <DialogTitle>{isNew ? "New flag" : `Edit ${flag.key}`}</DialogTitle>
            <DialogDescription>Store overrides are kept. Use Store overrides to change them.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="flag-key">Key</Label>
            <Input id="flag-key" value={f.key} disabled={!isNew} autoComplete="off" spellCheck={false} onBlur={() => setTouched(true)} onChange={(e) => setF({ ...f, key: e.target.value.trim() })} aria-invalid={showKeyError || undefined} aria-describedby="flag-key-hint" className="font-mono" />
            <p id="flag-key-hint" className={showKeyError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              Starts with ff_, then lowercase letters, digits and dashes.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="flag-description">Description</Label>
            <Textarea id="flag-description" rows={2} maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </div>
          <div className="divide-y divide-border rounded-md border border-border">
            <div className="flex items-center justify-between gap-4 px-3 py-2.5">
              <div className="space-y-0.5">
                <Label htmlFor="flag-default">On for every store</Label>
                <p className="text-xs text-muted-foreground">Store overrides still win for their store.</p>
              </div>
              <Switch id="flag-default" checked={f.default_on} onCheckedChange={(v) => setF({ ...f, default_on: v })} />
            </div>
            <div className="flex items-center justify-between gap-4 px-3 py-2.5">
              <div className="space-y-0.5">
                <Label htmlFor="flag-critical">Critical</Label>
                <p className="text-xs text-muted-foreground">Read fresh on every request, so changes apply at once. For kill switches such as checkout.</p>
              </div>
              <Switch id="flag-critical" checked={f.critical} onCheckedChange={(v) => setF({ ...f, critical: v })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="flag-expires">Expires (UTC, optional)</Label>
            <Input id="flag-expires" type="datetime-local" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} className="tabular-nums sm:max-w-[16rem]" />
            <p className="text-xs text-muted-foreground">After this time the flag is off for everyone.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !keyOk}>
              {busy ? "Saving…" : isNew ? "Create flag" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OverridesSheet({ flag, stores, storeName, onClose, onSet, onCloseAutoFocus }) {
  const [tenant, setTenant] = useState("");
  const [on, setOn] = useState("on");
  const [busy, setBusy] = useState(false);
  const list = Object.entries(flag?.tenants || {});

  async function add(e) {
    e.preventDefault();
    if (!tenant) return;
    setBusy(true);
    if (await onSet(tenant, on === "on")) setTenant("");
    setBusy(false);
  }

  return (
    <Sheet open={!!flag} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={(e) => {
          // start on the store picker, never on a row's Remove
          e.preventDefault();
          document.getElementById("override-store")?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle>Store overrides</SheetTitle>
          <SheetDescription>
            <span className="font-mono text-foreground">{flag?.key}</span> is {flag?.default_on ? "on" : "off"} for every store not listed here.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          {list.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">No store overrides. Every store follows the flag.</p>
          ) : (
            <ul className="divide-y divide-border rounded-card border border-border" data-flag-overrides>
              {list.map(([id, v]) => (
                <li key={id} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{storeName.get(id) || id}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{id}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge variant={Number(v) ? "success" : "muted"}>{Number(v) ? "On" : "Off"}</Badge>
                    <Button variant="ghost" size="sm" aria-label={`Remove the override for ${storeName.get(id) || id}`} onClick={() => onSet(id, null)}>
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={add} className="space-y-3 rounded-card border border-border bg-muted/40 p-3">
            <h3 className="text-sm font-medium">Add or change an override</h3>
            <div className="space-y-1.5">
              <Label htmlFor="override-store">Store</Label>
              <select id="override-store" className={selectClass} value={tenant} onChange={(e) => setTenant(e.target.value)}>
                <option value="">Pick a store</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.id})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="override-on">For this store</Label>
              <select id="override-on" className={selectClass} value={on} onChange={(e) => setOn(e.target.value)}>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
            <Button type="submit" size="sm" disabled={busy || !tenant}>
              {busy ? "Saving…" : "Set override"}
            </Button>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function HistorySheet({ flagKey, onClose, onCloseAutoFocus }) {
  const [state, setState] = useState({ loading: false, error: null, rows: [] });
  useEffect(() => {
    if (!flagKey) return;
    let live = true;
    setState({ loading: true, error: null, rows: [] });
    api("GET", null, `?history=${encodeURIComponent(flagKey)}`)
      .then((j) => live && setState({ loading: false, error: null, rows: j.history || [] }))
      .catch((e) => live && setState({ loading: false, error: String(e?.message || e), rows: [] }));
    return () => {
      live = false;
    };
  }, [flagKey]);

  const detail = (h) => {
    const c = h.changes || {};
    if (h.action === "flags.override") return `${c.store}: ${c.on === "removed" ? "override removed" : c.on ? "on" : "off"}`;
    if (h.action === "flags.set") return [c.default_on ? "on for everyone" : "off by default", c.critical ? "critical" : null, c.tenants ? `${c.tenants} store overrides` : null, c.expires_at ? `expires ${fmtTime(c.expires_at)}` : null].filter(Boolean).join(", ");
    return null;
  };

  return (
    <Sheet open={!!flagKey} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
          <SheetDescription className="font-mono">{flagKey}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {state.loading && <HistorySkeleton />}
          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {!state.loading && !state.error && state.rows.length === 0 && <p className="text-sm text-muted-foreground">No changes recorded.</p>}
          <ol className="relative space-y-4 before:absolute before:top-1.5 before:bottom-1.5 before:left-[5px] before:w-px before:bg-border" data-flag-history>
            {state.rows.map((h, i) => {
              const destructive = h.action === "flags.emergency_disable" || h.action === "flags.delete";
              return (
                <li key={i} className="relative pl-6 text-sm">
                  <span aria-hidden className={`absolute top-1.5 left-0 size-[11px] rounded-full border-2 border-background ${destructive ? "bg-destructive" : i === 0 ? "bg-primary" : "bg-muted-foreground/50"}`} />
                  <div className="font-medium">{FLAG_ACTION_WORDS[h.action] || h.action}</div>
                  {detail(h) && <div className="text-muted-foreground">{detail(h)}</div>}
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {h.by}, <span className="tabular-nums">{fmtTime(h.at)}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </SheetContent>
    </Sheet>
  );
}
