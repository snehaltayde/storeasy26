"use client";

import { Loader2 } from "lucide-react";
import { Banner } from "@/components/console/Banner";
import { progressLabel } from "@/lib/media-upload-plan";

// What the founder sees while an image is on its way (MED-01), in both the
// media library and the image picker. `progress` comes from uploadImage.
export function MediaUploadStatus({ progress }) {
  if (!progress) return null;
  return (
    <div role="status" aria-live="polite">
      <Banner tone="info">
        <span className="inline-flex items-center gap-2">
          <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden />
          {progressLabel(progress)}
        </span>
      </Banner>
    </div>
  );
}
