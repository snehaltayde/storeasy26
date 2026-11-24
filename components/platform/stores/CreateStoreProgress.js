"use client";

// Phase 1 line 9: the setup's progress and done screen for a store an operator
// created. Polls /api/platform/stores?signup= every 1.5 s (every 6 s while the
// tab is hidden), reads the steps out through an aria-live region, offers
// Try again on either failure kind (line 8's resume action) and, once done,
// shows the invite, the address, the app, the redirect URL and Resend invite
// (line 8's owner_invite action). Nothing here ever holds a token or a link.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Circle, Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PROGRESS, LABELS, failureWords, inviteWords, inviteSent, appWords } from "./createStoreWords";

const POLL_MS = 1500;
const HIDDEN_POLL_MS = 6000;

function StepIcon({ state }) {
  if (state === "done") return <Check className="size-4 text-success" aria-hidden />;
  if (state === "working") return <Loader2 className="size-4 animate-spin text-info motion-reduce:animate-none" aria-hidden />;
  if (state === "failed") return <X className="size-4 text-destructive" aria-hidden />;
  return <Circle className="size-4 text-muted-foreground" aria-hidden />;
}

const STATE_WORDS = { done: "done", working: "in progress", failed: "failed", waiting: "waiting" };

function Fact({ label, children }) {
  return (
    <div className="grid gap-1 py-3 md:grid-cols-[200px_1fr] md:gap-4">
      <dt className="text-[0.8125rem] font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

async function onboardingAction(body) {
  const res = await fetch("/api/platform/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401) {
    window.location.assign("/platform");
    return { ok: false };
  }
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, ...json };
}

export default function CreateStoreProgress({ signup }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const [actionNote, setActionNote] = useState(null); // { tone, words }
  const timer = useRef(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const res = await fetch(`/api/platform/stores?signup=${encodeURIComponent(signup)}`, { cache: "no-store" });
      if (res.status === 401) return window.location.assign("/platform");
      const body = await res.json().catch(() => null);
      if (!alive.current) return;
      if (res.status === 404) {
        setError(PROGRESS.lost);
        return;
      }
      if (!res.ok || !body?.ok) throw new Error(body?.error || "We couldn't read the setup just now.");
      setError("");
      setData(body);
      if (body.status === "provisioning") timer.current = setTimeout(load, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
    } catch (e) {
      if (alive.current) setError(String(e?.message || e));
    }
  }, [signup]);

  useEffect(() => {
    alive.current = true;
    load();
    const onVisible = () => {
      if (!document.hidden && data?.status === "provisioning") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // the visibility listener only needs the latest status, read on the next poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function tryAgain() {
    setActing(true);
    setActionNote(null);
    const r = await onboardingAction({ action: "resume", subject: `signup:${signup}` });
    setActing(false);
    if (!r.ok) return setActionNote({ tone: "danger", words: r.error || "That didn't work. Try again." });
    setData((d) => (d ? { ...d, status: "provisioning", steps: d.steps.map((s) => (s.state === "failed" ? { ...s, state: "working" } : s)) } : d));
    timer.current = setTimeout(load, POLL_MS);
  }

  async function resend() {
    setActing(true);
    setActionNote(null);
    const r = await onboardingAction({ action: "owner_invite", subject: data.subject });
    setActing(false);
    if (!r.ok) return setActionNote({ tone: "danger", words: r.error || "The invite didn't go out. Try again." });
    setActionNote({ tone: "success", words: `Invite sent to ${r.sentTo}. Earlier invites no longer work.` });
  }

  const name = data?.storeName || "the store";
  const title = !data ? PROGRESS.title("the store") : data.status === "done" ? PROGRESS.doneTitle(name) : data.status === "failed" ? PROGRESS.failedTitle : PROGRESS.title(name);
  const live = data ? data.steps.map((s) => `${s.label}: ${STATE_WORDS[s.state] || s.state}`).join(". ") : "";

  return (
    <div className="mx-auto max-w-[640px] px-4 py-6 md:px-6">
      <a href="/platform" className="inline-flex items-center gap-1 rounded-md text-[0.8125rem] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <ArrowLeft className="size-3.5" aria-hidden /> {LABELS.back}
      </a>
      <h1 className="mt-2 truncate text-[1.375rem] font-semibold" title={title}>
        {title}
      </h1>
      {data?.status === "provisioning" && <p className="mt-1 text-sm text-muted-foreground">{PROGRESS.working}</p>}

      <div className="mt-6 rounded-card border border-border bg-card p-4 shadow-card md:p-6">
        <p className="sr-only" aria-live="polite">
          {live}
        </p>
        {!data && !error && (
          <div aria-busy="true" aria-label="Loading the setup" className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-5 w-3/4" />
            ))}
          </div>
        )}
        {error && (
          <div role="alert" className="space-y-3">
            <p className="text-sm text-destructive">{error}</p>
            <div className="flex flex-wrap gap-2">
              {error !== PROGRESS.lost && (
                <Button variant="outline" size="sm" onClick={load}>
                  <RotateCw className="size-3.5" aria-hidden /> {PROGRESS.tryAgain}
                </Button>
              )}
              <Button variant="outline" size="sm" asChild>
                <a href="/platform/onboarding">{LABELS.onboarding}</a>
              </Button>
            </div>
          </div>
        )}
        {data && (
          <ol className="space-y-2.5" data-status={data.status}>
            {data.steps.map((s) => (
              <li key={s.label} data-state={s.state} className="flex items-center gap-2.5 text-sm">
                <StepIcon state={s.state} />
                <span className={s.state === "waiting" ? "text-muted-foreground" : ""}>{s.label}</span>
              </li>
            ))}
          </ol>
        )}
        {data?.note && <p className="mt-4 text-sm text-warning-text">{data.note}</p>}

        {data?.status === "failed" && (
          <div className="mt-5 space-y-3">
            <p className="text-sm">{failureWords(data.failureKind)}</p>
            <Button onClick={tryAgain} disabled={acting}>
              {acting ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RotateCw className="size-4" aria-hidden />}
              {acting ? PROGRESS.retrying : PROGRESS.tryAgain}
            </Button>
          </div>
        )}

        {data?.status === "done" && (
          <>
            <dl className="mt-5 divide-y divide-border border-t border-border">
              <Fact label={PROGRESS.invite}>
                <span className={inviteSent(data.done) ? "" : "text-warning-text"}>{inviteWords(data.done)}</span>
              </Fact>
              <Fact label={PROGRESS.address}>
                <span className="font-mono text-[0.8125rem]">{data.address}</span>
              </Fact>
              <Fact label={PROGRESS.app}>{appWords(data.done)}</Fact>
              <Fact label={PROGRESS.redirect}>
                <code className="block font-mono text-[0.8125rem] break-all select-all">
                  {data.done.redirectUrl}
                </code>
                <p className="mt-1 text-xs text-muted-foreground">{PROGRESS.redirectHint}</p>
              </Fact>
            </dl>
            {actionNote && (
              <p role="status" className={`mt-4 text-sm ${actionNote.tone === "danger" ? "text-destructive" : "text-success"}`}>
                {actionNote.words}
              </p>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              <Button variant={inviteSent(data.done) ? "outline" : "default"} onClick={resend} disabled={acting}>
                {acting ? PROGRESS.resending : PROGRESS.resend}
              </Button>
              <Button variant="outline" asChild>
                <a href={`/platform/onboarding?view=all&s=${encodeURIComponent(data.subject)}`}>{PROGRESS.openRow}</a>
              </Button>
              <Button variant="ghost" asChild>
                <a href="/platform/stores/new">{PROGRESS.another}</a>
              </Button>
            </div>
          </>
        )}
        {data?.status === "failed" && actionNote && (
          <p role="status" className="mt-3 text-sm text-destructive">
            {actionNote.words}
          </p>
        )}
      </div>
    </div>
  );
}
