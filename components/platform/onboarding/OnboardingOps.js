"use client";

// Phase 1 line 8: the operator's "Signups & onboarding" screen. Views, the
// stuck filter, search and sort live in the URL (?view=&stuck=&q=&sort=&s=),
// so a link opens the same list and the same detail sheet. 50 rows a page,
// with keyset cursors (Next / Previous keep a stack of the cursors seen).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import OnboardingTable from "./OnboardingTable";
import SubjectSheet from "./SubjectSheet";
import { VIEW_LABELS } from "./onboardingWords";

const VIEWS = ["attention", "signup", "closed", "open", "lapsed", "all"];
const STUCK = [1, 6, 24, 72];
const selectClass =
  "h-8 rounded-md border border-input bg-muted px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export default function OnboardingOps() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const view = VIEWS.includes(sp.get("view")) ? sp.get("view") : "attention";
  const stuck = STUCK.includes(Number(sp.get("stuck"))) ? Number(sp.get("stuck")) : 24;
  const sort = sp.get("sort") === "newest" ? "newest" : "stuck";
  const q = sp.get("q") || "";
  const subject = sp.get("s") || null;

  const [cursors, setCursors] = useState([null]); // the cursor of each page seen
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [search, setSearch] = useState(q);
  const seq = useRef(0);
  const tabs = useRef([]);
  const cursor = cursors[cursors.length - 1];

  const setParams = useCallback(
    (patch) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, String(v));
      }
      // a new filter starts again at page one (opening a row keeps the page)
      if (Object.keys(patch).some((k) => k !== "s")) setCursors([null]);
      router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
    },
    [sp, router, pathname],
  );

  const load = useCallback(async () => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    const qs = new URLSearchParams({ view, stuck: String(stuck), sort, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) });
    try {
      const res = await fetch(`/api/platform/onboarding?${qs}`, { cache: "no-store" });
      if (res.status === 401) {
        window.location.assign("/platform");
        return;
      }
      const body = await res.json().catch(() => null);
      if (id !== seq.current) return;
      if (!res.ok || !body?.ok) throw new Error(body?.error || "We couldn't load signups and stores just now.");
      setState({ loading: false, error: null, data: body });
    } catch (e) {
      if (id === seq.current) setState((s) => ({ loading: false, error: String(e?.message || e), data: s.data }));
    }
  }, [view, stuck, sort, q, cursor]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => setSearch(q), [q]);

  const counts = state.data?.counts || {};
  const rows = state.data?.rows || [];
  const page = cursors.length;
  const emptyWords = useMemo(() => {
    if (q) return `Nothing matches “${q}” in ${VIEW_LABELS[view].toLowerCase()}.`;
    if (view === "attention") return "No stores need attention.";
    return `Nothing in ${VIEW_LABELS[view].toLowerCase()} yet.`;
  }, [q, view]);

  return (
    <TooltipProvider>
      <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6">
        <a href="/platform" className="inline-flex items-center gap-1 rounded-md text-[0.8125rem] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <ArrowLeft className="size-3.5" aria-hidden /> Platform operations
        </a>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[1.375rem] font-semibold">Signups &amp; onboarding</h1>
            <p className="mt-1 text-sm text-muted-foreground">Every signup and every store&apos;s onboarding step. Open a row to help.</p>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={state.loading}>
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        </div>

        {/* views: Tab lands on the chosen one, arrow keys, Home and End move between them */}
        <div
          role="tablist"
          aria-label="Views"
          className="mt-6 flex flex-wrap gap-1 border-b border-border pb-2"
          onKeyDown={(e) => {
            const i = VIEWS.indexOf(view);
            const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: VIEWS.length - 1 }[e.key];
            if (to == null) return;
            e.preventDefault();
            const v = VIEWS[(to + VIEWS.length) % VIEWS.length];
            setParams({ view: v === "attention" ? null : v });
            tabs.current[VIEWS.indexOf(v)]?.focus();
          }}
        >
          {VIEWS.map((v, i) => {
            const on = v === view;
            const n = counts[v] ?? 0;
            return (
              <button
                key={v}
                ref={(el) => (tabs.current[i] = el)}
                role="tab"
                type="button"
                aria-selected={on}
                aria-controls="onb-list"
                tabIndex={on ? 0 : -1}
                onClick={() => setParams({ view: v === "attention" ? null : v })}
                className={`inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors outline-none motion-reduce:transition-none pointer-coarse:h-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
              >
                {VIEW_LABELS[v]}
                <span
                  className={`min-w-6 rounded-full px-1.5 text-center font-mono text-xs leading-5 tabular-nums ${on ? "bg-primary-foreground/15" : v === "attention" && n > 0 ? "bg-warning/15 text-warning-text" : "bg-muted"}`}
                >
                  {state.data ? n : "–"}
                  <span className="sr-only">{n === 1 ? " row" : " rows"}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <form
            role="search"
            className="flex min-w-60 flex-1 items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setParams({ q: search.trim() || null });
            }}
          >
            <div className="flex-1">
              <Label htmlFor="onb-search" className="mb-1.5 text-[0.8125rem]">
                Search
              </Label>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="onb-search"
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && search) {
                      e.preventDefault();
                      setSearch("");
                      if (q) setParams({ q: null });
                    }
                  }}
                  placeholder="Email (exact), store name, address or founder"
                  className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
                />
                {(search || q) && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearch("");
                      if (q) setParams({ q: null });
                    }}
                    className="absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                )}
              </div>
            </div>
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          {view === "attention" && (
            <div>
              <Label htmlFor="onb-stuck" className="mb-1.5 text-[0.8125rem]">
                Stuck more than
              </Label>
              <select id="onb-stuck" className={selectClass} value={stuck} onChange={(e) => setParams({ stuck: e.target.value === "24" ? null : e.target.value })}>
                {STUCK.map((h) => (
                  <option key={h} value={h}>
                    {h} {h === 1 ? "hour" : "hours"}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <Label htmlFor="onb-sort" className="mb-1.5 text-[0.8125rem]">
              Sort
            </Label>
            <select id="onb-sort" className={selectClass} value={sort} onChange={(e) => setParams({ sort: e.target.value === "stuck" ? null : e.target.value })}>
              <option value="stuck">Stuck longest</option>
              <option value="newest">Newest</option>
            </select>
          </div>
        </div>

        <div className="mt-4" id="onb-list" role="tabpanel" aria-label={VIEW_LABELS[view]}>
          {state.error && (
            <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span>{state.error}</span>
              <Button size="sm" variant="outline" onClick={load}>
                Try again
              </Button>
            </div>
          )}
          {state.loading && !state.data ? (
            <div className="overflow-hidden rounded-card border border-border bg-card shadow-card" aria-busy="true" aria-label="Loading rows">
              <div className="h-10 bg-muted" />
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="flex h-10 items-center gap-4 border-b border-border px-3 last:border-0">
                  <Skeleton className="h-3.5 w-[20%]" />
                  <Skeleton className="h-3.5 w-[16%]" />
                  <Skeleton className="h-5 w-24 rounded-full" />
                  <Skeleton className="h-3.5 w-[22%]" />
                  <Skeleton className="ml-auto h-3.5 w-12" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 && !state.error ? (
            <div className="rounded-card border border-border bg-card px-6 py-12 text-center shadow-card" data-empty>
              <p className="text-base font-medium">{emptyWords}</p>
              <p className="mt-1 text-sm text-muted-foreground">{view === "attention" && !q ? "Every signup and store is moving on its own. New trouble shows up here." : "Try another view or a different search."}</p>
              {(q || view !== "all") && (
                <Button className="mt-3" variant="outline" size="sm" onClick={() => setParams({ q: null, view: "all" })}>
                  Show all signups and stores
                </Button>
              )}
            </div>
          ) : (
            <OnboardingTable rows={rows} busy={state.loading} onOpen={(s) => setParams({ s })} selected={subject} />
          )}
          {rows.length > 0 && (
            <nav aria-label="Pages" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[0.8125rem] text-muted-foreground">
              <span className="tabular-nums">
                {q ? `${rows.length} ${rows.length === 1 ? "match" : "matches"} on this page` : `Rows ${(page - 1) * 50 + 1}–${(page - 1) * 50 + rows.length} of ${counts[view] ?? rows.length}`}
              </span>
              {(page > 1 || state.data?.next) && (
              <div className="flex items-center gap-2">
              <span>Page {page}</span>
              <Button size="sm" variant="outline" disabled={page <= 1 || state.loading} onClick={() => setCursors((c) => c.slice(0, -1))}>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled={!state.data?.next || state.loading} onClick={() => setCursors((c) => [...c, state.data.next])}>
                Next
              </Button>
              </div>
              )}
            </nav>
          )}
        </div>
      </div>
      <SubjectSheet subject={subject} onClose={() => setParams({ s: null })} onChanged={load} />
    </TooltipProvider>
  );
}
