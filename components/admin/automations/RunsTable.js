"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";

// The latest automation runs (lib/automations.js automationRuns): what each
// rule did with each order, in words, and Retry on a failed one. Admins and
// owners only (the page shows this to no one else).
//   role, runs, rules (for names), onRetry(run) -> Promise, retrying (run id)
export const RUN_STATUS = { done: ["Sent", "success"], failed: ["Failed", "danger"], skipped: ["Skipped", "muted"], pending: ["Running", "info"], dry_run: ["Dry run", "info"] };
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Not known" : d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
};

export function RunsTable({ role, runs, rules, onRetry, retrying = null }) {
  const names = Object.fromEntries((rules || []).map((r) => [r.id, r.name]));
  return (
    <DataTable
      label="Recent runs"
      rows={runs}
      rowKey={(r) => r.id}
      columns={[
        {
          key: "status",
          header: "Result",
          cell: (r) => {
            const [label, tone] = RUN_STATUS[r.status] || ["Unknown", "muted"];
            return <Badge variant={tone}>{label}</Badge>;
          },
        },
        { key: "rule", header: "Rule", truncate: true, cell: (r) => names[r.automation_id] || "A removed rule" },
        { key: "reason", header: "What happened", truncate: true, cell: (r) => r.reason || "" },
        { key: "created_at", header: "When", cell: (r) => when(r.created_at) },
      ]}
      rowActions={(r) =>
        r.status === "failed" ? (
          <RoleGate role={role} action="settings.write" mode="hide">
            <Button type="button" variant="outline" size="sm" disabled={retrying === r.id} onClick={() => onRetry(r)}>
              {retrying === r.id ? "Retrying…" : "Retry"}
            </Button>
          </RoleGate>
        ) : null
      }
      empty={<EmptyState title="No runs yet." description="Each time a rule is set off, what it did shows here." className="py-6" />}
    />
  );
}
