import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/ui/utils";

// The store at a glance (storeStatus in lib/admin/dashboard.js): open or
// closed, its address, Shopify, the catalog, push coverage and unpublished
// changes. A fact the server couldn't read says "Couldn't check", never a
// guess. Links are reads.
const LINK = "rounded-md font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
const UNKNOWN = "Couldn't check";

function Fact({ label, children }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
      <dt className="text-[0.8125rem] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-foreground">{children}</dd>
    </div>
  );
}

// tenant.status not active, or the store's maintenance switch on
export function StoreBanner({ status }) {
  if (status.status !== "active") {
    return (
      <p role="status" data-dashboard="banner" className="rounded-card border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        This store is suspended, so shoppers can't see it. Contact Storeasy support to bring it back.
      </p>
    );
  }
  if (status.maintenance) {
    return (
      <p role="status" data-dashboard="banner" className="rounded-card border border-warning/40 bg-warning/15 px-4 py-3 text-sm text-warning-text">
        Your store is in maintenance: shoppers see a "be right back" page until it's turned off.
      </p>
    );
  }
  return null;
}

export function StoreStatus({ status, pushPct, syncedWords }) {
  const { open, shopify, catalog, unpublished } = status;
  return (
    <Card data-dashboard="status">
      <CardHeader>
        <CardTitle>Your store</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <Fact label="Store">
            {open.open == null ? (
              UNKNOWN
            ) : open.open ? (
              <Badge variant="success">Open</Badge>
            ) : (
              <span className="inline-flex flex-wrap items-center justify-end gap-2">
                <Badge variant="muted">Closed</Badge>
                {open.total ? (
                  <Link href="/admin/onboarding" data-read-control className={LINK}>
                    Onboarding {open.doneCount}/{open.total}
                  </Link>
                ) : null}
              </span>
            )}
          </Fact>
          <Fact label="Address">
            <span className="inline-flex flex-wrap items-center justify-end gap-x-3">
              {status.address && <span className="font-mono text-[0.8125rem]">{status.address}</span>}
              <a href="/" target="_blank" rel="noreferrer" data-read-control className={cn(LINK, "inline-flex items-center gap-1")}>
                Open storefront
                <ExternalLink aria-hidden className="size-3.5" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </span>
          </Fact>
          <Fact label="Shopify">
            {shopify.connected == null ? UNKNOWN : shopify.connected ? (shopify.shopDomain ? `Connected to ${shopify.shopDomain}` : "Connected") : "Not connected"}
          </Fact>
          <Fact label="Catalog">
            {catalog.unknown ? UNKNOWN : `${catalog.count} product${catalog.count === 1 ? "" : "s"} · ${syncedWords}`}
          </Fact>
          <Fact label="Sent to Shopify">{pushPct == null ? "No sales in this range" : `${pushPct}% of sales`}</Fact>
          <Fact label="Unpublished changes">
            {unpublished == null ? (
              UNKNOWN
            ) : unpublished === 0 ? (
              "None"
            ) : (
              <Link href="/admin/releases" data-read-control className={LINK}>
                {unpublished} page{unpublished === 1 ? "" : "s"} with changes
              </Link>
            )}
          </Fact>
        </dl>
      </CardContent>
    </Card>
  );
}
