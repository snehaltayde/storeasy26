"use client";

// The operator's Stores list (Phase 3 line 1): search, filters and sort live in
// the URL (?q=&status=&plan=&attention=1&sort=&dir=&offset=), so a link opens
// the same list. 50 rows a page from GET /api/platform/tenants (control-plane
// SQL only); live health is then asked for the visible rows alone
// (?health=id,id), so a slow store never holds the list up.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LifeBuoy, Plus, RefreshCw, Search, Siren, Store } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import FleetStrip from "./FleetStrip";
import HealthMark from "./HealthMark";
import { ATTENTION_WORDS, STATUS_FILTERS, STORE_STATUS, SUBSCRIPTION, onboardingWords, word } from "./storesWords";

const selectClass =
  "h-8 rounded-md border border-input bg-muted px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export default function StoresTable() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const qs = sp.toString();
  const q = sp.get("q") || "";
  const sort = ["name", "created", "updated"].includes(sp.get("sort")) ? sp.get("sort") : "created";
  const dir = sp.get("dir") === "asc" || sp.get("dir") === "desc" ? sp.get("dir") : sort === "name" ? "asc" : "desc";

  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [health, setHealth] = useState({});
  const [search, setSearch] = useState(q);
  const seq = useRef(0);

  const setParams = useCallback(
    (patch) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "" || v === false) next.delete(k);
        else next.set(k, String(v));
      }
      // a new search, filter or sort starts again at page one
      if (!Object.hasOwn(patch, "offset")) next.delete("offset");
      router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
    },
    [sp, router, pathname],
  );

  const loadHealth = useCallback(async (ids, id) => {
    if (!ids.length) return;
    try {
      const res = await fetch(`/api/platform/tenants?health=${ids.map(encodeURIComponent).join(",")}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (id !== seq.current) return;
      // a failed check is never healthy: every row it named reads unreachable
      const got = res.ok && body?.ok ? body.health : {};
      setHealth(Object.fromEntries(ids.map((x) => [x, got[x] || { state: "unreachable", reasons: [] }])));
    } catch {
      if (id === seq.current) setHealth(Object.fromEntries(ids.map((x) => [x, { state: "unreachable", reasons: [] }])));
    }
  }, []);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    setHealth({});
    try {
      const res = await fetch(`/api/platform/tenants${qs ? `?${qs}` : ""}`, { cache: "no-store" });
      if (res.status === 401) {
        window.location.assign("/platform");
        return;
      }
      const body = await res.json().catch(() => null);
      if (id !== seq.current) return;
      if (!res.ok || !body?.ok) throw new Error("We couldn't load the stores just now.");
      setState({ loading: false, error: null, data: body });
      loadHealth(body.stores.map((s) => s.id), id);
    } catch (e) {
      if (id === seq.current) setState((s) => ({ loading: false, error: String(e?.message || e), data: s.data }));
    }
  }, [qs, loadHealth]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setSearch(q), [q]);

  const data = state.data;
  const stores = data?.stores || [];
  const filtered = Boolean(q || sp.get("status") || sp.get("plan") || sp.get("attention"));
  const fleetEmpty = data && data.counts.all === 0;

  const columns = [
    {
      key: "name",
      header: "Store",
      sortable: true,
      // long names truncate; the whole name is the link's title
      className: "max-w-64 min-w-44",
      cell: (r) => (
        <span className="flex min-w-0 flex-col" title={r.name}>
          <span className="truncate">{r.name}</span>
          <span className="truncate font-mono text-xs font-normal text-muted-foreground">{r.id}</span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => {
        const s = word(STORE_STATUS, r.status);
        return (
          <Badge variant={s.tone} data-status={r.status}>
            {s.label}
          </Badge>
        );
      },
    },
    // health sits beside status: the two things an operator scans for
    { key: "health", header: "Health", className: "min-w-60 max-w-72", cell: (r) => <HealthMark health={health[r.id]} /> },
    {
      key: "plan",
      header: "Plan",
      cell: (r) => (
        <span className="flex flex-col whitespace-nowrap">
          <span>{data?.plans.find((p) => p.id === r.plan)?.name || r.plan || "No plan"}</span>
          {r.subscription && <span className="text-xs text-muted-foreground">{word(SUBSCRIPTION, r.subscription).label}</span>}
        </span>
      ),
    },
    { key: "onboarding", header: "Onboarding", cell: (r) => <span className={`font-mono text-[0.8125rem] tabular-nums ${r.onboarding?.open ? "text-success" : ""}`}>{onboardingWords(r.onboarding)}</span> },
    {
      key: "flags",
      header: "Flags",
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.supportOpen && (
            <Badge variant="info" data-flag="support">
              <LifeBuoy aria-hidden /> Support access open
            </Badge>
          )}
          {r.incidentOpen && (
            <Badge variant="danger" data-flag="incident">
              <Siren aria-hidden /> Open incident
            </Badge>
          )}
          {r.attentionReasons
            .filter((a) => a !== "incident_open")
            .map((a) => (
              <Badge key={a} variant="warning" data-flag={a}>
                {ATTENTION_WORDS[a]}
              </Badge>
            ))}
        </span>
      ),
    },
    { key: "created", header: "Created", sortable: true, className: "hidden xl:table-cell", cell: (r) => <span className="font-mono text-xs tabular-nums text-muted-foreground">{(r.createdAt || "").slice(0, 10) || "—"}</span> },
    { key: "updated", header: "Last updated", sortable: true, className: "hidden xl:table-cell", cell: (r) => <span className="font-mono text-xs tabular-nums text-muted-foreground">{(r.updatedAt || "").slice(0, 10) || "—"}</span> },
  ];

  const newStore = (
    <Button size="sm" asChild>
      <a href="/platform/stores/new">
        <Plus aria-hidden /> New store
      </a>
    </Button>
  );

  return (
    <TooltipProvider>
      <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6" data-screen="platform-stores">
        <PageHeader
          title="Stores"
          description="Every store on Storeasy: its status, plan and health. Open one for the details."
          actions={
            <>
              <Button variant="outline" size="sm" data-read-control onClick={load} disabled={state.loading}>
                <RefreshCw aria-hidden /> Refresh
              </Button>
              {newStore}
            </>
          }
        />

        <FleetStrip counts={data?.counts || (state.error ? false : null)} />

        <form
          role="search"
          className="mb-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setParams({ q: search.trim() });
          }}
        >
          <div className="flex w-full min-w-0 flex-col gap-1 lg:w-auto lg:flex-1">
            <Label htmlFor="stores-q" className="text-xs text-muted-foreground">
              Search
            </Label>
            <div className="flex gap-2">
              <Input id="stores-q" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, id, domain or owner email" className="h-8" />
              <Button type="submit" variant="outline" size="sm">
                <Search aria-hidden /> Search
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="stores-status" className="text-xs text-muted-foreground">
              Status
            </Label>
            <select id="stores-status" className={selectClass} value={sp.get("status") || ""} onChange={(e) => setParams({ status: e.target.value })}>
              {STATUS_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="stores-plan" className="text-xs text-muted-foreground">
              Plan
            </Label>
            <select id="stores-plan" className={selectClass} value={sp.get("plan") || ""} onChange={(e) => setParams({ plan: e.target.value })}>
              <option value="">Any plan</option>
              {(data?.plans || []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="none">No plan</option>
            </select>
          </div>
          <label className="flex h-8 items-center gap-2 text-sm whitespace-nowrap">
            <input type="checkbox" id="stores-attention" className="size-4 rounded-sm accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none" checked={sp.get("attention") === "1"} onChange={(e) => setParams({ attention: e.target.checked ? "1" : null })} />
            Needs attention{data ? ` (${data.counts.attention})` : ""}
          </label>
        </form>

        {state.error && (
          <Alert variant="destructive" className="mb-3" role="alert">
            <AlertTitle>{state.error}</AlertTitle>
            <AlertDescription>
              <Button type="button" variant="outline" size="sm" data-read-control onClick={load}>
                <RefreshCw aria-hidden /> Try again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {!(state.error && !data) && (
          <DataTable
            label="Stores"
            columns={columns}
            rows={stores}
            loading={state.loading && !data}
            rowHref={(r) => `/platform/stores/${encodeURIComponent(r.id)}`}
            sort={{ key: sort, dir }}
            onSort={(key) => setParams({ sort: key, dir: key === sort ? (dir === "asc" ? "desc" : "asc") : key === "name" ? "asc" : "desc" })}
            footer={data && { offset: data.offset, total: data.total, onPrevious: () => setParams({ offset: Math.max(0, data.offset - data.pageSize) || null }), onNext: () => setParams({ offset: data.offset + data.pageSize }) }}
            empty={
              fleetEmpty ? (
                <EmptyState icon={Store} title="No stores yet" description="Create the first store for a founder to get started." action={newStore} />
              ) : (
                <EmptyState
                  icon={Search}
                  title={q ? `No store matches “${q}”` : "No store matches these filters"}
                  description={q.includes("@") ? "Owner emails match exactly. Check the whole address." : null}
                  action={
                    filtered && (
                      <Button variant="outline" size="sm" data-read-control onClick={() => router.replace(pathname, { scroll: false })}>
                        Clear filters
                      </Button>
                    )
                  }
                />
              )
            }
          />
        )}
      </div>
    </TooltipProvider>
  );
}
