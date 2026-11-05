"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { SyncProgressBody, readSync, requestSync, POLL_MS } from "@/components/admin/SyncProgress";
import { paletteById } from "@/lib/themes/palettes";
import BrandStep from "./BrandStep";

// P6-START-UI (GEN-01, US-01, US-04): "Start your store" (/admin/start), the
// console's first-run page. It reads GET /api/admin/first-run (what was made,
// whether it can be made now, and the catalog sync's progress) and, when the
// store can be made and isn't yet, asks POST /api/admin/first-run ONCE. The
// brand step (BrandStep.js) sits under it, at #brand.
//
// Which view shows (first match wins):
//   1. a home page the generator made        "ready": what was made (from the
//                                            server's summary), what was kept,
//                                            where to change each part. A
//                                            later sync that runs or failed
//                                            shows as a small note under it.
//   2. a home page the founder started       "kept": we kept it, with links
//   3. the catalog isn't in yet, or its      "syncing" / "sync-failed": the
//      sync failed                           sync's own progress and retry
//   4. it can be made and isn't yet          "making", then "ready"; a failed
//                                            POST: "make-failed" with a retry
//   otherwise                                "blocked": the reason in words
// The sync's progress is SyncProgress's own (SyncProgressBody, readSync,
// requestSync), never a second progress UI. Someone who can't edit
// (canEdit false) never POSTs: they read the page.
// Founder words only: never a command, a status code or a raw error.

export const FIRST_RUN_URL = "/api/admin/first-run";
// The editor at the home page: where the founder edits it, and where the
// editor's Publish is (lib/admin/editor-entry.js EDITOR_PUBLISH_HREF).
export const EDIT_HOME_HREF = "/admin/editor?doc=doc_home";
export const BRAND_ANCHOR = "#brand";

const LIVE = new Set(["running", "retrying"]);
const BROKEN = new Set(["failed", "stalled"]);
const HOME = "doc_home";
const DESIGN = "doc_design";

export const START_WORDS = Object.freeze({
  loading: "Loading your store…",
  loadFailed: "We couldn't load your starting store just now. Reload the page to try again.",
  making: "Making your starting store from your products…",
  makeFailed: "We couldn't make your starting store. Try again.",
  tryAgain: "Try again",
  readyTitle: "Your starting store is ready",
  readyNoSummary: "Your home page is ready in the editor.",
  keptTitle: "Your home page",
  keptHome: "We kept the home page you already started.",
  keptDesign: "We kept the colours you already chose.",
  closed: "Nothing is public yet.",
  open: "Your store is open. Changes you make show to shoppers after you publish.",
  editHome: "Edit the home page",
  changeBrand: "Change colours and logo",
  empty: "Your Shopify store has no products yet. Add products in Shopify, then sync again.",
  emptyRefill: "If you haven't changed your home page, product rows appear after your next sync. Otherwise add them in the editor.",
  noCollections:
    "Your products have no collections in Shopify yet, so your home page shows your newest products. Add collections in Shopify to get collection rows.",
  syncTitle: "Your products from Shopify",
  syncWaiting: "Your starting store is made as soon as your products are in.",
  syncNote: "Your products are being brought in again",
  blockedTitle: "Your starting store",
});

// The reasons nothing was made (lib/first-run/generate.js FIRST_RUN_WORDS,
// which is Node only), for the views that show one.
export const REASON_WORDS = Object.freeze({
  cannot_edit: "Only someone who can edit this store can make its starting pages.",
  migrating: "Your store is being updated. Try again in a few minutes.",
  live: "Your store is already open, so the starting store wasn't made again. Your live store hasn't changed.",
  race: "Your store changed while the starting store was being made, so nothing was saved. Try again.",
  home_left_for_founder: "Your home page is open in the editor, so it was left for you.",
  legacy: "This store still uses the current Storefront editor, so no starting store was made here.",
});

async function call(method, url, body) {
  const init = { method, headers: { Accept: "application/json" }, cache: "no-store" };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body: data && typeof data === "object" ? data : {} };
  } catch {
    return { status: 0, ok: false, body: {} };
  }
}

const list = (items) => {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs.join("");
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
};
const series = (items) => {
  const xs = items.filter(Boolean);
  if (xs.length <= 2) return list(xs);
  return `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`;
};

// What was made, in one sentence, from the server's summary
// ({ heroImage: { productTitle } | null, collections, rails, paletteId }).
// Nothing in it is fixed text about the catalog: every name comes from the
// summary. null when there is no summary (the home isn't the generator's).
export function madeSentence(summary, { empty = false } = {}) {
  if (!summary || typeof summary !== "object") return null;
  const parts = ["your store name"];
  const photo = summary.heroImage?.productTitle;
  if (photo) parts.push(`a photo of ${photo}`);
  const rails = Array.isArray(summary.rails) ? summary.rails.filter((x) => typeof x === "string" && x.trim()) : [];
  if (rails.length) parts.push(`${rails.length === 1 ? "a row" : "rows"} for ${list(rails)}`);
  if (Array.isArray(summary.collections) && summary.collections.length) parts.push("a grid of your collections");
  if (!empty) parts.push("a row of your newest products");
  const palette = paletteById(summary.paletteId);
  if (palette) parts.push(`the ${palette.label} colours`);
  return `A home page with ${series(parts)}.`;
}

// The view for what the server said (first match wins; see the top).
export function viewOf(firstRun, sync) {
  if (!firstRun) return "loading";
  const kept = Array.isArray(firstRun.kept) ? firstRun.kept : [];
  const mine = Array.isArray(firstRun.byGenerator) ? firstRun.byGenerator : [];
  if (firstRun.generated) {
    if (mine.includes(HOME) || firstRun.summary) return "ready";
    if (kept.includes(HOME)) return "kept";
    if (firstRun.eligible) return "make"; // an untouched, empty home page: filled from the catalog
    return "ready";
  }
  if (firstRun.reason === "founder_started") return "kept";
  // an open store already has its home page: describeFirstStore stops at the
  // live check before reading rows, so generated is false here. Never the
  // "made as soon as your products are in" view, even while a later sync runs
  // or after it failed (the blocked view keeps a small sync note).
  if (firstRun.reason === "live") return "blocked";
  const state = sync?.state;
  if (firstRun.reason === "catalog_not_confirmed" || LIVE.has(state) || BROKEN.has(state)) return BROKEN.has(state) ? "sync-failed" : "syncing";
  if (firstRun.eligible) return "make";
  return "blocked";
}

// The description after a POST that ran: the store now has its home page.
export function afterMake(prev, r) {
  const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
  const kept = skipped.filter((s) => s?.reason === "founder").map((s) => s.id);
  const byGenerator = [...(r?.created || []), ...(r?.refilled || []), ...(r?.unchanged || [])];
  return {
    ...(prev || {}),
    eligible: false,
    reason: null,
    generated: true,
    byGenerator,
    kept,
    summary: kept.includes(HOME) ? null : r?.summary ?? null,
    empty: prev?.empty ?? r?.products === 0,
  };
}

// SyncProgress's own body, polled with its own readSync, so this page knows
// when the products are in (and then reads the first run again).
function SyncPanel({ initial, canRun, showStart = false, onSettled, pollMs }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const was = useRef(initial?.state);

  useEffect(() => {
    if (view && view.state !== was.current) {
      const before = was.current;
      was.current = view.state;
      if (LIVE.has(before) && !LIVE.has(view.state)) onSettled?.(view);
    }
    if (!view || !LIVE.has(view.state)) return undefined;
    const timer = setTimeout(async () => {
      const next = await readSync().catch(() => null);
      if (next) setView(next);
      else setView((v) => ({ ...v }));
    }, pollMs);
    return () => clearTimeout(timer);
  }, [view]);

  async function act(body) {
    setBusy(true);
    setError(null);
    const res = await requestSync(body);
    if (res.ok && res.sync) setView(res.sync);
    else if (!res.ok) setError(res.error);
    setBusy(false);
  }

  if (!view) return null;
  return <SyncProgressBody view={view} busy={busy} error={error} canRun={canRun} showStart={showStart} onRetry={() => act({ retry: true })} onStart={() => act({})} />;
}

function NextLinks() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      <Link href={EDIT_HOME_HREF} className="font-medium text-primary underline underline-offset-2">
        {START_WORDS.editHome}
      </Link>
      <a href={BRAND_ANCHOR} className="font-medium text-primary underline underline-offset-2">
        {START_WORDS.changeBrand}
      </a>
    </div>
  );
}

function OpenNote({ open }) {
  return <p className="text-sm text-fg-muted">{open ? START_WORDS.open : START_WORDS.closed}</p>;
}

function CatalogNotes({ firstRun, sync, canSync, onSettled, pollMs }) {
  if (firstRun.empty) {
    return (
      <div className="space-y-2 rounded-ctl border border-edge bg-surface-sunken p-3" data-first-run-note="empty">
        <p className="text-sm text-fg">{START_WORDS.empty}</p>
        <p className="text-xs text-fg-muted">{START_WORDS.emptyRefill}</p>
        {sync && <SyncPanel initial={sync} canRun={canSync} showStart onSettled={onSettled} pollMs={pollMs} />}
      </div>
    );
  }
  if (firstRun.noCollections) {
    return (
      <div className="rounded-ctl border border-edge bg-surface-sunken p-3" data-first-run-note="no-collections">
        <p className="text-sm text-fg">{START_WORDS.noCollections}</p>
      </div>
    );
  }
  return null;
}

export default function FirstRun({ canEdit = false, canSync = false, pollMs = POLL_MS }) {
  const [data, setData] = useState(null); // { firstRun, sync }
  const [phase, setPhase] = useState("loading"); // loading | idle | load-failed | making | make-failed
  const [error, setError] = useState(null);
  const posted = useRef(false);

  async function load() {
    const r = await call("GET", FIRST_RUN_URL);
    if (r.ok && r.body.ok && r.body.firstRun) {
      setData({ firstRun: r.body.firstRun, sync: r.body.sync ?? null });
      setPhase("idle");
    } else {
      setError(START_WORDS.loadFailed);
      setPhase("load-failed");
    }
  }

  async function make() {
    posted.current = true;
    setError(null);
    setPhase("making");
    const r = await call("POST", FIRST_RUN_URL, {});
    if (r.ok && r.body.ok && r.body.ran) {
      setData((d) => ({ ...d, firstRun: afterMake(d?.firstRun, r.body) }));
      setPhase("idle");
      return;
    }
    if (r.ok && r.body.ok && r.body.ran === false && r.body.reason !== "race") {
      // the store changed since the page read it (the founder started a home
      // page, a sync started, the store opened): read it again, never POST again
      await load();
      return;
    }
    if (r.status === 403 && r.body.reason === "cannot_edit") {
      setData((d) => ({ ...d, firstRun: { ...(d?.firstRun || {}), eligible: false, reason: "cannot_edit" } }));
      setPhase("idle");
      return;
    }
    setError(START_WORDS.makeFailed);
    setPhase("make-failed");
  }

  useEffect(() => {
    load();
  }, []);

  const view = phase === "idle" ? viewOf(data?.firstRun, data?.sync) : null;
  useEffect(() => {
    if (view === "make" && canEdit && !posted.current) make();
  }, [view]);

  const firstRun = data?.firstRun || {};
  const sync = data?.sync || null;
  const open = firstRun.reason === "live";
  const reload = () => load();

  // what shows: the phase while a request is out or failed, else the view.
  // "make" is the POST about to go (making); once it went, the same answer
  // again (a re-read that still says "can be made") shows the retry instead
  // of posting by itself a second time.
  let state = phase;
  if (phase === "idle") {
    state = view;
    if (view === "make") state = !canEdit ? "blocked" : posted.current ? "make-failed" : "making";
  }
  let body;
  if (state === "loading" || state === "making") {
    body = (
      <p className="text-sm text-fg-muted" aria-live="polite">
        {state === "making" ? START_WORDS.making : START_WORDS.loading}
      </p>
    );
  } else if (state === "load-failed") {
    body = (
      <Banner tone="danger">
        <p>{error}</p>
      </Banner>
    );
  } else if (state === "make-failed") {
    body = (
      <div className="space-y-3">
        <Banner tone="danger">
          <p>{error || START_WORDS.makeFailed}</p>
        </Banner>
        {canEdit && (
          <Button variant="primary" icon={<RotateCcw size={14} aria-hidden />} onClick={() => make()}>
            {START_WORDS.tryAgain}
          </Button>
        )}
      </div>
    );
  } else {
    if (state === "ready") {
      const sentence = madeSentence(firstRun.summary, { empty: firstRun.empty });
      const kept = Array.isArray(firstRun.kept) ? firstRun.kept : [];
      const syncNote = sync && (LIVE.has(sync.state) || BROKEN.has(sync.state));
      body = (
        <div className="space-y-3">
          <p className="text-sm text-fg">{sentence || START_WORDS.readyNoSummary}</p>
          {kept.includes(DESIGN) && <p className="text-sm text-fg">{START_WORDS.keptDesign}</p>}
          <OpenNote open={open} />
          <NextLinks />
          <CatalogNotes firstRun={firstRun} sync={sync} canSync={canSync} onSettled={reload} pollMs={pollMs} />
          {syncNote && !firstRun.empty && (
            <div className="space-y-2 border-t border-edge pt-3" data-first-run-note="sync">
              <p className="text-xs font-medium text-fg-muted">{START_WORDS.syncNote}</p>
              <SyncPanel initial={sync} canRun={canSync} onSettled={reload} pollMs={pollMs} />
            </div>
          )}
        </div>
      );
    } else if (state === "kept") {
      body = (
        <div className="space-y-3">
          <p className="text-sm text-fg">{START_WORDS.keptHome}</p>
          <OpenNote open={open} />
          <NextLinks />
        </div>
      );
    } else if (state === "syncing" || state === "sync-failed") {
      body = (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">{START_WORDS.syncWaiting}</p>
          {sync && <SyncPanel initial={sync} canRun={canSync} onSettled={reload} pollMs={pollMs} />}
        </div>
      );
    } else {
      body = (
        <div className="space-y-3">
          <p className="text-sm text-fg">{REASON_WORDS[firstRun.reason] || REASON_WORDS.cannot_edit}</p>
          {firstRun.reason !== "cannot_edit" && <NextLinks />}
          {open && sync && (LIVE.has(sync.state) || BROKEN.has(sync.state)) && (
            <div className="space-y-2 border-t border-edge pt-3" data-first-run-note="sync">
              <p className="text-xs font-medium text-fg-muted">{START_WORDS.syncNote}</p>
              <SyncPanel initial={sync} canRun={canSync} onSettled={reload} pollMs={pollMs} />
            </div>
          )}
        </div>
      );
    }
  }

  const title = state === "ready" ? (firstRun.summary ? START_WORDS.readyTitle : START_WORDS.keptTitle) : state === "kept" ? START_WORDS.keptTitle : state === "syncing" || state === "sync-failed" ? START_WORDS.syncTitle : START_WORDS.blockedTitle;
  return (
    <div className="space-y-6">
      <Card>
        <div data-first-run={state}>
          <CardHeader title={title} />
          {body}
        </div>
      </Card>
      <BrandStep canEdit={canEdit} />
    </div>
  );
}
