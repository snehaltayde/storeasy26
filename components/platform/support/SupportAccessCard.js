"use client";

// Phase 3 line 5: support access on an operator's store page (the StoreDetail
// anchor). Open access (a reason of at least 5 characters, 1, 4, 8, 24 or 72
// hours; the store's owners and admins are emailed, and the card says when
// mail is off), the open grant (until when, by whom, why) with Enter store
// console (read-only) and Close now, and the last 20 grants. `initial` is the
// store page's support summary, shown until /api/platform/support?view=store
// answers. The onboarding sheet's own open and close actions are unchanged.
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { when } from "@/components/platform/stores/storesWords";
import { EnterConsole } from "./EnterConsole";
import { STATE_WORDS, SUPPORT_HOURS, hoursLabel, supportApi } from "./supportApi";

const selectClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-muted px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const mailWords = (m) => {
  if (!m) return null;
  if (!m.configured) return "Email is off on this server, so the store's owners and admins were not emailed. They see the banner in their console.";
  if (m.failed) return `The email to ${m.failed} owner or admin address${m.failed === 1 ? "" : "es"} didn't go out. They see the banner in their console.`;
  return m.sent ? `The store's owners and admins were emailed (${m.sent}).` : "The store has no owner or admin to email yet.";
};

const SHOWN = 5;

function HistoryRow({ h }) {
  const w = STATE_WORDS[h.state] || STATE_WORDS.closed;
  return (
    <li className="space-y-1 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{h.operatorName}</span>
          <Badge variant={w.tone}>{w.label}</Badge>
        </p>
        <p className="break-words text-muted-foreground">{h.reason}</p>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        <span className="block">Opened {when(h.openedAt)}</span>
        {h.state === "open" && <span className="block">Until {when(h.expiresAt)}</span>}
        {h.state === "closed" && <span className="block">Closed {when(h.endedAt)}{h.endedBy ? ` by ${h.endedBy}` : ""}</span>}
        {h.state === "expired" && <span className="block">Expired {when(h.endedAt)}</span>}
      </p>
    </li>
  );
}

export function SupportHistory({ history }) {
  const [all, setAll] = useState(false);
  if (!history?.length) return <p className="text-muted-foreground">No support access yet.</p>;
  const shown = all ? history : history.slice(0, SHOWN);
  return (
    <>
      <ul className="divide-y divide-border" data-support="history" id="store-support-history">
        {shown.map((h) => (
          <HistoryRow key={h.id} h={h} />
        ))}
      </ul>
      {history.length > SHOWN && (
        <Button type="button" variant="ghost" size="sm" className="-ml-2" aria-expanded={all} aria-controls="store-support-history" onClick={() => setAll((x) => !x)}>
          {all ? "Show fewer" : `Show all ${history.length}`}
        </Button>
      )}
    </>
  );
}

const HistorySkeleton = () => (
  <div aria-busy="true" aria-label="Loading the last 20 grants" className="space-y-3 py-2">
    {[0, 1, 2].map((i) => (
      <div key={i} className="space-y-1.5">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3.5 w-3/4" />
      </div>
    ))}
  </div>
);

function Fact({ label, children }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export default function SupportAccessCard({ storeId, initial }) {
  const [view, setView] = useState(() => ({
    open: initial?.open ? { id: null, operatorName: initial.operatorName, reason: initial.reason, openedAt: initial.since, expiresAt: initial.expiresAt } : null,
    history: null,
    mail: null,
  }));
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const reasonField = useRef(null);
  const closed = useRef(false);

  const load = useCallback(async () => {
    try {
      const json = await supportApi("GET", null, `?view=store&tenant=${encodeURIComponent(storeId)}`);
      setView({ open: json.open, history: json.history, mail: json.mail });
      setLoadFailed(false);
    } catch (e) {
      setError(e.message);
      setLoadFailed(true);
    }
  }, [storeId]);
  useEffect(() => {
    load();
  }, [load]);

  const tooShort = reason.trim().length < 5;
  async function openAccess(e) {
    e.preventDefault();
    if (tooShort) return setError("Give a reason of at least 5 characters.");
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const json = await supportApi("POST", { action: "grant", tenant: storeId, reason: reason.trim(), hours });
      setReason("");
      setNotice(mailWords(json.mail));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function closeNow() {
    if (!view.open?.id) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await supportApi("POST", { action: "revoke", id: view.open.id });
      closed.current = true;
      setNotice("Support access is closed. Any open support session on the store ended with it.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setConfirmClose(false);
    }
  }

  return (
    <Card data-card="support">
      <CardHeader>
        <CardTitle>Support access</CardTitle>
        <CardDescription>Read-only access to the store's console, with customer contact details hidden. The store's team sees a banner while it is open.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 text-sm">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert variant="info" role="status">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        {view.open ? (
          <div className="space-y-4 rounded-card border border-info/30 bg-info/5 p-4" data-support="open">
            <dl className="space-y-2">
              <Fact label="Status">
                <Badge variant="info">Open until {when(view.open.expiresAt)}</Badge>
              </Fact>
              <Fact label="Opened by">{view.open.operatorName}</Fact>
              {view.open.openedAt && <Fact label="Opened">{when(view.open.openedAt)}</Fact>}
              <Fact label="Reason">{view.open.reason}</Fact>
            </dl>
            <div className="flex flex-wrap gap-2 border-t border-info/20 pt-4">
              <EnterConsole storeId={storeId} onError={setError} />
              <Button type="button" variant="destructive" disabled={busy || !view.open.id} onClick={() => setConfirmClose(true)} data-support="close">
                Close now
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={openAccess} className="space-y-4" data-support="open-form" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="support-reason">Reason</Label>
              <Input
                id="support-reason"
                ref={reasonField}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={300}
                placeholder="What you need to look at, in a few words"
                aria-describedby="support-reason-help"
                aria-invalid={error && tooShort ? true : undefined}
              />
              <p id="support-reason-help" className="text-xs text-muted-foreground">
                At least 5 characters. The store's team sees it.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-40 space-y-1.5">
                <Label htmlFor="support-hours">For</Label>
                <select id="support-hours" className={selectClass} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                  {SUPPORT_HOURS.map((h) => (
                    <option key={h} value={h}>
                      {hoursLabel(h)}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" disabled={busy} data-support="open-access">
                {busy ? "Opening…" : "Open access"}
              </Button>
            </div>
            {view.mail === false && <p className="text-xs text-muted-foreground">Email is off on this server: the store's owners and admins won't be emailed, only shown the banner.</p>}
          </form>
        )}

        <div className="space-y-1">
          <h3 className="text-sm font-medium">History</h3>
          {view.history ? (
            <SupportHistory history={view.history} />
          ) : loadFailed ? (
            <p className="text-muted-foreground">
              The history didn't load.{" "}
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={load}>
                Try again
              </Button>
            </p>
          ) : (
            <HistorySkeleton />
          )}
        </div>
      </CardContent>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            // Close now is gone once access closes: focus moves to the Reason field
            if (!closed.current) return;
            closed.current = false;
            e.preventDefault();
            reasonField.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Close support access now?</AlertDialogTitle>
            <AlertDialogDescription>Anyone in the store's console under this access is signed out of it on their next click.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it open</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                closeNow();
              }}
            >
              {busy ? "Closing…" : "Close now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
