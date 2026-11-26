import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/kit/empty-state";
import { fmtDate } from "@/components/admin/media/media-words";

// The last 30 copilot runs (Phase 9 line 5): task, who, when, tokens and a link
// to each draft it made. Links are reads (data-read-control); no copy shown.
const STATUS = { settled: null, reserved: ["Running", "info"], failed: ["Didn't finish", "muted"] };

export function RunHistory({ history }) {
  if (!history?.length) return <EmptyState title="No runs yet." description="Each run is listed here with the drafts it made." />;
  return (
    <ul className="divide-y rounded-lg border" data-copilot-history={history.length}>
      {history.map((r) => (
        <li key={r.id} className="flex flex-col gap-1 p-3 text-sm" data-copilot-run-row={r.task}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{r.label}</span>
            {STATUS[r.status] ? <Badge variant={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge> : null}
            <span className="text-muted-foreground">
              {r.by} · {fmtDate(r.createdAt)} · {Number(r.tokens || 0).toLocaleString("en-IN")} tokens
            </span>
          </div>
          {r.refs?.length ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {r.refs.map((ref) => (
                <Link key={`${ref.kind}:${ref.id}`} href={ref.href} data-read-control className="text-primary underline-offset-4 hover:underline">
                  {ref.label}
                </Link>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
