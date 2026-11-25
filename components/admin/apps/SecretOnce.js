"use client";

import { useEffect, useRef } from "react";
import { KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CopyButton } from "@/components/kit/copy-button";

// A webhook signing secret, shown once (Phase 4 line 3): after create and
// after Rotate. Storeasy keeps it encrypted and never shows it again, so the
// words say to copy it now. The secret lives only in this component's props.
export function SecretOnce({ secret, rotatedUntil = null }) {
  const ref = useRef(null);
  // a rotated secret lands below the card's actions: bring it into view
  useEffect(() => {
    if (secret) ref.current?.scrollIntoView({ block: "nearest" });
  }, [secret]);
  if (!secret) return null;
  return (
    <div ref={ref} className="scroll-mb-6 space-y-2" data-apps="secret-once">
      <Alert variant="warning">
        <KeyRound aria-hidden="true" />
        <AlertTitle>Copy the signing secret now</AlertTitle>
        <AlertDescription>
          {rotatedUntil
            ? "You won't see it again after you leave this page. For the next 24 hours each webhook is signed with both the new and the old secret, so you can switch your app over without missing events."
            : "You won't see it again after you close this. Your app uses it to check that each webhook really came from your store."}
        </AlertDescription>
      </Alert>
      <CopyButton value={secret} label="the signing secret" id="webhook-secret" />
    </div>
  );
}
