"use client";

import { useEffect, useRef, useState } from "react";
import { FIRST_RUN_URL, HALF_WORDS, START_WORDS, afterMake, viewOf } from "./brandModel";

// The starter store (Phase 1 line 6; FirstRun's GET and one-time POST, moved
// here as a hook). It reads GET /api/admin/first-run and, when the store can
// be made and isn't yet, asks POST /api/admin/first-run ONCE, only for a role
// that can edit (canEdit). Someone who can't edit never POSTs: they read.
// onChange (optional) is called after anything here changes the store (it
// was made, half made, or a re-read after a sync settled).
//   state  what shows: loading | load-failed | making | make-failed | half |
//          ready | kept | syncing | sync-failed | blocked (brandModel viewOf)

export async function call(method, url, body) {
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

export default function useStarterStore({ canEdit = false, onChange } = {}) {
  const [data, setData] = useState(null); // { firstRun, sync }
  const [phase, setPhase] = useState("loading"); // loading | idle | load-failed | making | make-failed | half
  const [error, setError] = useState(null);
  const [halfReason, setHalfReason] = useState(null);
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
    if (!canEdit) return;
    posted.current = true;
    setError(null);
    setPhase("making");
    const r = await call("POST", FIRST_RUN_URL, {});
    if (r.ok && r.body.ok && r.body.ran) {
      setData((d) => ({ ...d, firstRun: afterMake(d?.firstRun, r.body) }));
      setPhase("idle");
      onChange?.();
      return;
    }
    if (r.ok && r.body.ok && r.body.ran === false && r.body.homeWritten === true) {
      // P6-FIX3: the home page was made, the colours were not: say so
      setHalfReason(typeof r.body.reason === "string" ? r.body.reason : "other");
      setPhase("half");
      onChange?.();
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

  // what shows: the phase while a request is out or failed, else the view.
  // "make" is the POST about to go (making); once it went, the same answer
  // again (a re-read that still says "can be made") shows the retry instead
  // of posting by itself a second time.
  let state = phase;
  if (phase === "idle") {
    state = view;
    if (view === "make") state = !canEdit ? "blocked" : posted.current ? "make-failed" : "making";
  }

  return {
    state,
    firstRun: data?.firstRun || {},
    sync: data?.sync || null,
    error,
    halfReason: Object.hasOwn(HALF_WORDS, halfReason) ? halfReason : "other",
    make,
    // after a sync settled: read again, and let the steps be read again
    reload() {
      load();
      onChange?.();
    },
  };
}
