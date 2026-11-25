"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { createDocumentStore } from "../editor/store";
import StatusLine from "../editor/StatusLine";
import { BrandColourInput, BrandStepSelect } from "../editor/fields/DesignForm";
import { BRAND_FIELDS, design } from "../editor/fields/inspectorModel";
import * as T from "./tokensModel";

// Phase 6 line 2 (docs/plans/phase-6.md "Line 2"): the studio's Design tab.
// The founder's colours, type and spacing (doc_design settings.brand, only
// the values validateBrand takes), with the editor's own colour and step
// controls (DesignForm's BrandColourInput / BrandStepSelect).
//
// One doc_design store at a time. The session (one per studio model, in
// `sessions`, so a switch to the Sections tab keeps a pending save) waits
// until the studio has a store, then (syncDesign, on every change of
// studio.store):
//   - the studio's own document is doc_design: that store is shared (an own
//     store is flushed and disposed first)
//   - otherwise an own store (getDocument doc_design); a shared store the
//     studio replaced (and disposed) is dropped and never edited again
// Every change posts storeasy:tokens to the frame on the same tick (before
// the save), records an undo step on the studio's model and touches
// doc_design (showDesign on; Publish pre-ticks it: designStoreFor()). Undo
// and redo of doc_design steps are this store's alone (model.onStep, and
// Studio.js skips them): only the keys a step changed are written back
// (tokensModel stepOps), never a whole-body snapshot. Every frame load
// (the bridge's v2 storeasy:ready) gets the current tokens again, so a reload
// before the design save lands still draws them. The own store's save state
// and its 409 (Load theirs / Keep mine) show in the rail (StatusLine).
// When the studio closes (model.close()) the listeners go and an own store is
// flushed, then disposed.
//
// Readability: checkBrand with the draft's kit, an uploaded theme's surfaces
// and the live brand, each failing pair in plain words with a "Use <colour>"
// button (suggestFix); an error is a publish blocker (the server refuses it
// too). Reset: an uploaded theme's tokens (GET /api/admin/themes/[id]
// `tokens`), else the store's starting brand (startingBrand).
// Support and operator support (no storefront.write): every input disabled,
// no Reset, no fix buttons, and the store is read-only.
const sessions = new WeakMap();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const getJson = (url) =>
  fetch(url, { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

// the brand to post for a body: its tokens, or the platform default (null)
const postFor = (body) => T.tokensMessage(T.brandOf(body) ?? {});
const hasWindow = () => typeof window !== "undefined" && typeof window.addEventListener === "function";

export function sessionFor(studio, { fetchJson = getJson } = {}) {
  const model = studio?.model;
  if (!model) return null;
  let s = sessions.get(model);
  if (!s) {
    const listeners = new Set();
    s = { model, store: null, shared: false, status: "idle", look: null, lookFor: undefined, seq: 0, armed: false, studioStore: null, studio, fetchJson };
    s.emit = () => {
      s.snap = null;
      for (const fn of [...listeners]) fn();
    };
    s.subscribe = (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    };
    s.getSnapshot = () => (s.snap ??= { status: s.status, look: s.look, store: s.store, shared: s.shared });
    // the store may be edited: a shared one only while it is still the studio's
    s.usable = () => Boolean(s.store) && !s.store.readOnly && (!s.shared || s.store === s.studioStore);
    s.repost = () => {
      if (!s.store || !model.isTouched(T.DESIGN_DOC)) return false;
      const msg = postFor(s.store.getState().body);
      return msg ? Boolean(s.studio?.post?.(msg)) : false;
    };
    sessions.set(model, s);
  }
  s.studio = studio;
  s.studioStore = studio.store ?? null;
  return s;
}

// a message from the preview frame: a v2 ready (every load) gets the tokens again
export function frameMessage(s, data) {
  if (!s || !isObj(data) || data.type !== "storeasy:ready" || data.v !== 2 || data.ok !== true) return false;
  return s.repost();
}

function arm(s) {
  if (s.armed) return;
  s.armed = true;
  s.offStep = s.model.onStep(T.DESIGN_DOC, (step, dir) => {
    if (!s.usable()) return;
    for (const o of T.stepOps(step, dir)) s.store.setField(o.path, o.value);
    s.repost();
  });
  s.offClose = s.model.onClose(() => closeSession(s));
  if (hasWindow()) {
    s.onMessage = (e) => e.origin === window.location.origin && frameMessage(s, e.data);
    s.onUnload = (e) => {
      if (!s.shared && s.store?.beforeUnload()) e.preventDefault();
    };
    window.addEventListener("message", s.onMessage);
    window.addEventListener("beforeunload", s.onUnload);
  }
}

function dropOwn(s) {
  const own = s.shared ? null : s.store;
  s.store = null;
  if (!own) return;
  Promise.resolve(own.readOnly ? null : own.flush())
    .catch(() => null)
    .finally(() => own.dispose());
}

export function closeSession(s) {
  if (!s) return;
  s.offStep?.();
  s.offClose?.();
  if (hasWindow() && s.onMessage) {
    window.removeEventListener("message", s.onMessage);
    window.removeEventListener("beforeunload", s.onUnload);
  }
  s.armed = false;
  s.seq++;
  dropOwn(s);
  s.shared = false;
  s.status = "idle";
  s.emit();
}

async function loadLook(s) {
  const theme = T.themeOf(s.store?.getState().body);
  const id = T.packageIdOf(theme);
  if (s.lookFor === (id ?? null) && s.look) return;
  s.lookFor = id ?? null;
  const [themes, pkg] = await Promise.all([s.fetchJson("/api/admin/themes"), id ? s.fetchJson(`/api/admin/themes/${encodeURIComponent(id)}`) : null]);
  s.look = {
    live: isObj(themes?.state?.liveBrand) ? themes.state.liveBrand : null,
    liveTheme: isObj(themes?.state?.liveTheme) ? themes.state.liveTheme : null,
    packageId: id,
    name: pkg?.package?.name ?? null,
    version: pkg?.package?.version ?? null,
    surfaces: isObj(pkg?.content?.surfaces) ? pkg.content.surfaces : null,
    tokens: isObj(pkg?.tokens) ? pkg.tokens : null,
  };
  s.emit();
}

// Choose the one doc_design store for the studio as it is now. Returns a
// promise for an own store's opening (tests await it), else undefined.
export function syncDesign(s, studio) {
  if (!s || !studio?.store) return undefined; // the studio hasn't loaded: wait
  arm(s);
  const studioStore = studio.store;
  if (studio.state?.id === T.DESIGN_DOC || studioStore.getState?.().id === T.DESIGN_DOC) {
    if (s.store === studioStore) return undefined;
    s.seq++; // an own store still opening is not used
    dropOwn(s);
    s.store = studioStore;
    s.shared = true;
    s.status = "ready";
    s.emit();
    loadLook(s);
    return undefined;
  }
  if (s.shared) {
    // the studio moved to another document and disposed that store
    s.store = null;
    s.shared = false;
    s.status = "idle";
  }
  if (s.store || s.status === "loading") return undefined;
  return openOwn(s, studio);
}

async function openOwn(s, studio) {
  const mine = ++s.seq;
  s.status = "loading";
  s.emit();
  const { api, readOnly } = studio;
  let r = await api.call("getDocument", T.DESIGN_DOC);
  if (r?.code === "NOT_FOUND" && !readOnly) {
    const made = await api.call("createDocument", { type: "design", body: null });
    r = made?.ok ? await api.call("getDocument", T.DESIGN_DOC) : made;
  }
  if (mine !== s.seq) return;
  if (!(r?.ok && isObj(r.data?.document))) {
    s.status = r?.code === "NOT_FOUND" ? "missing" : "failed";
    s.emit();
    return;
  }
  const store = createDocumentStore({ api, document: r.data.document, tenant: hasWindow() ? window.location.host : "", storage: null, readOnly });
  await store.open();
  if (mine !== s.seq) {
    store.dispose();
    return;
  }
  s.store = store;
  s.shared = false;
  s.status = "ready";
  s.emit();
  await loadLook(s);
}

// The doc_design store this studio session uses (line 1's Publish flushes it).
export const designStoreFor = (studio) => (studio?.model ? sessions.get(studio.model)?.store ?? null : null);

// One token change on the session's store: post first (same tick), then the
// draft save, then the undo step. False when nothing was written.
export function writeBrand(s, next) {
  if (!s?.usable() || designReadOnly(s.studio, s.store)) return false;
  const msg = T.tokensMessage(next);
  if (msg) s.studio.post(msg);
  const before = s.store.getState().body;
  s.store.setField("settings.brand", next);
  s.model.record({ docId: T.DESIGN_DOC, before, after: s.store.getState().body });
  return true;
}

const noSub = () => () => {};
const noState = () => null;

export default function DesignRail({ studio }) {
  const s = sessionFor(studio);
  const snap = useSyncExternalStore(s ? s.subscribe : noSub, s ? s.getSnapshot : noState, s ? s.getSnapshot : noState);
  const store = snap?.store ?? null;
  const state = useSyncExternalStore(store ? store.subscribe : noSub, store ? store.getState : noState, store ? store.getState : noState);
  const [typing, setTyping] = useState({});
  useEffect(() => {
    syncDesign(s, studio);
  }, [s, studio?.store, studio?.state?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = designReadOnly(studio, store);
  const startingBrand = studio?.startingBrand ?? null;
  const brand = T.brandOf(state?.body);
  const write = (next) => writeBrand(s, next);
  const setToken = (key, value) => {
    const f = BRAND_FIELDS.find((b) => b.key === key);
    if (f?.kind === "colour" && !design.colourOk(value)) {
      setTyping((t) => ({ ...t, [key]: value })); // half typed: shown, not saved or posted
      return;
    }
    setTyping((t) => {
      const { [key]: _drop, ...rest } = t;
      return rest;
    });
    write(T.setToken(brand, key, value, startingBrand));
  };
  // the shared store's save state is the top bar's; an own store's shows here
  const saveLine =
    store && !snap?.shared ? (
      <StatusLine save={state} readOnly={readOnly} role={studio?.role ?? null} on={{ useNewer: () => store.useNewer(), keepMine: () => store.keepMine(), retry: () => store.retry(), acceptBackup: () => store.acceptBackup(), dismissBackup: () => store.dismissBackup() }} />
    ) : null;
  return <DesignRailView status={snap?.status || "idle"} state={state} look={snap?.look ?? null} readOnly={readOnly} startingBrand={startingBrand} typing={typing} onToken={setToken} onWrite={write} saveLine={saveLine} />;
}

// no storefront.write (support, operator support), or a read-only store
export const designReadOnly = (studio, store = null) => studio?.readOnly !== false || studio?.can?.write !== true || store?.readOnly === true;

// The tab itself, all props (test-studio-tokens renders it on its own).
export function DesignRailView({ status = "idle", state = null, look = null, readOnly = true, startingBrand = null, typing = {}, onToken = () => {}, onWrite = () => {}, saveLine = null }) {
  if (status !== "ready" || !state) {
    return (
      <div className="space-y-3" data-studio-design="" data-design-load={status}>
        <p className="text-sm text-muted-foreground">{status === "failed" || status === "missing" ? T.DESIGN_WORDS.failed : T.DESIGN_WORDS.loading}</p>
      </div>
    );
  }
  const body = state.body;
  const brand = T.brandOf(body);
  const theme = T.themeOf(body);
  const values = design.brandView(brand).values;
  const shown = { ...values, ...typing };
  const target = T.resetTarget({ theme, packageTokens: look?.tokens ?? null, startingBrand });
  const check = T.readability(brand, { theme, surfaces: look?.surfaces ?? null, live: look?.live ?? null, liveTheme: look?.liveTheme ?? null });
  const isPackage = Boolean(T.packageIdOf(theme));
  const issues = state.pending?.issues || state.issues || [];
  const setToken = onToken;
  const write = onWrite;
  const field = (key) => BRAND_FIELDS.find((b) => b.key === key);
  const idFor = (key) => `studio-design-${key}`;

  return (
    <div className="space-y-4" data-studio-design="" data-design-readonly={readOnly ? "" : undefined}>
      <p className="text-sm text-muted-foreground">{T.DESIGN_WORDS.intro}</p>
      <p className="text-xs text-muted-foreground" data-design-theme={isPackage ? look?.packageId || "" : "builtin"}>
        {isPackage ? T.themeWords(look?.name ?? "your uploaded theme", look?.version ?? null) : T.DESIGN_WORDS.builtIn}
      </p>
      {readOnly && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{T.DESIGN_WORDS.readOnly}</p>}
      {saveLine && <div data-design-save="">{saveLine}</div>}

      {T.TOKEN_GROUPS.map((g) => (
        <section key={g.id} aria-labelledby={`studio-design-${g.id}`} className="space-y-3" data-design-group={g.id}>
          <h3 id={`studio-design-${g.id}`} className="text-xs font-semibold text-foreground">
            {g.words}
          </h3>
          {g.keys.map((k) => {
            const f = field(k);
            return f.kind === "colour" ? (
              <BrandColourInput key={k} token={f} anchor={idFor(k)} value={shown[k]} issues={issues} readOnly={readOnly} placeholder={String(target.accent ?? values.accent)} onValue={(v) => setToken(k, v)} />
            ) : (
              <BrandStepSelect key={k} token={f} anchor={idFor(k)} value={shown[k]} issues={issues} readOnly={readOnly} onValue={(v) => setToken(k, v)} />
            );
          })}
        </section>
      ))}

      <section aria-label="Readability" className="space-y-2" data-design-check={check.blocking ? "blocking" : check.items.length ? "warning" : "ok"}>
        {check.items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{T.DESIGN_WORDS.readable}</p>
        ) : (
          <>
            {check.blocking && (
              <p className="text-xs font-medium text-destructive" data-design-blocks="">
                {T.DESIGN_WORDS.blocks}
              </p>
            )}
            <ul className="space-y-2">
              {check.items.map((i) => (
                <li key={`${i.severity}-${i.pair}`} className="space-y-1 rounded-md border border-border p-2 text-xs" data-design-issue={i.severity}>
                  <p>{i.message}</p>
                  {i.fix && !readOnly && (
                    <Button type="button" size="sm" variant="outline" onClick={() => write(T.applyFix(brand, i.fix, startingBrand))} data-design-fix={i.fix.token}>
                      {i.fix.words}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {!readOnly && (!isPackage || look?.tokens) && !T.sameTokens(brand, target) && (
        <Button type="button" size="sm" variant="ghost" onClick={() => write(target)} data-design-reset={isPackage ? "theme" : "start"}>
          {T.resetWords({ packageName: isPackage ? look?.name || "theme" : null })}
        </Button>
      )}
    </div>
  );
}
