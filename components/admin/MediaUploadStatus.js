"use client";

import { LoaderCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { progressLabel } from "@/lib/media-upload-plan";

// What the founder sees while an image is on its way (MED-01), in the image
// picker. `progress` comes from uploadImage. On components/ui since Phase 2
// line 11.
export function MediaUploadStatus({ progress }) {
  if (!progress) return null;
  return (
    <Alert variant="info" role="status" aria-live="polite">
      <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
      <AlertDescription className="text-current">{progressLabel(progress)}</AlertDescription>
    </Alert>
  );
}
