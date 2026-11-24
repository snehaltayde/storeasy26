"use client";

// Phase 1 line 9: the setup's progress and done screen for a store an operator
// created. Polls /api/platform/stores?signup= every 1.5 s (every 6 s while the
// tab is hidden), reads the steps out through an aria-live region, offers
// Try again on either failure kind (line 8's resume action) and, once done,
// shows the invite, the address, the app, the redirect URL and Resend invite
// (line 8's owner_invite action). Nothing here ever holds a token or a link.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CircleAlert, Circle, Copy, Globe, LoaderCircle, Mail, RotateCw, Store, X } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PROGRESS, LABELS, failureWords, inviteWords, inviteSent, appWords } from "./createStoreWords";

const POLL_MS = 1500;
const HIDDEN_POLL_MS = 6000;

// one setup step: a ringed icon, its name, and its state in words
function Step({ step }) {
  const { state, label } = step;
  const ring = state === "done" ? "border-success/30 bg-success/10 text-success" : state === "working" ? "border-info/30 bg-info/10 text-info" : state === "failed" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-muted text-muted-foreground";
  const Icon = state === "done" ? Check : state === "working" ? LoaderCircle : state === "failed" ? X : Circle;
  return (
    <li data-state={state} className="relative flex items-center gap-3 py-2 text-sm">
      <span className={cn("relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border", ring)}>
        <Icon aria-hidden className={cn("size-3.5", state === "working" && "motion-safe:animate-spin", state === "waiting" && "size-2 fill-current")} />
      </span>
      <span className={cn("min-w-0 flex-1", state === "waiting" && "text-muted-foreground", state === "failed" && "font-medium")}>{label}</span>
      <span className={cn("shrink-0 text-[0.8125rem]", state === "failed" ? "text-destructive" : "text-muted-foreground")}>{PROGRESS.stepWords[state] || state}</span>
    </li>
  );
}

const STATE_WORDS = { done: "done", working: "in progress", failed: "failed", waiting: "waiting" };

function Fact({ icon: Icon, tone = "muted", label, children }) {
  const color = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-muted-foreground";
  return (
    <div className="flex gap-3 py-4">
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", color)} />
      <div className="min-w-0 flex-1">
        <dt className="text-[0.8125rem] font-medium text-muted-foreground">{label}</dt>
        <dd className="mt-1 text-sm">{children}</dd>
      </div>
    </div>
  );
}

// the redirect URL, whole, with a Copy button (falls back to selecting it)
function CopyField({ value }) {
  const [state, setState] = useState("idle"); // idle | copied | failed
  const ref = useRef(null);
  const reset = useRef(null);
  useEffect(() => () => clearTimeout(reset.current), []);
  async function copy() {
    clearTimeout(reset.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      const r = document.createRange();
      r.selectNodeContents(ref.current);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(r);
      setState("failed");
    }
    reset.current = setTimeout(() => setState("idle"), 2500);
  }
  return (
    <div>
      <div className="flex items-stretch overflow-hidden rounded-md border border-border bg-muted">
        <code ref={ref} className="min-w-0 flex-1 px-2.5 py-2 font-mono text-[0.8125rem] break-all select-all">
          {value}
        </code>
        <Button type="button" variant="ghost" onClick={copy} className="h-auto shrink-0 rounded-none border-l border-border px-3" aria-label={state === "copied" ? PROGRESS.copied : `${PROGRESS.copy} the redirect URL`}>
          {state === "copied" ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />}
          <span aria-hidden>{state === "copied" ? PROGRESS.copied : PROGRESS.copy}</span>
        </Button>
      </div>
      <p role="status" className={cn("mt-1.5 text-[0.8125rem]", state === "failed" ? "text-destructive" : "text-muted-foreground")}>
        {state === "failed" ? PROGRESS.copyFailed : state === "copied" ? <span className="sr-only">{PROGRESS.copied}</span> : null}
      </p>
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
  const done = data?.status === "done";
  const failed = data?.status === "failed";
  const sent = done && inviteSent(data.done);

  return (
    <div className="mx-auto max-w-[640px] px-4 py-6 md:px-6 md:py-8">
      <a href="/platform" className="inline-flex items-center gap-1 rounded-md text-[0.8125rem] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <ArrowLeft className="size-3.5" aria-hidden /> {LABELS.back}
      </a>
      <div className="mt-2 flex items-center gap-2.5">
        {done && (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
            <Check aria-hidden className="size-4" />
          </span>
        )}
        {failed && (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <CircleAlert aria-hidden className="size-4" />
          </span>
        )}
        <h1 className="min-w-0 truncate text-[1.375rem] font-semibold" title={title}>
          {title}
        </h1>
      </div>
      {data?.status === "provisioning" && <p className="mt-1 text-sm text-muted-foreground">{PROGRESS.working}</p>}
      {done && <p className="mt-1 text-sm text-muted-foreground">{PROGRESS.doneIntro}</p>}

      <div className="mt-6 rounded-card border border-border bg-card p-4 shadow-card md:p-6">
        <p className="sr-only" aria-live="polite">
          {live}
        </p>
        {!data && !error && (
          <div aria-busy="true" aria-label="Loading the setup" className="space-y-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-7 rounded-full" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ))}
          </div>
        )}
        {error && (
          <div role="alert" className="space-y-4">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <p className="min-w-0">{error}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {error !== PROGRESS.lost && (
                <Button variant="outline" onClick={load}>
                  <RotateCw aria-hidden /> {PROGRESS.tryAgain}
                </Button>
              )}
              <Button variant={error === PROGRESS.lost ? "default" : "ghost"} asChild>
                <a href="/platform/onboarding">{LABELS.onboarding}</a>
              </Button>
            </div>
          </div>
        )}
        {data && (
          // the steps, joined by a thin line behind their icons
          <ol data-status={data.status} className="relative before:absolute before:top-5 before:bottom-5 before:left-3.5 before:w-px before:bg-border">
            {data.steps.map((s) => (
              <Step key={s.label} step={s} />
            ))}
          </ol>
        )}
        {data?.note && <p className="mt-4 rounded-md bg-warning/10 px-3 py-2 text-[0.8125rem] text-warning-text">{data.note}</p>}

        {failed && (
          <div className="mt-5 space-y-4 border-t border-border pt-5">
            <p className="text-sm">{failureWords(data.failureKind)}</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={tryAgain} disabled={acting} size="lg" className="h-10 px-4">
                {acting ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
                {acting ? PROGRESS.retrying : PROGRESS.tryAgain}
              </Button>
              <Button variant="ghost" size="lg" className="h-10 px-4" asChild>
                <a href={`/platform/onboarding?view=all&s=${encodeURIComponent(`signup:${signup}`)}`}>{PROGRESS.openRow}</a>
              </Button>
            </div>
            {actionNote && (
              <p role="status" className="text-sm text-destructive">
                {actionNote.words}
              </p>
            )}
          </div>
        )}

        {done && (
          <>
            <dl className="mt-4 divide-y divide-border border-t border-border">
              <Fact icon={Mail} tone={sent ? "success" : "warning"} label={PROGRESS.invite}>
                <span className={sent ? "" : "text-warning-text"}>{inviteWords(data.done)}</span>
              </Fact>
              <Fact icon={Globe} label={PROGRESS.address}>
                <span className="font-mono text-[0.8125rem] break-all">{data.address}</span>
              </Fact>
              <Fact icon={Store} tone={data.done.appReady ? "success" : "warning"} label={PROGRESS.app}>
                {appWords(data.done)}
              </Fact>
              <Fact icon={Copy} label={PROGRESS.redirect}>
                <CopyField value={data.done.redirectUrl} />
                <p className="mt-1 text-[0.8125rem] text-muted-foreground">{PROGRESS.redirectHint}</p>
              </Fact>
            </dl>
            {actionNote && (
              <p role="status" className={cn("mt-2 rounded-md px-3 py-2 text-[0.8125rem]", actionNote.tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success")}>
                {actionNote.words}
              </p>
            )}
            <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-5">
              <Button variant={sent ? "outline" : "default"} onClick={resend} disabled={acting}>
                {acting ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Mail aria-hidden />}
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
      </div>
    </div>
  );
}
