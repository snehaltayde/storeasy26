import { ExternalLink } from "lucide-react";
import { Banner } from "@/components/console/Banner";

// PV-08: beside a section's settings in the Designer, when a running test
// changes that section. `test` is { slug, name } from runningTestsBySection.
// The preview never shows the test's version, so this says so in plain words
// and links to the test's row on the Experiments screen. The link sits above
// the fields being edited, so it opens a new tab: the Designer, unsaved edits
// included, stays as it was (useDirtyGuard only covers leaving the page).
export function TestRunningNote({ test }) {
  if (!test) return null;
  return (
    <Banner tone="info" title="A test is running on this section">
      <p>
        It's called “{test.name}”. Some visitors see a different version; the preview shows yours.{" "}
        <a
          href={`/admin/experiments#exp-row-${test.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-semibold underline"
        >
          See the test
          <ExternalLink size={12} aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </p>
    </Banner>
  );
}
