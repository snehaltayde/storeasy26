"use client";

// Phase 3 line 5 (decision 5): the "Support access" card on Settings, Team, for
// owners and admins. The open grant (which Storeasy operator, why, until when)
// with "End support access now" (team.manage), and the last 20 grants
// (audit.read). Ending it signs the operator out of this store's console on
// their next click. `initial` is lib/platform/support.js supportAccessView()
// from the server; ending answers with the fresh view.
//
// Design (docs/UI.md, Team): the open grant is the one thing to see, a warning
// strip that answers who, until when and why in three labelled rows, with the
// one destructive button under them. Closed, the card says so in one line. The
// history is a quiet list, five shown, the rest behind "Show all".
import { useRef, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Refusal } from "@/components/admin/team/Refusal";
import { supportTime } from "@/components/admin/team/team-words";

const STATE = { open: ["Open", "info"], closed: ["Closed", "muted"], expired: ["Expired", "muted"] };
const SHOWN = 5;

function Fact({ label, children }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[6rem_1fr] sm:gap-4">
      <dt className="text-warning-text">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

function HistoryRow({ h }) {
  const [label, tone] = STATE[h.state] || STATE.closed;
  return (
    <li className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{h.operatorName}</span>
          <Badge variant={tone}>{label}</Badge>
        </p>
        <p className="break-words text-muted-foreground">{h.reason}</p>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums sm:text-right">
        <span className="block">Opened {supportTime(h.openedAt)}</span>
        {h.state === "open" && <span className="block">Until {supportTime(h.expiresAt)}</span>}
        {h.state === "closed" && <span className="block">Ended {supportTime(h.endedAt)}{h.endedBy ? ` by ${h.endedBy}` : ""}</span>}
        {h.state === "expired" && <span className="block">Ran out {supportTime(h.endedAt)}</span>}
      </p>
    </li>
  );
}

export function SupportAccessCard({ initial, canEnd = false }) {
  const [view, setView] = useState(initial);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [all, setAll] = useState(false);
  const statusLine = useRef(null);

  async function end() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/support-access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "end" }) });
      const json = await res.json().catch(() => ({}));
      if (json?.history) setView({ open: json.open ?? null, history: json.history });
      if (res.ok && json.ok) setDone(true);
      else setError(json?.error || "That didn't work. Try again.");
    } catch {
      setError("That didn't work. Check your connection and try again.");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  if (!view) return null;
  const open = view.open;
  const history = view.history || [];
  const shown = all ? history : history.slice(0, SHOWN);
  return (
    <Card data-team="support-access" className="mt-6">
      <CardHeader>
        <CardTitle>Support access</CardTitle>
        <CardDescription>When Storeasy's team helps with your store, they open read-only access for a set time. It can't change anything and never sees customer contact details.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 text-sm">
        <Refusal>{error}</Refusal>
        {open ? (
          <section aria-labelledby="support-open-title" className="space-y-4 rounded-card border border-warning/40 bg-warning/10 p-4" data-support="open">
            <h3 id="support-open-title" className="flex items-center gap-2 text-base font-medium text-warning-text">
              <ShieldAlert aria-hidden className="size-4 shrink-0" /> Storeasy can see your store right now
            </h3>
            <dl className="space-y-2">
              <Fact label="Who">{open.operatorName} from Storeasy</Fact>
              <Fact label="Until">
                <span className="tabular-nums">{supportTime(open.expiresAt)}</span>
                <span className="text-muted-foreground">, then it closes by itself</span>
              </Fact>
              <Fact label="Why">“{open.reason}”</Fact>
            </dl>
            {canEnd ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-warning/30 pt-4">
                <Button type="button" variant="destructive" onClick={() => setConfirm(true)} disabled={busy} data-support="end">
                  End support access now
                </Button>
                <p className="text-xs text-muted-foreground">They're signed out on their next click.</p>
              </div>
            ) : (
              <p className="border-t border-warning/30 pt-4 text-xs text-muted-foreground">An owner or admin can end it here.</p>
            )}
          </section>
        ) : (
          <p ref={statusLine} tabIndex={-1} className="flex items-center gap-2 rounded-card border border-border bg-muted px-4 py-3 outline-none" role={done ? "status" : undefined}>
            <ShieldCheck aria-hidden className="size-4 shrink-0 text-success" />
            {done ? "Support access has ended. No one from Storeasy can see your store." : "No one from Storeasy can see your store right now."}
          </p>
        )}
        <div className="space-y-1">
          <h3 className="text-sm font-medium">The last 20 times</h3>
          {history.length ? (
            <>
              <ul className="divide-y divide-border" data-support="history" id="support-history">
                {shown.map((h) => (
                  <HistoryRow key={h.id} h={h} />
                ))}
              </ul>
              {history.length > SHOWN && (
                <Button type="button" variant="ghost" size="sm" className="-ml-2" aria-expanded={all} aria-controls="support-history" onClick={() => setAll((a) => !a)}>
                  {all ? "Show fewer" : `Show all ${history.length}`}
                </Button>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">Storeasy's team hasn't had support access to this store.</p>
          )}
        </div>
      </CardContent>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            // the button is gone once access ends: focus lands on the line that says so
            if (!statusLine.current) return;
            e.preventDefault();
            statusLine.current.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>End support access now?</AlertDialogTitle>
            <AlertDialogDescription>{open ? `${open.operatorName} is signed out of your console on their next click. Storeasy can open it again if you ask for help.` : "Support access isn't open."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it open</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                end();
              }}
            >
              {busy ? "Ending…" : "End support access now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
