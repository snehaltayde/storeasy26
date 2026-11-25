"use client";

import { KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CopyButton } from "@/components/kit/copy-button";

// A webhook signing secret, shown once (Phase 4 line 3): after create and
// after Rotate. Storeasy keeps it encrypted and never shows it again, so the
// words say to copy it now. The secret lives only in this component's props.
export function SecretOnce({ secret, rotatedUntil = null }) {
  if (!secret) return null;
  return (
    <div className="space-y-2" data-apps="secret-once">
      <Alert variant="warning">
        <KeyRound aria-hidden="true" />
        <AlertTitle>Copy the signing secret now</AlertTitle>
        <AlertDescription>
          {rotatedUntil
            ? "This is the only time it's shown. For the next 24 hours each webhook is signed with both the new and the old secret, so you can switch your app over without missing events."
            : "This is the only time it's shown. Your app uses it to check that each webhook really came from your store."}
        </AlertDescription>
      </Alert>
      <CopyButton value={secret} label="the signing secret" id="webhook-secret" />
    </div>
  );
}
