"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { SELECT_CLASS } from "@/components/admin/settings/SecretField";

// Settings → Audit log (Phase 2 line 7): who did what on this store and when,
// newest first, 50 a page ("Load more"), filtered by who, action and dates,
// all from GET /api/admin/audit (audit.read). Every filter and Load more is a
// read. A row's changes are the route's `changes` lines: redacted at write and
// again on the way out, so a secret value never shows (a secret's name may).
const PAGE = 50;
const when = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const ACTION_WORDS = {
  "settings.write": "Changed settings",
  "integration.revoke": "Disconnected an integration",
  "auth.login": "Signed in",
  "auth.operator_login": "Storeasy's team signed in",
  "storefront.write": "Edited the storefront",
  "storefront.publish": "Published",
  "offers.write": "Changed an offer",
  "sync.run": "Synced from Shopify",
  "domain.verified": "Verified a domain",
  "domain.claimed": "Added a domain",
  "domain.primary": "Changed the primary domain",
  "domain.removed": "Removed a domain",
  "team.manage": "Changed the team",
  "team.invite_created": "Invited someone",
  "team.invite_accepted": "Joined the team",
  "support.grant_created": "Gave Storeasy's team access",
  "support.grant_revoked": "Ended Storeasy's team access",
  "orders.cancel": "Cancelled an order",
  "returns.decide": "Decided a return",
  "privacy.customer_redact": "Erased a shopper's data",
};

// filters → the route's query (a "to" date counts the whole day)
export function auditQuery({ actor = "", action = "", from = "", to = "" } = {}, before = null, facets = false) {
  const q = new URLSearchParams({ limit: String(PAGE) });
  if (actor) q.set("actor", actor);
  if (action) q.set("action", action);
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) q.set("since", `${from}T00:00:00.000Z`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) q.set("until", new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString());
  if (before) q.set("before", before);
  if (facets) q.set("facets", "1");
  return `/api/admin/audit?${q}`;
}

const COLUMNS = [
  { key: "at", header: "When", className: "w-44 align-top", cell: (r) => <span className="whitespace-nowrap font-mono text-xs">{when(r.at)}</span> },
  { key: "who", header: "Who", className: "w-48 max-w-48 align-top", truncate: true, cell: (r) => r.who || r.actor_kind },
  {
    key: "action",
    header: "What",
    className: "w-48 align-top",
    cell: (r) =>
      ACTION_WORDS[r.action] ? (
        <span title={r.action}>{ACTION_WORDS[r.action]}</span>
      ) : (
        // an action without plain words yet: shown as the recorded name, in mono, so it reads as a name
        <span className="font-mono text-xs text-muted-foreground">{r.action}</span>
      ),
  },
  {
    key: "changes",
    header: "Details",
    className: "align-top",
    cell: (r) => (
      <span className="block min-w-0 text-xs text-muted-foreground">
        {r.resource && (
          <span className="block truncate font-mono" title={r.resource}>
            {r.resource}
          </span>
        )}
        {(r.changes || []).map((c) => (
          <span key={c} className="block truncate font-mono" title={c}>
            {c}
          </span>
        ))}
      </span>
    ),
  },
];

export function AuditTable() {
  const [filters, setFilters] = useState({ actor: "", action: "", from: "", to: "" });
  const [rows, setRows] = useState(null);
  const [next, setNext] = useState(null);
  const [facets, setFacets] = useState(null);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [more, setMore] = useState(false);
  const haveFacets = useRef(false); // the filter choices are read once, with the first page

  const load = useCallback(
    async (before = null) => {
      setError(null);
      if (before) setMore(true);
      else setRows(null);
      try {
        const res = await fetch(auditQuery(filters, before, !haveFacets.current), { headers: { Accept: "application/json" }, cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error();
        setRows((r) => (before ? [...(r || []), ...data.entries] : data.entries));
        setNext(data.next || null);
        setNote(data.note || null);
        if (data.facets) {
          haveFacets.current = true;
          setFacets(data.facets);
        }
      } catch {
        setError("We couldn't load the audit log just now.");
        if (!before) setRows([]);
      }
      setMore(false);
    },
    [filters], // a filter change reads the first page again
  );
  useEffect(() => {
    load();
  }, [load]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const filtered = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-4" data-settings-tab="audit">
      <p className="text-sm text-muted-foreground">
        Every change to settings, integrations, billing, the team and what's published, as it was recorded. Nothing here can be edited or deleted.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label="Filter the audit log">
        <div className="space-y-1.5">
          <Label htmlFor="audit-who">Who</Label>
          <select id="audit-who" className={SELECT_CLASS} value={filters.actor} onChange={set("actor")} data-read-control>
            <option value="">Anyone</option>
            {(facets?.actors || []).map((a) => (
              <option key={a.actor} value={a.actor}>
                {a.label || a.kind}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-action">What</Label>
          <select id="audit-action" className={SELECT_CLASS} value={filters.action} onChange={set("action")} data-read-control>
            <option value="">Any change</option>
            {(facets?.actions || []).map((a) => (
              <option key={a} value={a}>
                {ACTION_WORDS[a] || a}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-from">From</Label>
          <Input id="audit-from" type="date" value={filters.from} onChange={set("from")} data-read-control />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-to">To</Label>
          <Input id="audit-to" type="date" value={filters.to} onChange={set("to")} data-read-control />
        </div>
      </div>
      {error && (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-border px-4 py-3 text-sm" role="alert">
          <span className="flex-1">{error}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => load()} data-read-control>
            Try again
          </Button>
        </div>
      )}
      <DataTable
        label="Audit log"
        columns={COLUMNS}
        rows={rows || []}
        loading={rows === null}
        empty={
          <EmptyState
            title={filtered ? "Nothing matches these filters" : "Nothing recorded yet"}
            description={
              note === "audit log needs the platform control plane"
                ? "This store runs without Storeasy's platform, so nothing is recorded."
                : filtered
                  ? "Try a wider date range or anyone."
                  : "Changes show here as soon as someone makes one."
            }
            action={
              filtered ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setFilters({ actor: "", action: "", from: "", to: "" })} data-read-control>
                  Clear filters
                </Button>
              ) : null
            }
          />
        }
      />
      {next && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" onClick={() => load(next)} disabled={more} data-read-control>
            {more ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
