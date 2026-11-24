"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

// The signup handoff (Phase 1 line 1). Reads the token from the fragment,
// clears it from the address bar at once, posts it to /api/admin/handoff and
// goes where the answer says (/admin/onboarding). States: signing in; refused
// (expired, used, wrong store: sign in with email and password instead); no
// connection (Try again, with the same token: a request that never arrived
// spent nothing). The heading takes focus when the answer is a problem.
const LOGIN = "/admin/login";

export default function HandoffSignIn() {
  const token = useRef(null);
  const headingRef = useRef(null);
  const [state, setState] = useState({ phase: "working", error: null });

  const send = useCallback(async () => {
    if (!token.current) {
      setState({ phase: "refused", error: "This sign-in link is missing its code. Sign in with your email and password." });
      return;
    }
    setState({ phase: "working", error: null });
    let res;
    try {
      res = await fetch("/api/admin/handoff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token.current }) });
    } catch {
      setState({ phase: "offline", error: "We couldn't reach your store. Check your connection, then try again." });
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.redirect) {
      token.current = null;
      window.location.replace(body.redirect);
      return;
    }
    if (res.status >= 500 || res.status === 429) {
      setState({ phase: "offline", error: body?.error || "Something went wrong on our side. Try again in a moment." });
      return;
    }
    token.current = null;
    setState({ phase: "refused", error: body?.error || "This sign-in link has expired or was already used. Sign in with your email and password." });
  }, []);

  useEffect(() => {
    const m = /(?:^|[#&])t=([0-9a-f]+)/.exec(window.location.hash || "");
    token.current = m ? m[1] : null;
    // the token leaves the address bar (and the history entry) before anything else happens
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    send();
  }, [send]);

  useEffect(() => {
    if (state.phase !== "working") headingRef.current?.focus();
  }, [state.phase]);

  if (state.phase === "working") {
    return (
      <section data-handoff="working" role="status" aria-live="polite" className="space-y-3">
        <h1 className="flex items-center gap-3 text-[1.75rem] leading-tight font-semibold tracking-[-0.01em]">
          Signing you in…
          <LoaderCircle aria-hidden className="size-5 text-muted-foreground motion-safe:animate-spin" />
        </h1>
        <p className="text-muted-foreground">Your store is ready. This takes a moment.</p>
      </section>
    );
  }
  const offline = state.phase === "offline";
  return (
    <section data-handoff={state.phase} className="space-y-6">
      <div role="alert" className="space-y-3">
        <h1 ref={headingRef} tabIndex={-1} className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em] outline-none">
          {offline ? "We couldn't sign you in yet" : "This sign-in link didn't work"}
        </h1>
        <p className="text-muted-foreground">{state.error}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {offline && (
          <Button size="lg" onClick={send} className="h-10 px-4">
            Try again
          </Button>
        )}
        <Button asChild size="lg" variant={offline ? "outline" : "default"} className="h-10 px-4">
          <a href={LOGIN}>Sign in with email and password</a>
        </Button>
      </div>
    </section>
  );
}
