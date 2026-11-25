import Link from "next/link";
import { cn } from "@/components/ui/utils";
import { RANGES, rangeHref } from "@/lib/admin/dashboard-ranges";

// The dashboard's date range, 7 / 30 / 90 days through ?days= (30 is the
// plain /admin/dashboard). Links, so support can use them: each is a read.

export function RangeSwitch({ days }) {
  return (
    <nav aria-label="Date range" className="inline-flex rounded-md border border-border bg-card p-0.5">
      {RANGES.map((r) => (
        <Link
          key={r}
          href={rangeHref(r)}
          data-read-control
          aria-current={days === r ? "page" : undefined}
          className={cn(
            "inline-flex h-7 items-center rounded-[4px] px-2.5 text-[0.8125rem] font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card focus-visible:outline-none pointer-coarse:h-10",
            days === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {r} days
        </Link>
      ))}
    </nav>
  );
}
