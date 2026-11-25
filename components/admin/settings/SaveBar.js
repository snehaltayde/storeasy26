"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { useLeaveGuard } from "@/components/admin/offers/ConfirmAction";

// Every settings tab's save (Phase 2 line 7). A tab sends only its own
// section to PUT /api/admin/settings (buildSettingsPatch touches only the
// sections present), so two admins on different tabs never overwrite each
// other. The form state is derived from the server's view with toState; the
// tab is dirty while the state differs from the last saved view. A refusal
// keeps everything typed and shows the server's words; leaving with unsaved
// changes asks first (useLeaveGuard).
//   initial   the page's slice of settingsView (no secret values: has_* flags)
//   toState   view -> the form's state (secret fields always "")
//   toBody    state -> the PUT body (only this tab's sections)
export function useSettingsSection({ initial, toState, toBody, saved = "Saved. Your store uses it within a minute." }) {
  const toast = useToast();
  const [view, setView] = useState(initial);
  const [state, setState] = useState(() => toState(initial));
  const [errors, setErrors] = useState(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(state) !== JSON.stringify(toState(view));
  useLeaveGuard(dirty && !busy);

  // body: send this instead of toBody(state) (Shipping's "Keep these rates")
  async function save(e, body = null) {
    e?.preventDefault?.();
    if (busy) return;
    setBusy(true);
    setErrors(null);
    let res = null;
    let data = {};
    try {
      res = await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? toBody(state, view)) });
      data = await res.json().catch(() => ({}));
    } catch {
      res = null;
    }
    if (res?.ok && data.ok) {
      setView((v) => ({ ...v, ...data.settings }));
      setState(toState({ ...view, ...data.settings }));
      toast.success(data.passwordRotated ? "Saved. The sign-in password changed and every other session is signed out." : saved);
    } else if (!res) {
      setErrors(["That didn't go through. Check your connection and try again; what you typed is still here."]);
    } else {
      setErrors(data.errors?.length ? data.errors : [data.error || "That didn't save. Try again; what you typed is still here."]);
    }
    setBusy(false);
  }
  const discard = () => {
    setState(toState(view));
    setErrors(null);
  };
  return { view, state, setState, dirty, busy, errors, save, discard, readOnly: Boolean(view?.readOnly) };
}

// The sticky Save / Discard bar under a tab, shown while the tab has unsaved
// changes or a refusal to show. label says what Save does ("Save shipping").
export function SaveBar({ form, role, label }) {
  const { dirty, busy, errors, discard, readOnly } = form;
  if (readOnly || (!dirty && !errors)) return null;
  return (
    <div data-settings="save-bar" className="sticky bottom-4 z-10 mt-6 space-y-2">
      {errors && (
        <Alert variant="destructive" className="shadow-overlay">
          <AlertTitle>That didn't save</AlertTitle>
          <AlertDescription>
            {errors.map((t, i) => (
              <p key={i}>{t}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}
      {dirty && (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-card px-4 py-3 shadow-overlay" role="region" aria-label="Unsaved changes">
          <p className="flex min-w-0 basis-full items-center gap-2 text-sm font-medium text-foreground sm:flex-1 sm:basis-auto">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
            You have unsaved changes
          </p>
          <Button type="button" variant="outline" className="flex-1 sm:flex-none" onClick={discard} disabled={busy}>
            Discard
          </Button>
          <RoleGate role={role} action="settings.write" reason="Only the owner or an admin can change settings.">
            <Button type="submit" className="flex-1 sm:flex-none" disabled={busy}>
              {busy ? "Saving…" : label}
            </Button>
          </RoleGate>
        </div>
      )}
    </div>
  );
}

// The note a store on environment config gets (no control-plane row to save to).
export function ReadOnlyNote({ form }) {
  if (!form.readOnly) return null;
  return (
    <Alert variant="info" className="mb-4">
      <AlertTitle>These settings can't be changed here</AlertTitle>
      <AlertDescription>This store runs on the server's own configuration, so there is nothing to save to.</AlertDescription>
    </Alert>
  );
}

// A tab that reads its data in the browser (domains, privacy, audit, help):
// GET url → { data, error, reload, setData }. error is plain words.
export function useRead(url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) setData(json);
      else setError(res.status === 403 ? "Your role can't open this." : "We couldn't load this just now.");
    } catch {
      setError("We couldn't load this. Check your connection.");
    }
  }, [url]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, reload, setData };
}

// Loading (skeleton lines), error (words and Try again, a re-read) or the data.
export function ReadState({ read, lines = 3, children }) {
  if (read.error) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-border px-4 py-3 text-sm" role="alert">
        <span className="flex-1">{read.error}</span>
        <Button type="button" variant="outline" size="sm" onClick={read.reload} data-read-control>
          Try again
        </Button>
      </div>
    );
  }
  if (!read.data) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  }
  return children(read.data);
}
