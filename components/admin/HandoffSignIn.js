"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// The signup handoff (Phase 1 line 1). Reads the token from the fragment,
// clears it from the address bar at once, posts it to /api/admin/handoff and
// goes where the answer says (/admin/onboarding). States: signing in; refused
// (expired, used, wrong store: sign in with email and password instead); no
// connection (Try again, with the same token: a request that never arrived
// spent nothing).
const LOGIN = "/admin/login";

export default function HandoffSignIn() {
  const token = useRef(null);
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

  if (state.phase === "working") {
    return (
      <div data-handoff="working" role="status" aria-live="polite" className="space-y-2 text-center">
        <p className="text-base font-semibold text-fg">Signing you in…</p>
        <p className="text-sm text-fg-muted">This takes a moment.</p>
      </div>
    );
  }
  return (
    <div data-handoff={state.phase} className="space-y-4">
      <div role="alert" className="space-y-1">
        <p className="text-base font-semibold text-fg">{state.phase === "offline" ? "We couldn't sign you in yet" : "This sign-in link didn't work"}</p>
        <p className="text-sm text-fg-muted">{state.error}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {state.phase === "offline" && <Button onClick={send}>Try again</Button>}
        <Button asChild variant={state.phase === "offline" ? "outline" : "default"}>
          <a href={LOGIN}>Sign in with email and password</a>
        </Button>
      </div>
    </div>
  );
}
