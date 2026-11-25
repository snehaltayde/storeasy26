import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ACTION_WORDS, shortDate } from "@/components/admin/apps/app-words";

// This install's audit rows (owner and admin: audit.read), newest first:
// what happened, who did it and when. Never drawn for other roles.
export function AppActivity({ rows }) {
  return (
    <Card data-apps="activity">
      <CardHeader>
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <ol className="divide-y divide-border text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2" data-activity={r.action}>
                <span className="min-w-0 text-foreground">
                  {ACTION_WORDS[r.action] || r.action}
                  <span className="text-muted-foreground">{` by ${r.who}`}</span>
                </span>
                <time dateTime={r.at} className="shrink-0 tabular-nums text-muted-foreground">
                  {shortDate(r.at)}
                </time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing has happened to this app yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
