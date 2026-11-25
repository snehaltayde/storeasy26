"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { createDocumentStore } from "../editor/store";
import { BrandColourInput, BrandStepSelect } from "../editor/fields/DesignForm";
import { BRAND_FIELDS, design } from "../editor/fields/inspectorModel";
import { restoreOps } from "./studioModel";
import * as T from "./tokensModel";

// Phase 6 line 2 (docs/plans/phase-6.md "Line 2"): the studio's Design tab.
// The founder's colours, type and spacing (doc_design settings.brand, only
// the values validateBrand takes), with the editor's own colour and step
// controls (DesignForm's BrandColourInput / BrandStepSelect).
//
// doc_design has its own store (revision concurrency, 700 ms autosave), kept
// for the studio session in `sessions` (keyed by the studio's model), so it
// outlives a switch to the Sections tab; when the studio's own document is
// doc_design that store is used instead. Every change posts storeasy:tokens
// to the frame on the same tick (before the save), records an undo step on
// the studio's model (model.onStep applies it back to this store, from
// either tab) and touches doc_design, which turns showDesign on (Studio.js)
// and pre-ticks the design in Publish (line 1's dialog: designStoreFor()
// gives it this store to flush).
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

function sessionFor(studio) {
  const model = studio?.model;
  if (!model) return null;
  let s = sessions.get(model);
  if (s) return s;
  const listeners = new Set();
  s = { store: null, status: "idle", look: null, post: studio.post, off: null, unload: null };
  s.emit = () => {
    s.snap = null;
    for (const fn of [...listeners]) fn();
  };
  s.subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  s.getSnapshot = () => (s.snap ??= { status: s.status, look: s.look, store: s.store });
  // undo / redo of a token step, from either tab
  s.off = model.onStep(T.DESIGN_DOC, (step, dir) => {
    const st = s.store;
    if (!st || st.readOnly) return;
    const target = dir === "undo" ? step.before : step.after;
    const msg = postFor(target);
    if (msg) s.post?.(msg);
    for (const o of restoreOps(st.getState().body, target)) st.setField(o.path, o.value);
  });
  sessions.set(model, s);
  return s;
}

// The doc_design store this studio session uses (line 1's Publish flushes it).
export const designStoreFor = (studio) => (studio?.model ? sessions.get(studio.model)?.store ?? null : null);

async function openDesign(s, studio) {
  s.status = "loading";
  s.emit();
  const { api, readOnly } = studio;
  if (studio.state?.id === T.DESIGN_DOC && studio.store) {
    s.store = studio.store;
  } else {
    let r = await api.call("getDocument", T.DESIGN_DOC);
    if (r?.code === "NOT_FOUND" && !readOnly) {
      const made = await api.call("createDocument", { type: "design", body: null });
      r = made?.ok ? await api.call("getDocument", T.DESIGN_DOC) : made;
    }
    if (r?.ok && isObj(r.data?.document)) {
      s.store = createDocumentStore({ api, document: r.data.document, tenant: typeof window !== "undefined" ? window.location.host : "", storage: null, readOnly });
      await s.store.open();
      if (typeof window !== "undefined" && !readOnly) {
        s.unload = (e) => {
          if (s.store?.beforeUnload()) e.preventDefault();
        };
        window.addEventListener("beforeunload", s.unload);
      }
    } else {
      s.status = r?.code === "NOT_FOUND" ? "missing" : "failed";
      s.emit();
      return;
    }
  }
  s.status = "ready";
  s.emit();
  // the look it draws on: the live brand and theme, and an uploaded theme's
  // name, surfaces and tokens
  const theme = T.themeOf(s.store.getState().body);
  const id = T.packageIdOf(theme);
  const [themes, pkg] = await Promise.all([getJson("/api/admin/themes"), id ? getJson(`/api/admin/themes/${encodeURIComponent(id)}`) : null]);
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

const noSub = () => () => {};
const noState = () => null;

export default function DesignRail({ studio }) {
  const s = sessionFor(studio);
  if (s) s.post = studio.post;
  const snap = useSyncExternalStore(s ? s.subscribe : noSub, s ? s.getSnapshot : noState, s ? s.getSnapshot : noState);
  const store = snap?.store ?? null;
  const state = useSyncExternalStore(store ? store.subscribe : noSub, store ? store.getState : noState, noState);
  const [typing, setTyping] = useState({});
  useEffect(() => {
    if (s && s.status === "idle") openDesign(s, studio);
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = designReadOnly(studio, store);
  const startingBrand = studio?.startingBrand ?? null;
  const brand = T.brandOf(state?.body);

  // one change: post first (same tick), then the draft save, then the undo step
  const write = (next) => {
    if (readOnly || !store) return;
    const msg = T.tokensMessage(next);
    if (msg) studio.post(msg);
    const before = store.getState().body;
    store.setField("settings.brand", next);
    studio.model.record({ docId: T.DESIGN_DOC, before, after: store.getState().body });
  };
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
  return <DesignRailView status={snap?.status || "idle"} state={state} look={snap?.look ?? null} readOnly={readOnly} startingBrand={startingBrand} typing={typing} onToken={setToken} onWrite={write} />;
}

// no storefront.write (support, operator support), or a read-only store
export const designReadOnly = (studio, store = null) => studio?.readOnly !== false || studio?.can?.write !== true || store?.readOnly === true;

// The tab itself, all props (test-studio-tokens renders it on its own).
export function DesignRailView({ status = "idle", state = null, look = null, readOnly = true, startingBrand = null, typing = {}, onToken = () => {}, onWrite = () => {} }) {
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
