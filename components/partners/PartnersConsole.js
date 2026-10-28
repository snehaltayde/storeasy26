"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Button } from "@/components/console/Button";
import { ConfirmDialog, Dialog } from "@/components/console/Dialog";
import { Table } from "@/components/console/Table";
import { Field, Input, Select } from "@/components/console/fields";
import { SecretReveal } from "@/components/console/Copy";
import { EmptyState, ErrorState, SkeletonText, Stat } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Agency console (S48 / AG01–06, redesigned S50). Everything here runs
// against grants the CLIENT accepted — revocation anywhere is immediate on
// the next call. S50 fixes: the five GET views now load in PARALLEL (the
// old refresh() awaited them one by one), the kits and reviews sections no
// longer VANISH when empty, the 30-day report opens in a dialog instead of
// materializing at the page bottom, and invite / review codes render via
// SecretReveal instead of a transient message line.

const inr = (minor) => `₹${(Number(minor || 0) / 100).toLocaleString("en-IN")}`;
const rupees = (major) => `₹${Number(major || 0).toLocaleString("en-IN")}`;

const VIEWS = ["portfolio", "grants", "kits", "approvals", "referrals"];

// Each fetching section renders exactly one of loading / error / empty /
// data (house rule — `return null` is banned). Existing data survives a
// background refresh; the skeleton only shows before the first load.
function ViewBody({ state, onRetry, lines = 3, isEmpty = () => false, empty = null, render }) {
  if (state.data == null) {
    if (state.error) return <ErrorState detail={state.error} onRetry={onRetry} className="py-6" />;
    return <SkeletonText lines={lines} />;
  }
  if (isEmpty(state.data)) return empty;
  return render(state.data);
}

const REFERRAL_COLUMNS = [
  { key: "period", header: "Month" },
  { key: "earned", header: "Earned", align: "right" },
  { key: "reversed", header: "Reversed", align: "right" },
  { key: "net", header: "Net", align: "right" },
  { key: "events", header: "Events", align: "right" },
];

export default function PartnersConsole({ agency, email }) {
  const router = useRouter();
  const toast = useToast();
  const [views, setViews] = useState(() =>
    Object.fromEntries(VIEWS.map((v) => [v, { loading: true, error: null, data: null }]))
  );
  const [busyKey, setBusyKey] = useState(null);
  const [signingOut, setSigningOut] = useState(false);
  const [invite, setInvite] = useState({ clientEmail: "", role: "staff" });
  const [report, setReport] = useState(null); // opens the report dialog
  const [inviteResult, setInviteResult] = useState(null); // {token, note, email}
  const [reviewResult, setReviewResult] = useState(null); // {token, note, client}
  const [revoking, setRevoking] = useState(null); // grant being revoked
  const [applyTo, setApplyTo] = useState({}); // kit id → chosen tenant
  const [applyConfirm, setApplyConfirm] = useState(null); // {kit, kitName, tenant, clientName}

  const loadView = useCallback(async (view) => {
    setViews((s) => ({ ...s, [view]: { ...s[view], loading: true, error: null } }));
    try {
      const res = await fetch(`/api/partners?view=${view}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Couldn't load ${view} (${res.status})`);
      const data = view === "referrals" ? json : json[view];
      setViews((s) => ({ ...s, [view]: { loading: false, error: null, data } }));
    } catch (e) {
      setViews((s) => ({ ...s, [view]: { ...s[view], loading: false, error: String(e?.message || e) } }));
    }
  }, []);

  // The S48 waterfall fix: all five views in flight at once.
  const refresh = useCallback(() => Promise.all(VIEWS.map(loadView)), [loadView]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function post(body) {
    const res = await fetch("/api/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  }

  // Busy is per-action: errors outside a dialog land in a toast.
  async function act(key, fn) {
    setBusyKey(key);
    try {
      await fn();
    } catch (e) {
      toast.error(String(e?.message || e));
    } finally {
      setBusyKey(null);
    }
  }

  const portfolio = views.portfolio.data || [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {agency.name}
            <StatusBadge status={agency.status} />
          </span>
        }
        description={`${email}${agency.referral_eligible ? ` · referrals at ${agency.commission_bps / 100}% of eligible collected revenue` : ""}`}
        actions={
          <Button
            variant="secondary"
            busy={signingOut}
            onClick={async () => {
              setSigningOut(true);
              await fetch("/api/partners/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
              router.refresh();
            }}
          >
            Sign out
          </Button>
        }
      />

      {/* AG01 portfolio */}
      <Card>
        <CardHeader title="Client stores" description="Only stores whose owner accepted your access. Revocation takes effect immediately." />
        <ViewBody
          state={views.portfolio}
          onRetry={() => loadView("portfolio")}
          lines={4}
          isEmpty={(d) => d.length === 0}
          empty={<EmptyState title="No client stores yet" body="Invite a client below — a store appears here the moment its owner accepts your code." className="py-6" />}
          render={(stores) => (
            <ul className="space-y-2 text-sm">
              {stores.map((c) => (
                <li key={c.tenant} className="flex flex-wrap items-center gap-2 rounded-ctl border border-edge bg-surface-sunken/50 p-3">
                  <span className="font-medium text-fg">{c.name}</span>
                  <Badge tone="neutral">{c.role}</Badge>
                  <span className="text-xs text-fg-subtle">{c.currency} · {c.timezone}</span>
                  {c.reachable ? (
                    <span className="text-xs text-fg-muted">{c.health.products} live products · {c.health.orders30} orders (30d) · {c.health.openReturns} open returns</span>
                  ) : (
                    <StatusBadge status="unreachable" />
                  )}
                  {c.pendingApprovals > 0 && <Badge tone="warning">{c.pendingApprovals} review pending</Badge>}
                  <span className="ml-auto flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      busy={busyKey === `report:${c.tenant}`}
                      onClick={() =>
                        act(`report:${c.tenant}`, async () => {
                          const res = await fetch(`/api/partners?view=report&tenant=${encodeURIComponent(c.tenant)}`);
                          const j = await res.json().catch(() => ({}));
                          if (!res.ok) throw new Error(j.error || "Couldn't load the report");
                          setReport(j.report);
                        })
                      }
                    >
                      Report
                    </Button>
                    <Button
                      size="sm"
                      busy={busyKey === `export:${c.tenant}`}
                      onClick={() =>
                        act(`export:${c.tenant}`, async () => {
                          const r = await post({ kit_export: { tenant: c.tenant } });
                          toast.success(`Kit "${r.kit.name}" saved — scrubbed structure only.`);
                          loadView("kits");
                        })
                      }
                    >
                      Export kit
                    </Button>
                    <Button
                      size="sm"
                      busy={busyKey === `review:${c.tenant}`}
                      onClick={() =>
                        act(`review:${c.tenant}`, async () => {
                          const r = await post({ approval: { tenant: c.tenant } });
                          setReviewResult({ token: r.token, note: r.note, client: c.name });
                          loadView("approvals");
                          loadView("portfolio");
                        })
                      }
                    >
                      Request review
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        />
      </Card>

      {/* AG02 invitations */}
      <Card className="mt-4">
        <CardHeader
          title="Invite a client"
          description="The code binds to the client's email and expires in 7 days; they accept it in their own console (Settings → Agency access). Ownership transfer is deliberately not offered — grants never escalate to owner."
        />
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            act("invite", async () => {
              const r = await post({ invite });
              setInviteResult({ token: r.token, note: r.note, email: invite.clientEmail });
              setInvite({ clientEmail: "", role: "staff" });
              loadView("grants");
            });
          }}
        >
          <Field label="Client owner email" htmlFor="invite-email" className="min-w-56 flex-1">
            <Input id="invite-email" type="email" required placeholder="client-owner@store.com" value={invite.clientEmail} onChange={(e) => setInvite({ ...invite, clientEmail: e.target.value })} />
          </Field>
          <Field label="Role" htmlFor="invite-role">
            <Select id="invite-role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              <option value="support">support (read-only)</option>
              <option value="staff">staff (content & offers)</option>
              <option value="admin">admin (settings too)</option>
            </Select>
          </Field>
          <Button type="submit" variant="primary" busy={busyKey === "invite"}>
            Create invitation
          </Button>
        </form>
        <div className="mt-4">
          <ViewBody
            state={views.grants}
            onRetry={() => loadView("grants")}
            lines={2}
            isEmpty={(d) => d.length === 0}
            empty={<EmptyState title="No invitations yet" body="Codes you create appear here with their status." className="py-6" />}
            render={(grants) => (
              <ul className="space-y-1.5 text-xs text-fg-muted">
                {grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={g.status} />
                    <span className="text-fg">{g.client_email}</span>
                    <span>· {g.role}</span>
                    {g.tenant_id && <span>· {g.tenant_id}</span>}
                    {["pending", "accepted"].includes(g.status) && (
                      <Button size="sm" variant="dangerOutline" className="ml-auto" onClick={() => setRevoking(g)}>
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          />
        </div>
      </Card>

      {/* AG03 kits — always rendered; used to vanish when empty */}
      <Card className="mt-4">
        <CardHeader
          title="Private kits"
          description="Scrubbed structure only — no customer data, keys, domains, media or catalog ids survive export. Applying writes DRAFTS on the destination; the client publishes. Brand tokens come back as a suggestion, never auto-applied."
        />
        <ViewBody
          state={views.kits}
          onRetry={() => loadView("kits")}
          isEmpty={(d) => d.length === 0}
          empty={<EmptyState title="No kits yet" body="Export one from a client store to reuse its structure elsewhere." className="py-6" />}
          render={(kits) => (
            <ul className="space-y-2 text-sm">
              {kits.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-2 rounded-ctl border border-edge bg-surface-sunken/50 p-3">
                  <span className="font-medium text-fg">{k.name}</span>
                  <span className="text-xs text-fg-subtle">from {k.source_note} · {Object.keys(k.payload).join(", ")}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <Select
                      aria-label={`Apply kit ${k.name} to`}
                      className="w-44"
                      value={applyTo[k.id] || ""}
                      onChange={(e) => setApplyTo((m) => ({ ...m, [k.id]: e.target.value }))}
                    >
                      <option value="">Choose client…</option>
                      {portfolio.map((c) => (
                        <option key={c.tenant} value={c.tenant}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      disabled={!applyTo[k.id]}
                      onClick={() => {
                        const tenant = applyTo[k.id];
                        const client = portfolio.find((c) => c.tenant === tenant);
                        setApplyConfirm({ kit: k.id, kitName: k.name, tenant, clientName: client?.name || tenant });
                      }}
                    >
                      Apply
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        />
      </Card>

      {/* AG04 approvals — always rendered; used to vanish when empty */}
      <Card className="mt-4">
        <CardHeader title="Client reviews" description="Each link is signed, expiring, and bound to one draft hash — approvals never carry over to changed drafts." />
        <ViewBody
          state={views.approvals}
          onRetry={() => loadView("approvals")}
          isEmpty={(d) => d.length === 0}
          empty={<EmptyState title="No review requests yet" body="Request one from a client store row above." className="py-6" />}
          render={(approvals) => (
            <ul className="space-y-2 text-xs">
              {approvals.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={a.status} />
                  <span className="font-medium text-fg">{a.tenant_id}</span>
                  <code className="font-mono text-fg-subtle">{a.content_hash.slice(0, 12)}</code>
                  {a.approver && <span className="text-fg-muted">by {a.approver}</span>}
                  {a.comment && <span className="text-fg-subtle">“{a.comment}”</span>}
                  {a.status === "approved" && a.current === false && <Badge tone="warning">stale — draft changed since</Badge>}
                  {a.status === "approved" && a.current === true && <Badge tone="success">current draft</Badge>}
                </li>
              ))}
            </ul>
          )}
        />
      </Card>

      {/* AG05 referrals */}
      <Card className="mt-4">
        <CardHeader title="Referrals & earnings" />
        <ViewBody
          state={views.referrals}
          onRetry={() => loadView("referrals")}
          render={(ref) =>
            !ref.eligible ? (
              <p className="text-sm text-fg-muted">Referral earnings aren&rsquo;t enabled for this agency yet — that&rsquo;s a platform-side setting.</p>
            ) : (
              <>
                <p className="text-xs text-fg-muted">
                  {ref.commission_bps / 100}% of eligible COLLECTED revenue on referred stores. Refunds reverse the matching commission exactly once. {ref.statement.payoutsNote}.
                </p>
                {ref.statement.months.length === 0 ? (
                  <EmptyState title="No commission events yet" body="Commission appears here as referred stores collect revenue." className="py-6" />
                ) : (
                  <Table
                    className="mt-3"
                    dense
                    columns={REFERRAL_COLUMNS}
                    rows={ref.statement.months}
                    rowKey={(m) => m.period}
                    renderCell={(m, col) => {
                      switch (col.key) {
                        case "period":
                          return <span className="font-medium text-fg">{m.period}</span>;
                        case "earned":
                          return inr(m.earned);
                        case "reversed":
                          return <span className="text-danger">{inr(m.reversed)}</span>;
                        case "net":
                          return <span className="font-semibold">{inr(m.net)}</span>;
                        case "events":
                          return <span className="text-fg-muted">{m.events}</span>;
                        default:
                          return m[col.key];
                      }
                    }}
                  />
                )}
              </>
            )
          }
        />
      </Card>

      {/* AG06 report viewer — a dialog now, not a section at the page bottom */}
      <Dialog open={!!report} onClose={() => setReport(null)} size="lg" title={report ? `${report.name} — 30 days` : ""}>
        {report && (
          <div>
            <p className="text-xs text-fg-subtle">
              {report.currency}, {report.timezone} · Prepared by {agency.name} · generated {new Date(report.generated_at).toLocaleString("en-IN")} · this report contains only this
              client&rsquo;s data.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Orders (30d)" value={report.sales?.orders ?? "—"} />
              <Stat label="Net sales" value={report.sales?.net != null ? rupees(report.sales.net) : "—"} />
              <Stat label="Refunds" value={report.sales?.refunds != null ? rupees(report.sales.refunds) : "—"} />
            </div>
            {report.topProducts?.products?.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-fg-muted">Top products</p>
                <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-xs text-fg-muted">
                  {report.topProducts.products.slice(0, 5).map((p, i) => (
                    <li key={i}>
                      {p.title} — {p.qty} units · {rupees(p.revenue)}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* Invitation code — one-time value, SecretReveal in a dialog */}
      <Dialog open={!!inviteResult} onClose={() => setInviteResult(null)} title="Invitation created">
        {inviteResult && (
          <div className="space-y-3">
            <p>{inviteResult.note}</p>
            <SecretReveal value={inviteResult.token} label={`Invitation code for ${inviteResult.email}`} />
            <p className="text-xs text-fg-subtle">The code binds to that email and expires in 7 days — the client accepts it in Settings → Agency access.</p>
          </div>
        )}
      </Dialog>

      {/* Review code — one-time value, SecretReveal in a dialog */}
      <Dialog open={!!reviewResult} onClose={() => setReviewResult(null)} title="Review link created">
        {reviewResult && (
          <div className="space-y-3">
            <p>{reviewResult.note}</p>
            <SecretReveal value={reviewResult.token} label={`Review code for ${reviewResult.client}`} />
            <p className="text-xs text-fg-subtle">
              Send the client to <code className="rounded bg-surface-sunken px-1 font-mono text-[11px] text-fg">/approve/&lt;code&gt;</code> on their store domain. The link is signed,
              expiring, and bound to the current draft hash.
            </p>
          </div>
        )}
      </Dialog>

      {/* Revoke — destructive, so a ConfirmDialog with the immediate-cutoff copy */}
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title="Revoke access"
        tone="danger"
        confirmLabel="Revoke access"
        body={
          revoking
            ? `Revoke ${revoking.role} access for ${revoking.client_email}? The cutoff is immediate — the very next call under this grant fails. The client can re-invite later if needed.`
            : ""
        }
        onConfirm={async () => {
          await post({ revoke: { id: revoking.id } });
          toast.success(`Access for ${revoking.client_email} revoked.`);
          setRevoking(null);
          loadView("grants");
          loadView("portfolio");
        }}
      />

      {/* Kit apply — writes drafts only; the client publishes */}
      <ConfirmDialog
        open={!!applyConfirm}
        onClose={() => setApplyConfirm(null)}
        title="Apply kit"
        tone="primary"
        confirmLabel="Apply kit"
        body={
          applyConfirm
            ? `Apply "${applyConfirm.kitName}" to ${applyConfirm.clientName}? This writes DRAFTS only — nothing changes on the live store until the client publishes. Brand tokens are suggested, never auto-applied.`
            : ""
        }
        onConfirm={async () => {
          const r = await post({ kit_apply: { kit: applyConfirm.kit, tenant: applyConfirm.tenant } });
          toast.success(
            `${r.note} (${r.written.join(", ")})${r.brandSuggestion ? " · brand tokens suggested — the client applies them in their Brand tab" : ""}`
          );
          setApplyConfirm(null);
        }}
      />
    </div>
  );
}
