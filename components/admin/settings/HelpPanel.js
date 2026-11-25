"use client";

import { Copy, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/kit/toast";
import { ReadState, useRead } from "@/components/admin/settings/SaveBar";

// Settings → Help (Phase 2 line 7): the diagnostics a founder can copy into a
// message to Storeasy's team, from GET /api/admin/help. They are status flags
// and counts only, never shopper data or a secret, and nothing is sent by
// itself: the founder sees it and sends it.
export function HelpPanel() {
  const toast = useToast();
  const read = useRead("/api/admin/help");
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Diagnostics copied");
    } catch {
      toast.error("Couldn't copy. Select the text instead.");
    }
  }
  return (
    <Card data-settings-tab="help">
      <CardHeader>
        <CardTitle className="text-base font-semibold">Get help</CardTitle>
        <CardDescription>
          Stuck? Email Storeasy's team and paste these diagnostics into your message. They show what this page shows: settings that are on or off and counts, never shopper details.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ReadState read={read} lines={6}>
          {(d) => {
            const text = JSON.stringify(d.diagnostics, null, 2);
            return (
              <>
                <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed">{text}</pre>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => copy(text)} data-read-control>
                    <Copy aria-hidden />
                    Copy diagnostics
                  </Button>
                  <Button asChild variant="outline">
                    <a href="mailto:support@storeasy.app?subject=Help%20with%20my%20store" data-read-control>
                      <Mail aria-hidden />
                      Email Storeasy's team
                    </a>
                  </Button>
                </div>
              </>
            );
          }}
        </ReadState>
      </CardContent>
    </Card>
  );
}
