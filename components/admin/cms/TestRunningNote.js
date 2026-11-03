import Link from "next/link";
import { Banner } from "@/components/console/Banner";

// PV-08: beside a section's settings in the Designer, when a running test
// changes that section. `test` is { slug, name } from runningTestsBySection.
// The preview never shows the test's version, so this says so in plain words
// and links to the test's row on the Experiments screen.
export function TestRunningNote({ test }) {
  if (!test) return null;
  return (
    <Banner tone="info" title="A test is running on this section">
      <p>
        It's called “{test.name}”. Some visitors see a different version; the preview shows yours.{" "}
        <Link href={`/admin/experiments#exp-${test.slug}`} className="font-semibold underline">
          See the test
        </Link>
      </p>
    </Banner>
  );
}
