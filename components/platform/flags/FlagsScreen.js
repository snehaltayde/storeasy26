"use client";

// Phase 3 line 4: the operator's feature flags. The list (key, description,
// state in words, critical, expiry, who changed it last and when), search,
// create and edit, per-store overrides, the emergency disable, delete, and each
// flag's history from audit_log. Data through /api/platform/flags.
import { useCallback, useEffect, useMemo, useState } from "react";
import { History, MoreHorizontal, Plus, RefreshCw, Search, Store } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
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
import { Textarea } from "@/components/ui/textarea";
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
      cell: (f) => (
        <div className="min-w-0">
          <div className="font-mono text-[0.8125rem]">{f.key}</div>
          {f.description && <div className="truncate text-xs text-muted-foreground">{f.description}</div>}
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
    { key: "critical", header: "Critical", cell: (f) => (f.critical ? <Badge variant="warning">Critical</Badge> : <span className="text-muted-foreground">No</span>) },
    { key: "expires_at", header: "Expires", cell: (f) => (f.expires_at ? fmtTime(f.expires_at) : "Never") },
    {
      key: "updated",
      header: "Last change",
      cell: (f) => (
        <div className="text-xs">
          <div>{f.updated_by_name || "—"}</div>
          <div className="text-muted-foreground">{fmtTime(f.updated_at)}</div>
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
      <PageHeader
        title="Feature flags"
        description="Roll features out or switch them off, for every store or one at a time. Flags are not billing: what a store bought lives in Billing."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={state.loading}>
              <RefreshCw className="size-3.5" aria-hidden /> Refresh
            </Button>
            <Button size="sm" onClick={() => setEditing({})}>
              <Plus className="size-3.5" aria-hidden /> New flag
            </Button>
          </>
        }
      />

      <div className="mb-4 flex items-end gap-3">
        <div className="relative max-w-sm flex-1">
          <Label htmlFor="flag-search" className="sr-only">
            Search flags
          </Label>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="flag-search" type="search" placeholder="Search by key or description" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
      </div>

      {notice && (
        <Alert variant={notice.tone} className="mb-4" role="status" data-flags-notice>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}
      {state.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            {state.error}{" "}
            <button type="button" className="underline" onClick={load}>
              Try again
            </button>
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
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditing(f)}>Edit</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setOverrides(f.key)}>
                <Store aria-hidden /> Store overrides
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setHistory(f.key)}>
                <History aria-hidden /> History
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm({ kind: "disable", flag: f })}>
                Emergency disable
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm({ kind: "delete", flag: f })}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      />

      {editing && <FlagDialog flag={editing} onClose={() => setEditing(null)} onSave={(flag, isNew) => act({ flag }, isNew ? `Created ${flag.key}.` : `Saved ${flag.key}.`)} />}

      <OverridesSheet
        flag={state.flags.find((f) => f.key === overrides) || null}
        stores={state.stores}
        storeName={storeName}
        onClose={() => setOverrides(null)}
        onSet={(tenant, on) => act({ override: { key: overrides, tenant, on } }, on == null ? `Removed the override for ${storeName.get(tenant) || tenant}.` : `${storeName.get(tenant) || tenant} is now ${on ? "on" : "off"}.`)}
      />

      <HistorySheet flagKey={history} onClose={() => setHistory(null)} />

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          {confirm?.kind === "disable" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Switch {confirm.flag.key} off everywhere?</AlertDialogTitle>
                <AlertDialogDescription>
                  This turns the flag off for every store and clears its store overrides. {disableWords(confirm.flag.critical)}
                </AlertDialogDescription>
              </AlertDialogHeader>
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
                <AlertDialogTitle>Delete {confirm.flag.key}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The flag and its store overrides go away. {fallbackWords(confirm.flag.fallback)} Its history stays.
                </AlertDialogDescription>
              </AlertDialogHeader>
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

function FlagDialog({ flag, onClose, onSave }) {
  const isNew = !flag.key;
  const [f, setF] = useState({
    key: flag.key || "ff_",
    description: flag.description || "",
    default_on: !!flag.default_on,
    critical: !!flag.critical,
    expires: toLocalInput(flag.expires_at),
  });
  const [busy, setBusy] = useState(false);
  const keyOk = FLAG_KEY_PATTERN.test(f.key);

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
      <DialogContent>
        <form onSubmit={submit} className="space-y-4" data-flag-form>
          <DialogHeader>
            <DialogTitle>{isNew ? "New flag" : `Edit ${flag.key}`}</DialogTitle>
            <DialogDescription>Store overrides are kept. Use Store overrides to change them.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="flag-key">Key</Label>
            <Input id="flag-key" value={f.key} disabled={!isNew} onChange={(e) => setF({ ...f, key: e.target.value.trim() })} aria-invalid={!keyOk || undefined} aria-describedby="flag-key-hint" className="font-mono" />
            <p id="flag-key-hint" className={keyOk ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
              Starts with ff_, then lowercase letters, digits and dashes.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="flag-description">Description</Label>
            <Textarea id="flag-description" rows={2} maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="flag-default">On for every store</Label>
            <Switch id="flag-default" checked={f.default_on} onCheckedChange={(v) => setF({ ...f, default_on: v })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="flag-critical">Critical</Label>
              <p className="text-xs text-muted-foreground">Read fresh on every request, so changes apply at once. For kill switches such as checkout.</p>
            </div>
            <Switch id="flag-critical" checked={f.critical} onCheckedChange={(v) => setF({ ...f, critical: v })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="flag-expires">Expires (UTC, optional)</Label>
            <Input id="flag-expires" type="datetime-local" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} />
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

function OverridesSheet({ flag, stores, storeName, onClose, onSet }) {
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
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Store overrides</SheetTitle>
          <SheetDescription>
            <span className="font-mono">{flag?.key}</span> is {flag?.default_on ? "on" : "off"} for every other store.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          {list.length === 0 ? (
            <p className="text-sm text-muted-foreground">No store overrides.</p>
          ) : (
            <ul className="divide-y divide-border rounded-card border border-border" data-flag-overrides>
              {list.map(([id, v]) => (
                <li key={id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">
                    {storeName.get(id) || id} <span className="font-mono text-xs text-muted-foreground">{id}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant={Number(v) ? "success" : "muted"}>{Number(v) ? "On" : "Off"}</Badge>
                    <Button variant="ghost" size="sm" onClick={() => onSet(id, null)}>
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={add} className="space-y-3 rounded-card border border-border p-3">
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

function HistorySheet({ flagKey, onClose }) {
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
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
          <SheetDescription className="font-mono">{flagKey}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {state.loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {state.error && <p className="text-sm text-destructive">{state.error}</p>}
          {!state.loading && !state.error && state.rows.length === 0 && <p className="text-sm text-muted-foreground">No changes recorded.</p>}
          <ol className="space-y-3" data-flag-history>
            {state.rows.map((h, i) => (
              <li key={i} className="border-l-2 border-border pl-3 text-sm">
                <div className="font-medium">{FLAG_ACTION_WORDS[h.action] || h.action}</div>
                {detail(h) && <div className="text-muted-foreground">{detail(h)}</div>}
                <div className="text-xs text-muted-foreground">
                  {h.by} · {fmtTime(h.at)}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </SheetContent>
    </Sheet>
  );
}
