// A store's page in the operator console (Phase 3 line 1), read-only: header
// with Open storefront, live health, onboarding, Shopify connection, plan,
// release and migrations, secret NAMES (never values), provisioning runs,
// recent audit rows, open incidents, support access and operator notes.
// `detail` is lib/platform/stores-list.js storeDetail(). Line 2 adds the
// lifecycle actions and line 5 support access at their anchors below.
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/kit/copy-button";
import { PageHeader } from "@/components/kit/page-header";
import HealthCard from "./HealthCard";
import { RUN_STATUS, STEP_LABELS, STEP_STATE, STORE_STATUS, SUBSCRIPTION, billingHref, onboardingSheetHref, when, word } from "./storesWords";

const linkClass = "rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

function Section({ title, description = null, action = null, children, id }) {
  return (
    <Card data-card={id}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {children}
        {action}
      </CardContent>
    </Card>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-muted-foreground sm:w-36">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const Tone = ({ table, code }) => {
  const w = word(table, code);
  return <Badge variant={w.tone}>{w.label}</Badge>;
};

const Empty = ({ children }) => <p className="text-muted-foreground">{children}</p>;

export default function StoreDetail({ detail }) {
  const { store, shopify, connect, subscription, live, onboarding, onboardingCache, secretNames, runs, audit, incidents, support, notes } = detail;
  const status = word(STORE_STATUS, store.status);
  const steps = onboarding?.steps?.length ? onboarding.steps.map((s) => ({ id: s.id, state: s.state })) : onboardingCache?.steps || [];

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-6 md:px-6" data-screen="platform-store" data-store={store.id}>
      <PageHeader
        breadcrumb={[{ label: "Stores", href: "/platform" }, { label: store.name }]}
        title={store.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{store.id}</span>
            <Badge variant={status.tone} data-status={store.status}>
              {status.label}
            </Badge>
            {store.owners.length > 0 && <span>Owner: {store.owners.map((o) => o.email).join(", ")}</span>}
          </span>
        }
        actions={
          store.storefrontUrl && (
            <a href={store.storefrontUrl} target="_blank" rel="noreferrer" data-read-control className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <ExternalLink className="size-3.5" aria-hidden /> Open storefront
            </a>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <HealthCard storeId={store.id} />
        </div>

        {/* line 2: lifecycle */}

        <Section
          id="onboarding"
          title="Onboarding"
          description={onboarding ? (onboarding.open ? "The store is open." : `${onboarding.doneCount} of ${onboarding.total} steps done.`) : onboardingCache ? `Last checked ${when(onboardingCache.checkedAt)}.` : "No onboarding record yet."}
          action={
            <a href={onboardingSheetHref(store.id)} data-read-control className={linkClass}>
              Open the onboarding sheet
            </a>
          }
        >
          {steps.length ? (
            <ol className="space-y-1">
              {steps.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span>{STEP_LABELS[s.id] || s.id}</span>
                  <Tone table={STEP_STATE} code={s.state} />
                </li>
              ))}
            </ol>
          ) : (
            <Empty>No steps to show.</Empty>
          )}
        </Section>

        <Section id="shopify" title="Shopify">
          <dl className="space-y-2">
            <Row label="Shop">{shopify.shopDomain || "Not connected"}</Row>
            <Row label="Connection">{shopify.uninstalledAt ? <Badge variant="danger">App uninstalled {when(shopify.uninstalledAt)}</Badge> : shopify.connected ? <Badge variant="success">Connected</Badge> : <Badge variant="muted">Not connected</Badge>}</Row>
            <Row label="Store's Shopify app">{connect.appReady ? "Set up" : "Not set up"}</Row>
          </dl>
          <div className="space-y-2">
            <p className="text-muted-foreground">Redirect URLs to add to the store&apos;s Shopify app:</p>
            {connect.redirectUrls.length ? connect.redirectUrls.map((u) => <CopyButton key={u} value={u} label={`the redirect URL ${u}`} />) : <Empty>The store has no domain yet.</Empty>}
          </div>
        </Section>

        <Section
          id="plan"
          title="Plan and subscription"
          action={
            <a href={billingHref(store.id)} data-read-control className={linkClass}>
              Open in billing
            </a>
          }
        >
          {subscription ? (
            <dl className="space-y-2">
              <Row label="Plan">
                {subscription.planName} <span className="text-muted-foreground">v{subscription.version}</span>
              </Row>
              <Row label="Subscription">
                <Tone table={SUBSCRIPTION} code={subscription.status} />
              </Row>
              {subscription.currentEnd && <Row label="Current period ends">{when(subscription.currentEnd)}</Row>}
              {subscription.graceUntil && <Row label="Grace until">{when(subscription.graceUntil)}</Row>}
            </dl>
          ) : (
            <Empty>No subscription.</Empty>
          )}
        </Section>

        <Section id="release" title="Release and migrations">
          <dl className="space-y-2">
            <Row label="Live release">{!live.reachable ? "Can't reach the store's database" : live.release ? (live.release.documents ? live.release.message : <span className="font-mono">{live.release.hash}</span>) : "Nothing published"}</Row>
            {live.release?.publishedAt && <Row label="Published">{when(live.release.publishedAt)}</Row>}
            <Row label="Migrations">
              <span className="font-mono">{live.migrationHead || "—"}</span> <span className="text-muted-foreground">of</span> <span className="font-mono">{live.repoHead}</span>{" "}
              {live.behind === true && <Badge variant="warning">Behind</Badge>}
              {live.behind === false && <Badge variant="success">Current</Badge>}
            </Row>
            <Row label="Theme pin">{live.themePin ? <span className="font-mono">{live.themePin}</span> : "None"}</Row>
          </dl>
        </Section>

        <Section id="secrets" title="Secrets" description="Names only. Values never leave the server.">
          {secretNames.length ? (
            <ul className="flex flex-wrap gap-1.5" data-secret-names>
              {secretNames.map((n) => (
                <li key={n}>
                  <Badge variant="outline" className="font-mono">
                    {n}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No secrets stored.</Empty>
          )}
        </Section>

        {/* line 5: support access */}
        <Section id="support" title="Support access">
          {support.open ? (
            <dl className="space-y-2">
              <Row label="Status">
                <Badge variant="info">Open until {when(support.expiresAt)}</Badge>
              </Row>
              <Row label="Opened by">{support.operatorName}</Row>
              <Row label="Reason">{support.reason}</Row>
            </dl>
          ) : (
            <Empty>No support access open.</Empty>
          )}
        </Section>

        <Section id="incidents" title="Open incidents">
          {incidents.length ? (
            <ul className="space-y-2">
              {incidents.map((i) => (
                <li key={i.id}>
                  <p className="font-medium">{i.title}</p>
                  {i.publicMessage && <p className="text-muted-foreground">{i.publicMessage}</p>}
                  <p className="text-xs text-muted-foreground">{when(i.createdAt)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No open incidents.</Empty>
          )}
        </Section>

        <Section id="notes" title="Operator notes">
          {notes.length ? (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id}>
                  <p className="whitespace-pre-wrap">{n.body}</p>
                  <p className="text-xs text-muted-foreground">
                    {n.operatorName} · {when(n.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No notes yet.</Empty>
          )}
        </Section>

        <div className="lg:col-span-2">
          <Section id="runs" title="Provisioning runs" description="The last 10.">
            {runs.length ? (
              <ul className="divide-y divide-border">
                {runs.map((r) => (
                  <li key={r.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3">
                    <span className="font-mono text-xs">{r.id}</span>
                    <Tone table={RUN_STATUS} code={r.status} />
                    <span className="text-xs text-muted-foreground">{when(r.created_at)}</span>
                    {r.error && <span className="min-w-0 break-words text-xs text-destructive">{r.error}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No provisioning runs.</Empty>
            )}
          </Section>
        </div>

        <div className="lg:col-span-2">
          <Section id="audit" title="Recent activity" description="The last 20 audit rows for this store.">
            {audit.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="py-1 pr-4 font-medium">When</th>
                      <th scope="col" className="py-1 pr-4 font-medium">Who</th>
                      <th scope="col" className="py-1 pr-4 font-medium">Action</th>
                      <th scope="col" className="py-1 font-medium">On</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {audit.map((a) => (
                      <tr key={a.id}>
                        <td className="py-1.5 pr-4 whitespace-nowrap">{when(a.at)}</td>
                        <td className="py-1.5 pr-4">{a.actorName}</td>
                        <td className="py-1.5 pr-4 font-mono text-xs">{a.action}</td>
                        <td className="py-1.5 font-mono text-xs break-all">{a.resource || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>No activity recorded yet.</Empty>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
