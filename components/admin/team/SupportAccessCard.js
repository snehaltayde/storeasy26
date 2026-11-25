"use client";

// Phase 3 line 5 (decision 5): the "Support access" card on Settings, Team, for
// owners and admins. The open grant (which Storeasy operator, why, until when)
// with "End support access now" (team.manage), and the last 20 grants
// (audit.read). Ending it signs the operator out of this store's console on
// their next click. `initial` is lib/platform/support.js supportAccessView()
// from the server; ending answers with the fresh view.
import { useState } from "react";
import { ShieldAlert } from "lucide-react";
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

const STATE = { open: ["Open", "info"], closed: ["Closed", "muted"], expired: ["Expired", "muted"] };
const when = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
};

export function SupportAccessCard({ initial, canEnd = false }) {
  const [view, setView] = useState(initial);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

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
  return (
    <Card data-team="support-access" className="mt-6">
      <CardHeader>
        <CardTitle>Support access</CardTitle>
        <CardDescription>When Storeasy's team helps with your store, they open read-only access for a set time. It can't change anything and never sees customer contact details.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <Refusal>{error}</Refusal>
        {done && !open && <p role="status">Support access has ended.</p>}
        {open ? (
          <div className="space-y-3 rounded-card border border-warning/40 bg-warning/10 p-3 text-warning-text" data-support="open">
            <p className="flex items-center gap-2 font-medium">
              <ShieldAlert aria-hidden className="size-4" /> Open until {when(open.expiresAt)}
            </p>
            <p>
              {open.operatorName} from Storeasy, reason: “{open.reason}”
            </p>
            {canEnd && (
              <Button type="button" variant="destructive" onClick={() => setConfirm(true)} disabled={busy} data-support="end">
                End support access now
              </Button>
            )}
          </div>
        ) : (
          !done && <p className="text-muted-foreground">Support access is not open.</p>
        )}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">The last 20 times</h3>
          {view.history?.length ? (
            <ul className="divide-y divide-border" data-support="history">
              {view.history.map((h) => (
                <li key={h.id} className="space-y-0.5 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{h.operatorName}</span>
                    <Badge variant={(STATE[h.state] || STATE.closed)[1]}>{(STATE[h.state] || STATE.closed)[0]}</Badge>
                  </div>
                  <p className="break-words">{h.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    Opened {when(h.openedAt)}
                    {h.state === "open" && ` · until ${when(h.expiresAt)}`}
                    {h.state === "closed" && ` · ended ${when(h.endedAt)}${h.endedBy ? ` by ${h.endedBy}` : ""}`}
                    {h.state === "expired" && ` · ran out ${when(h.endedAt)}`}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Storeasy's team hasn't had support access to this store.</p>
          )}
        </div>
      </CardContent>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
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
