"use client";

// Phase 1 line 8: the detail sheet for one signup or store, and the help an
// operator can give from it. Only the actions that apply are shown; a refusal
// from the server is shown as it came (it says what to do next). Nothing here
// ever shows a token or a sign-in link: help goes out by email to an address
// on file.
import { useCallback, useEffect, useState } from "react";
import { Ban, ExternalLink } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { statusWords, when, ACTOR_KIND_WORDS, MAIL_KIND_WORDS, MAIL_STATUS_WORDS, PROVISION_STEP_WORDS, ROLE_WORDS, RUN_STEP_WORDS, STEP_STATE_WORDS } from "./onboardingWords";

const selectClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-muted px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function Section({ title, children }) {
  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Facts({ items }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.8125rem]">
      {items
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

// one help action: what it does on the left, the button on the right
function Action({ hint, children }) {
  return (
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <p className="text-[0.8125rem] text-muted-foreground sm:max-w-[34ch]">{hint}</p>
      <div className="flex shrink-0 flex-wrap gap-2">{children}</div>
    </div>
  );
}

const Empty = ({ children }) => <p className="text-[0.8125rem] text-muted-foreground">{children}</p>;

function Notice({ notice }) {
  if (!notice) return null;
  return (
    <p role={notice.error ? "alert" : "status"} className={`rounded-md px-3 py-2 text-[0.8125rem] ${notice.error ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"}`}>
      {notice.text}
    </p>
  );
}

export default function SubjectSheet({ subject, onClose, onChanged }) {
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("4");
  const [note, setNote] = useState("");
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [notify, setNotify] = useState(true);

  const load = useCallback(async () => {
    if (!subject) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`/api/platform/onboarding?subject=${encodeURIComponent(subject)}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || "We couldn't load this just now.");
      setState({ loading: false, error: null, data: body });
      setOwnerEmail((v) => v || body.actions?.ownerEmails?.[0] || "");
    } catch (e) {
      setState((s) => ({ loading: false, error: String(e?.message || e), data: s.data }));
    }
  }, [subject]);

  useEffect(() => {
    setState({ loading: false, error: null, data: null });
    setNotice(null);
    setOwnerEmail("");
    setReason("");
    setNote("");
    load();
  }, [load]);

  async function act(action, payload, okText) {
    setBusy(action);
    setNotice(null);
    try {
      const res = await fetch("/api/platform/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, subject, ...payload }),
      });
      if (res.status === 401) {
        setNotice({ error: true, text: "Your operator sign-in has ended. Sign in again at /platform, then reopen this sheet." });
        return null;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setNotice({ error: true, text: body?.error || "That didn't work. Try again." });
        return null;
      }
      setNotice({ text: typeof okText === "function" ? okText(body) : okText });
      await load();
      onChanged?.();
      return body;
    } catch {
      setNotice({ error: true, text: "We couldn't reach the server. Check your connection and try again." });
      return null;
    } finally {
      setBusy(null);
    }
  }

  const d = state.data;
  const a = d?.actions || {};
  const title = d?.kind === "tenant" ? d.store.name : d?.signup?.storeName || "Loading…";
  const status = d ? statusWords(d.kind === "tenant" ? (d.signup && ["setting_up", "failed_retries", "failed_needs_us", "failed_lapsed"].includes(d.signup.status) ? d.signup.status : d.store.status !== "active" ? "suspended" : d.onboarding?.open ? "open" : "closed") : d.signup.status) : null;

  return (
    <Sheet open={Boolean(subject)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl" data-subject-sheet={subject || undefined}>
        <SheetHeader>
          <SheetTitle className="truncate pr-8">{title}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2">
            {status && <Badge variant={status.tone}>{status.label}</Badge>}
            <span className="font-mono text-xs">{d?.kind === "tenant" ? d.store.address || d.store.id : d?.signup?.address}</span>
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-8">
          {state.error && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[0.8125rem] text-destructive">
              <span>{state.error}</span>
              <Button size="sm" variant="outline" onClick={load}>
                Try again
              </Button>
            </div>
          )}
          {!d && state.loading && (
            <div className="space-y-3" aria-busy="true" aria-label="Loading details">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}

          {d && (
            <>
              <Section title="Help">
                <Notice notice={notice} />
                {(a.resume || a.resendCode || a.signinHelp || a.ownerInvite) && (
                  <div className="divide-y divide-border rounded-card border border-border px-3 py-3">
                    {a.resume && (
                      <Action hint="Runs the store's setup again from the step that failed. It carries on in the background.">
                        <Button disabled={busy != null} onClick={() => act("resume", {}, "Provisioning resumed. It runs in the background; refresh in a minute.")}>
                          Resume provisioning
                        </Button>
                      </Action>
                    )}
                    {a.resendCode && (
                      <Action hint="A fresh code by email. It works only in the browser the founder signed up in.">
                        <Button variant="outline" disabled={busy != null} onClick={() => act("resend_code", {}, (b) => b.note)}>
                          Resend the email code
                        </Button>
                      </Action>
                    )}
                    {a.signinHelp && (
                      <form
                        className="space-y-2 py-3 first:pt-0 last:pb-0"
                        onSubmit={(e) => {
                          e.preventDefault();
                          act("signin_help", { email: ownerEmail }, (b) => `Sign-in help sent to ${b.sentTo}.`);
                        }}
                      >
                        <Label htmlFor="help-owner" className="text-[0.8125rem]">
                          Email sign-in help to
                        </Label>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <select id="help-owner" className={selectClass} value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)}>
                            {(a.ownerEmails || []).map((e) => (
                              <option key={e} value={e}>
                                {e}
                              </option>
                            ))}
                          </select>
                          <Button type="submit" variant="outline" disabled={busy != null}>
                            Send sign-in help
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">They get the store&apos;s sign-in address and a one-hour, single-use link to set a new password.</p>
                      </form>
                    )}
                    {a.ownerInvite && (
                      <Action hint={`A 7-day invite to ${a.inviteEmail}, the email on file. Any earlier unused owner invite stops working.`}>
                        <Button variant="outline" disabled={busy != null} onClick={() => act("owner_invite", {}, (b) => `Owner invite sent to ${b.sentTo}.`)}>
                          Email an owner invite
                        </Button>
                      </Action>
                    )}
                  </div>
                )}

                {d.kind === "tenant" && a.supportAccess && (
                  <div className="space-y-3 rounded-card border border-border p-3">
                    <h4 className="text-sm font-medium">Support access (read-only)</h4>
                    {a.activeGrant ? (
                      <>
                        <p className="text-[0.8125rem]">Open until {when(a.activeGrant.until)}. The founder sees a banner while it is open.</p>
                        <div className="flex flex-wrap gap-2">
                          <Button asChild variant="outline">
                            <a href={a.consoleUrl} target="_blank" rel="noopener noreferrer">
                              Open store console (read-only) <ExternalLink className="size-3.5" aria-hidden />
                            </a>
                          </Button>
                          <Button variant="ghost" disabled={busy != null} onClick={() => act("support_revoke", { grant: a.activeGrant.id }, "Support access closed.")}>
                            Close support access
                          </Button>
                        </div>
                      </>
                    ) : (
                      <form
                        className="space-y-3"
                        onSubmit={(e) => {
                          e.preventDefault();
                          act("support_open", { reason, hours: Number(hours) }, "Support access is open.").then((b) => b && setReason(""));
                        }}
                      >
                        <div className="space-y-1.5">
                          <Label htmlFor="sg-reason" className="text-[0.8125rem]">
                            Why you need to look
                          </Label>
                          <Textarea id="sg-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The founder sees this in their console" minLength={5} maxLength={500} required />
                        </div>
                        <div className="flex flex-wrap items-end justify-between gap-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="sg-hours" className="text-[0.8125rem]">
                              For how many hours (1–72)
                            </Label>
                            <Input id="sg-hours" type="number" min={1} max={72} value={hours} onChange={(e) => setHours(e.target.value)} className="w-24 font-mono tabular-nums" />
                          </div>
                          <Button type="submit" variant="outline" disabled={busy != null || reason.trim().length < 5}>
                            Open support access
                          </Button>
                        </div>
                      </form>
                    )}
                  </div>
                )}

                {a.release && (
                  <div className="flex flex-col gap-2 rounded-card border border-destructive/30 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <p className="text-[0.8125rem] text-muted-foreground sm:max-w-[34ch]">
                      This signup has lapsed. Freeing its address lets anyone sign up with it, and the signup can&apos;t be resumed.
                    </p>
                    <Button variant="destructive" disabled={busy != null} onClick={() => setReleaseOpen(true)} className="shrink-0">
                      Free this address
                    </Button>
                  </div>
                )}

                {a.cancel && (
                  <div data-sheet-cancel className="flex flex-col items-start gap-3 rounded-card border border-destructive/30 bg-destructive/5 p-3">
                    <div className="space-y-1">
                      <p className="text-[0.8125rem] font-medium">Stop this store before the founder joins</p>
                      <p className="text-[0.8125rem] text-muted-foreground">Storeasy created it and its setup isn&apos;t running. Cancelling frees its address and Shopify store for another store.</p>
                    </div>
                    <Button variant="destructive" disabled={busy != null} onClick={() => setCancelOpen(true)}>
                      <Ban aria-hidden /> Cancel this store setup
                    </Button>
                  </div>
                )}

                {!a.resume && !a.resendCode && !a.signinHelp && !a.ownerInvite && !a.release && !a.cancel && !(d.kind === "tenant" && a.supportAccess) && <Empty>Nothing to help with here right now. Add a note below.</Empty>}
              </Section>

              <Separator />

              {d.signup && (
                <Section title="Signup">
                  <Facts
                    items={[
                      ["Founder", d.signup.name],
                      ["Email", d.signup.email],
                      ["Status", statusWords(d.signup.status).label],
                      ["Started", when(d.signup.createdAt)],
                      ["Email confirmed", when(d.signup.verifiedAt)],
                      ["Codes sent", String(d.signup.sends)],
                      ["Setup tries", d.signup.provisionAttempts ? String(d.signup.provisionAttempts) : null],
                      ["Next retry", when(d.signup.nextRetryAt)],
                      ["Operator alerted", d.signup.alerted.length ? "Yes" : null],
                      ["Problem", d.signup.error],
                      ["Address freed", when(d.signup.releasedAt)],
                    ]}
                  />
                </Section>
              )}

              {d.run && (
                <Section title="Setup steps">
                  <ol className="space-y-1 text-[0.8125rem]">
                    {d.run.steps.map((s) => (
                      <li key={s.name} className="flex flex-wrap items-baseline gap-2">
                        <Badge variant={(RUN_STEP_WORDS[s.status] || {}).tone || "muted"}>{(RUN_STEP_WORDS[s.status] || {}).label || s.status}</Badge>
                        <span>{PROVISION_STEP_WORDS[s.name] || s.name}</span>
                        {s.error && <span className="w-full text-xs text-destructive">{s.error}</span>}
                      </li>
                    ))}
                    {!d.run.steps.length && <Empty>No steps have run yet.</Empty>}
                  </ol>
                </Section>
              )}

              {d.kind === "tenant" && (
                <Section title="Onboarding (read now)">
                  {d.onboarding.error ? (
                    <Empty>{d.onboarding.error}</Empty>
                  ) : !d.onboarding.supported ? (
                    <Empty>{d.onboarding.words || "This store has no onboarding steps."}</Empty>
                  ) : (
                    <ol className="space-y-2 text-[0.8125rem]">
                      {d.onboarding.steps.map((s, i) => (
                        <li key={s.id}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              {i + 1}. {s.label}
                            </span>
                            <Badge variant={s.state === "done" ? "success" : s.state === "blocked" ? "warning" : s.state === "in_progress" ? "info" : "muted"}>{STEP_STATE_WORDS[s.state] || s.state}</Badge>
                          </div>
                          {s.problem && <p className="text-xs text-warning-text">{s.problem}</p>}
                        </li>
                      ))}
                    </ol>
                  )}
                </Section>
              )}

              {d.kind === "tenant" && (
                <Section title="Team">
                  {d.members.length ? (
                    <ul className="space-y-1 text-[0.8125rem]">
                      {d.members.map((m) => (
                        <li key={`${m.email}-${m.role}`} className="flex justify-between gap-2">
                          <span className="min-w-0 truncate" title={m.email}>{m.name ? `${m.name}, ` : ""}{m.email}</span>
                          <span className="shrink-0 text-muted-foreground">{ROLE_WORDS[m.role] || m.role}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty>No one on the team yet.</Empty>
                  )}
                  {d.invites.length > 0 && (
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {d.invites.map((i) => (
                        <li key={`${i.email}-${i.expiresAt}`}>
                          Invited {i.email} as {(ROLE_WORDS[i.role] || i.role).toLowerCase()}, until {when(i.expiresAt)}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              )}

              <Section title="Mail">
                {d.mail.length ? (
                  <ul className="space-y-1 text-[0.8125rem]">
                    {d.mail.map((m, i) => (
                      <li key={i} className="flex flex-wrap justify-between gap-2">
                        <span>
                          {MAIL_KIND_WORDS[m.kind] || m.kind} to <span className="break-all">{m.recipient}</span>
                        </span>
                        <span className={m.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                          {MAIL_STATUS_WORDS[m.status] || m.status}, {when(m.at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>No mail yet.</Empty>
                )}
              </Section>

              {d.kind === "tenant" && d.grants.length > 0 && (
                <Section title="Support access">
                  <ul className="space-y-1 text-[0.8125rem]">
                    {d.grants.map((g) => (
                      <li key={g.id}>
                        {g.reason} <span className="text-muted-foreground">· {g.revokedAt ? `closed ${when(g.revokedAt)}` : `until ${when(g.until)}`}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section title="Notes">
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act("note", { text: note }, "Note added.").then((b) => b && setNote(""));
                  }}
                >
                  <Label htmlFor="op-note" className="sr-only">
                    New note
                  </Label>
                  <Textarea id="op-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="What you tried, what the founder said" />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground tabular-nums">{note.length}/1000</span>
                    <Button type="submit" size="sm" variant="outline" disabled={busy != null || !note.trim()}>
                      Add note
                    </Button>
                  </div>
                </form>
                {d.notes.length ? (
                  <ul className="space-y-2">
                    {d.notes.map((n) => (
                      <li key={n.id} className="rounded-md bg-muted px-3 py-2 text-[0.8125rem]">
                        <p className="whitespace-pre-wrap break-words">{n.text}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {n.operator} · {when(n.at)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>No notes yet.</Empty>
                )}
              </Section>

              <Section title="Recent activity">
                {d.audit.length ? (
                  <ul className="space-y-1 text-xs">
                    {d.audit.map((x, i) => (
                      <li key={i} className="flex flex-wrap justify-between gap-2">
                        <span className="font-mono">{x.action}</span>
                        <span className="text-muted-foreground">
                          {ACTOR_KIND_WORDS[x.actorKind] || x.actorKind} {x.actor}, {when(x.at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>Nothing recorded yet.</Empty>
                )}
              </Section>
            </>
          )}
        </div>
      </SheetContent>

      <AlertDialog open={releaseOpen} onOpenChange={setReleaseOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Free {d?.signup?.address}?</AlertDialogTitle>
            <AlertDialogDescription>This signup has lapsed. Freeing its address lets anyone sign up with it. The signup can&apos;t be resumed afterwards.</AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-[0.8125rem]">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="size-4 accent-primary" />
            Email the founder a note to start again
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it held</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => act("release", { notify }, (b) => (b.notified ? "Address freed. The founder was emailed." : "Address freed."))}
            >
              Free the address
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent data-cancel-dialog className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <Ban aria-hidden />
            </AlertDialogMedia>
            <AlertDialogTitle>Cancel setting up {d?.signup?.storeName}?</AlertDialogTitle>
            <AlertDialogDescription>The founder hasn&apos;t been invited yet, and won&apos;t be. This setup can&apos;t be resumed: to set the store up later, create it again with New store.</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-2 text-[0.8125rem]" aria-label="What cancelling does">
            <li className="flex gap-2">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground" />
              <span>
                The address <span className="font-mono break-all">{d?.signup?.address}</span> and the Shopify store become free for another store.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground" />
              <span>The Shopify app&apos;s client secret is deleted.</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground" />
              <span className="text-muted-foreground">A database already made stays at the hosting provider. Remove it there if you need to.</span>
            </li>
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the setup</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => act("cancel_store", {}, () => "Store setup cancelled. Its address and Shopify store are free.")}>
              Cancel the setup
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
