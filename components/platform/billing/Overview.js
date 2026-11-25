"use client";

import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/kit/empty-state";
import { formatPaise } from "@/lib/platform/billing-money";
import { EXCEPTION_WORDS, UNCONFIGURED_WORDS, monthWords } from "./billingWords";
import { useBillingData } from "./useBillingData";

// Overview: MRR, gross / refunds / net by month, whether Razorpay is set up,
// and the exception queue, each row linking to its store's subscriptions (an
// event with no store links to the ledger's "no store" filter).
export default function Overview() {
  const { loading, error, data, reload } = useBillingData("/api/platform/billing");
  const live = (data?.tenants || []).filter((t) => ["active", "authenticated"].includes(t.status)).length;

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>We couldn&apos;t load billing</AlertTitle>
          <AlertDescription>
            {error}{" "}
            <Button variant="link" className="h-auto p-0" onClick={reload}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {data && !data.provider_configured && (
        <Alert>
          <AlertTriangle aria-hidden />
          <AlertTitle>Razorpay is not set up</AlertTitle>
          <AlertDescription>{UNCONFIGURED_WORDS}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Monthly recurring revenue" loading={!data} value={data && formatPaise(data.mrr)} />
        <Figure label="Paying or active subscriptions" loading={!data} value={data && String(live)} />
        <Figure label="Needs attention" loading={!data} value={data && String(data.exceptions.length)} tone={data?.exceptions.length ? "warning" : null} />
        <Figure
          label="Payment provider"
          loading={!data}
          value={
            data &&
            (data.provider_configured ? (
              <span className="inline-flex items-center gap-1.5 text-success">
                <CheckCircle2 className="size-4" aria-hidden /> Razorpay set up
              </span>
            ) : (
              <span className="text-warning-text">Not set up</span>
            ))
          }
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Exception queue</CardTitle>
          <Button variant="outline" size="sm" onClick={reload} disabled={loading} data-read-control>
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {!data ? (
            <Skeleton className="h-16" />
          ) : data.exceptions.length === 0 ? (
            <EmptyState title="Nothing needs attention." description="Payment trouble, stores past their grace period and events no store matched show up here." />
          ) : (
            <ul className="divide-y divide-border" aria-label="Exceptions">
              {data.exceptions.map((x, i) => (
                <li key={`${x.kind}-${x.tenant || ""}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  <Badge variant={x.kind === "past_grace" ? "danger" : "warning"}>{EXCEPTION_WORDS[x.kind] || x.kind}</Badge>
                  {x.tenant ? (
                    <a href={`/platform/billing?tab=subscriptions&store=${encodeURIComponent(x.tenant)}`} data-read-control className="font-medium underline-offset-4 hover:underline">
                      {x.tenant}
                    </a>
                  ) : (
                    <a href="/platform/billing?tab=events&store=orphan" data-read-control className="font-medium underline-offset-4 hover:underline">
                      Open in the ledger
                    </a>
                  )}
                  <span className="text-sm text-muted-foreground">{x.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Revenue by month</CardTitle>
        </CardHeader>
        <CardContent>
          {!data ? (
            <Skeleton className="h-24" />
          ) : data.revenue.length === 0 ? (
            <EmptyState title="No payments yet." description="Charges and refunds from Razorpay appear here month by month." />
          ) : (
            <Table aria-label="Revenue by month">
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Refunds</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.revenue.map((m) => (
                  <TableRow key={m.month}>
                    <TableCell>{monthWords(m.month)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatPaise(m.gross)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{m.refunds ? `−${formatPaise(m.refunds)}` : formatPaise(0)}</TableCell>
                    <TableCell className="text-right font-mono font-medium tabular-nums">{formatPaise(m.net)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({ label, value, loading, tone = null }) {
  return (
    <div className="rounded-card border border-border bg-card p-4 shadow-card">
      <p className="text-[0.8125rem] text-muted-foreground">{label}</p>
      {loading ? <Skeleton className="mt-2 h-7 w-24" /> : <p className={`mt-1 font-mono text-xl font-semibold tabular-nums ${tone === "warning" ? "text-warning-text" : ""}`}>{value}</p>}
    </div>
  );
}
