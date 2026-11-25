"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { AppRefusal } from "@/components/admin/apps/AppRefusal";
import { NO_MANAGE, postApp } from "@/components/admin/apps/app-words";

// Turn off (keeps settings, stops everything the app does), Turn on (refused
// while Storeasy has it turned off) and Uninstall (archives the install; a
// later install starts fresh). Each behind an AlertDialog in plain words.
const WORDS = (name) => ({
  disable: {
    title: `Turn off ${name}?`,
    body: `${name} stops at once: nothing it adds shows on your store. Its settings are kept, and you can turn it on again at any time.`,
    go: "Turn off",
    busy: "Turning off…",
    done: `${name} is off.`,
  },
  enable: {
    title: `Turn on ${name}?`,
    body: `${name} starts working again with the settings it had.`,
    go: "Turn on",
    busy: "Turning on…",
    done: `${name} is on.`,
  },
  uninstall: {
    title: `Uninstall ${name}?`,
    body: `${name} is removed from your store and its settings are cleared. If you install it again later, it starts fresh. Its history is kept.`,
    go: "Uninstall",
    busy: "Uninstalling…",
    done: `${name} was uninstalled.`,
  },
});

export function AppDangerZone({ install, role, onChanged }) {
  const router = useRouter();
  const toast = useToast();
  const [asking, setAsking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const words = WORDS(install.name);
  const toggle = install.status === "enabled" ? "disable" : "enable";
  const open = (what) => {
    setError(null);
    setAsking(what);
  };
  async function go() {
    setBusy(true);
    const r = await postApp(`apps/${encodeURIComponent(install.id)}`, { [asking]: true });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast.success(words[asking].done);
    const what = asking;
    setAsking(null);
    if (what === "uninstall") {
      router.push("/admin/apps");
      router.refresh();
    } else onChanged(r.install);
  }
  const blockedOn = toggle === "enable" && install.killed;
  return (
    <Card data-apps="danger-zone" className="border-destructive/30">
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>Turning an app off keeps its settings. Uninstalling clears them.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {blockedOn ? (
          <Button type="button" variant="outline" disabled data-apps-action="enable">
            Turn on
          </Button>
        ) : (
          <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
            <Button type="button" variant="outline" data-apps-action={toggle} onClick={() => open(toggle)}>
              {words[toggle].go}
            </Button>
          </RoleGate>
        )}
        <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
          <Button type="button" variant="destructive" data-apps-action="uninstall" onClick={() => open("uninstall")}>
            Uninstall
          </Button>
        </RoleGate>
      </CardContent>
      <AlertDialog open={Boolean(asking)} onOpenChange={(v) => !v && !busy && setAsking(null)}>
        <AlertDialogContent data-apps="confirm">
          {asking && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{words[asking].title}</AlertDialogTitle>
                <AlertDialogDescription>{words[asking].body}</AlertDialogDescription>
              </AlertDialogHeader>
              <AppRefusal>{error}</AppRefusal>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <Button type="button" variant={asking === "enable" ? "default" : "destructive"} disabled={busy} onClick={go} data-apps="confirm-go">
                  {busy ? words[asking].busy : words[asking].go}
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
