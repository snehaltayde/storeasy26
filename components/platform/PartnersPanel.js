"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Button } from "@/components/console/Button";
import { StatusBadge } from "@/components/console/Badge";
import { Field, Input, Select, Textarea } from "@/components/console/fields";
import { ConfirmDialog } from "@/components/console/Dialog";
import { SecretReveal } from "@/components/console/Copy";
import { SkeletonText, ErrorState, EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Partner administration (S48 / OP14, redesigned S50) + case-study authoring
// (MK06). Commercial status here never grants client access — grants are the
// client's act, in their own console.
const inr = (minor) => `₹${(Number(minor || 0) / 100).toLocaleString("en-IN")}`;

const CS_FIELDS = [
  ["slug", "Slug"],
  ["title", "Title"],
  ["tenant_id", "Tenant (slug)"],
  ["consent_ref", "Consent ref (who approved, when, how)"],
  ["period", "Measurement period"],
  ["baseline", "Baseline"],
  ["method", "Method"],
  ["limitations", "Limitations"],
  ["confounders", "Confounders (or 'none known')"],
  ["quote", "Quote (with usage rights)"],
  ["quote_by", "Quote attribution"],
];

export default function PartnersPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newAgency, setNewAgency] = useState("");
  const [invite, setInvite] = useState({ agencyId: "", email: "" });
  const [inviteCode, setInviteCode] = useState(null); // { email, token }
  const [referral, setReferral] = useState({ tenant: "", agency: "" });
  const [statement, setStatement] = useState(null);
  const [cs, setCs] = useState(null); // case-study form
  const [confirm, setConfirm] = useState(null); // { type: "suspend"|"void"|"revoke"|"delete_case", ... }
  const toast = useToast();

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch("/api/platform/partners");
      if (res.ok) setData(await res.json());
      else setErr(`Couldn't load partners (${res.status})`);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // throws on failure so ConfirmDialog can surface it inline
  async function post(body, label) {
    const res = await fetch("/api/platform/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${label}: ${j.error || res.status}`);
    toast.success(`${label}: ok${j.note ? ` (${j.note})` : ""}${j.inserted !== undefined ? ` (${j.inserted} new entries)` : ""}`);
    refresh();
    return j;
  }

  // non-dialog actions: failures land as error toasts
  async function act(body, label) {
    setBusy(true);
    try {
      const j = await post(body, label);
      setBusy(false);
      return j;
    } catch (e) {
      toast.error(String(e?.message || e));
      setBusy(false);
      return null;
    }
  }

  const agencies = data?.agencies || [];
  const grants = data?.grants || [];
  const referrals = data?.referrals || [];
  const caseStudies = data?.caseStudies || [];

  return (
    <Card id="partners">
      <CardHeader
        title="Partners (agencies)"
        description="Verification, referral eligibility and commission rates are COMMERCIAL state — they grant no client access. Access exists only where a client accepted a grant in their own console, and it revokes instantly."
      />
      {err && <ErrorState title="Couldn't load partners" detail={err} onRetry={refresh} />}
      {!data && !err && <SkeletonText lines={4} />}
      {data && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="New agency name" htmlFor="pa-new-agency" className="w-64">
              <Input id="pa-new-agency" value={newAgency} onChange={(e) => setNewAgency(e.target.value)} />
            </Field>
            <Button size="sm" busy={busy} disabled={!newAgency.trim()} onClick={async () => (await act({ agency: { name: newAgency } }, "create")) && setNewAgency("")}>
              Create agency
            </Button>
          </div>

          {inviteCode && (
            <div className="mt-3">
              <SecretReveal label={`Invite code for ${inviteCode.email}`} value={inviteCode.token} note="Shown once — send it to the member now." />
            </div>
          )}

          {agencies.length === 0 ? (
            <EmptyState title="No agencies yet" body="Create the first partner agency above." />
          ) : (
            <ul className="mt-4 space-y-2 text-sm">
              {agencies.map((a) => (
                <li key={a.id} className="rounded-ctl border border-edge p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-fg">{a.name}</span>
                    <StatusBadge status={a.status} />
                    <span className="text-xs text-fg-subtle">
                      {a.members} members · {a.clients} client stores · {a.commission_bps / 100}%{a.referral_eligible ? " · referral-eligible" : ""}
                    </span>
                    <span className="ml-auto flex flex-wrap gap-1.5">
                      {a.status !== "verified" && (
                        <Button size="sm" disabled={busy} onClick={() => act({ status: { id: a.id, status: "verified" } }, "verify")}>
                          Verify
                        </Button>
                      )}
                      <Button size="sm" disabled={busy} onClick={() => act({ status: { id: a.id, referral_eligible: !a.referral_eligible } }, "eligibility")}>
                        {a.referral_eligible ? "Disable referrals" : "Enable referrals"}
                      </Button>
                      {a.status === "suspended" ? (
                        <Button size="sm" disabled={busy} onClick={() => act({ status: { id: a.id, status: "verified" } }, "suspend")}>
                          Unsuspend
                        </Button>
                      ) : (
                        <Button size="sm" variant="dangerOutline" disabled={busy} onClick={() => setConfirm({ type: "suspend", agency: a })}>
                          Suspend
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={async () => {
                          const res = await fetch(`/api/platform/partners?statement=${a.id}`);
                          if (res.ok) setStatement({ agency: a.name, ...(await res.json()).statement });
                          else toast.error(`Statement failed (${res.status})`);
                        }}
                      >
                        Statement
                      </Button>
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={`Invite member to ${a.name}`}
                      placeholder="member@agency.com"
                      className="w-64"
                      value={invite.agencyId === a.id ? invite.email : ""}
                      onChange={(e) => setInvite({ agencyId: a.id, email: e.target.value })}
                    />
                    <Button
                      size="sm"
                      disabled={busy || invite.agencyId !== a.id || !invite.email}
                      onClick={async () => {
                        const j = await act({ member_invite: invite }, "member invite");
                        if (j) {
                          if (j.token) setInviteCode({ email: invite.email, token: j.token });
                          setInvite({ agencyId: "", email: "" });
                        }
                      }}
                    >
                      Invite member
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* referrals */}
          <div className="mt-5 rounded-ctl bg-surface-sunken p-4">
            <h3 className="text-xs font-semibold text-fg">Referral attribution</h3>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field label="Tenant slug" htmlFor="pa-ref-tenant" className="w-44">
                <Input id="pa-ref-tenant" mono value={referral.tenant} onChange={(e) => setReferral({ ...referral, tenant: e.target.value })} />
              </Field>
              <Field label="Agency" htmlFor="pa-ref-agency" className="w-44">
                <Select id="pa-ref-agency" value={referral.agency} onChange={(e) => setReferral({ ...referral, agency: e.target.value })}>
                  <option value="">agency…</option>
                  {agencies.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button size="sm" disabled={busy || !referral.tenant || !referral.agency} onClick={() => act({ referral }, "attribute")}>
                Attribute
              </Button>
              <Button size="sm" disabled={busy} onClick={() => act({ recompute: true }, "recompute commissions")}>
                Recompute commissions
              </Button>
            </div>
            {referrals.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-xs text-fg-muted">
                {referrals.map((r) => (
                  <li key={r.tenant_id} className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-fg">{r.tenant_id}</span>→ {r.agency_name}
                    <StatusBadge status={r.status} />
                    {r.status === "attributed" && (
                      <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setConfirm({ type: "void", referral: r })}>
                        Void (dispute)
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {statement && (
            <div className="mt-3 rounded-ctl border border-info-edge bg-info-bg/40 p-4 text-xs">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-fg">Statement — {statement.agency}</h3>
                <Button size="sm" onClick={() => setStatement(null)}>
                  Close
                </Button>
              </div>
              <p className="mt-1 text-fg-muted">{statement.payoutsNote}</p>
              {statement.months.length === 0 ? (
                <p className="mt-1 text-fg-subtle">No commission events.</p>
              ) : (
                statement.months.map((m) => (
                  <p key={m.period} className="mt-1 tabular-nums">
                    {m.period}: earned {inr(m.earned)} · reversed {inr(m.reversed)} · net <strong>{inr(m.net)}</strong> ({m.events} events)
                  </p>
                ))
              )}
            </div>
          )}

          {/* grants overview (read + revoke) */}
          {grants.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer rounded text-xs font-semibold text-fg focus-ring">Grants across the fleet ({grants.length})</summary>
              <ul className="mt-2 space-y-1.5 text-xs text-fg-muted">
                {grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-fg">{g.agency_name}</span>→ {g.tenant_id || `(pending: ${g.client_email})`} · {g.role} ·
                    <StatusBadge status={g.status} />
                    {["pending", "accepted"].includes(g.status) && (
                      <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => setConfirm({ type: "revoke", grant: g })}>
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* MK06 case studies */}
          <div className="mt-5 rounded-ctl bg-surface-sunken p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-fg">Case studies (marketing site)</h3>
              <Button
                size="sm"
                onClick={() =>
                  setCs({ slug: "", title: "", tenant_id: "", consent_ref: "", period: "", baseline: "", method: "", limitations: "", confounders: "", results: [{ metric: "", before: "", after: "" }], quote: "", quote_by: "", body: "" })
                }
              >
                New case study
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-fg-muted">
              Publishing is gated: documented merchant consent + measurement period/method/results + limitations/confounders — a lift claim
              without its measurement record cannot publish.
            </p>
            {caseStudies.length === 0 && !cs && <EmptyState title="No case studies yet" className="py-6" />}
            <ul className="mt-2 space-y-1.5 text-xs text-fg-muted">
              {caseStudies.map((c) => (
                <li key={c.slug} className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-fg">{c.title}</span>
                  <span className="text-fg-subtle">/customers/{c.slug}</span>
                  <StatusBadge status={c.published ? "live" : "draft"} label={c.published ? "Published" : "Draft"} />
                  {!c.published && c.publishBlocks.length > 0 && (
                    <span className="text-warning">
                      blocked: {c.publishBlocks[0]}
                      {c.publishBlocks.length > 1 ? ` (+${c.publishBlocks.length - 1})` : ""}
                    </span>
                  )}
                  <span className="ml-auto flex gap-1.5">
                    <Button size="sm" onClick={() => setCs({ ...c, results: c.results.length ? c.results : [{ metric: "", before: "", after: "" }] })}>
                      Edit
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => act({ publish_case: { slug: c.slug, published: !c.published } }, c.published ? "unpublish" : "publish")}>
                      {c.published ? "Unpublish" : "Publish"}
                    </Button>
                    <Button size="sm" variant="dangerOutline" disabled={busy} onClick={() => setConfirm({ type: "delete_case", caseStudy: c })}>
                      Delete
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            {cs && (
              <div className="mt-3 grid gap-3 rounded-ctl border border-edge bg-surface p-4 sm:grid-cols-2">
                {CS_FIELDS.map(([k, label]) => (
                  <Field key={k} label={label} htmlFor={`cs-${k}`}>
                    <Input id={`cs-${k}`} value={cs[k] || ""} onChange={(e) => setCs({ ...cs, [k]: e.target.value })} />
                  </Field>
                ))}
                <Field label="Narrative body" htmlFor="cs-body" className="sm:col-span-2">
                  <Textarea id="cs-body" value={cs.body || ""} onChange={(e) => setCs({ ...cs, body: e.target.value })} />
                </Field>
                <div className="sm:col-span-2">
                  <p className="text-xs font-semibold text-fg">Measured results (before → after)</p>
                  {cs.results.map((r, i) => (
                    <div key={i} className="mt-1.5 flex gap-2">
                      <Input aria-label={`Result ${i + 1} metric`} placeholder="metric" className="flex-1" value={r.metric} onChange={(e) => setCs({ ...cs, results: cs.results.map((x, j) => (j === i ? { ...x, metric: e.target.value } : x)) })} />
                      <Input aria-label={`Result ${i + 1} before`} placeholder="before" className="w-24" value={r.before} onChange={(e) => setCs({ ...cs, results: cs.results.map((x, j) => (j === i ? { ...x, before: e.target.value } : x)) })} />
                      <Input aria-label={`Result ${i + 1} after`} placeholder="after" className="w-24" value={r.after} onChange={(e) => setCs({ ...cs, results: cs.results.map((x, j) => (j === i ? { ...x, after: e.target.value } : x)) })} />
                    </div>
                  ))}
                  <Button size="sm" className="mt-2" onClick={() => setCs({ ...cs, results: [...cs.results, { metric: "", before: "", after: "" }] })}>
                    Add result
                  </Button>
                </div>
                <div className="flex gap-2 sm:col-span-2">
                  <Button variant="primary" size="sm" busy={busy} onClick={async () => (await act({ case_study: cs }, "save case study")) && setCs(null)}>
                    Save draft
                  </Button>
                  <Button size="sm" onClick={() => setCs(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirm?.type === "suspend"}
        onClose={() => setConfirm(null)}
        title={`Suspend “${confirm?.agency?.name}”?`}
        tone="danger"
        confirmLabel="Suspend agency"
        body="Suspension is commercial state — it does not revoke client access by itself (grants are revoked separately, or by the client)."
        onConfirm={() => post({ status: { id: confirm.agency.id, status: "suspended" } }, "suspend")}
      />
      <ConfirmDialog
        open={confirm?.type === "void"}
        onClose={() => setConfirm(null)}
        title={`Void referral for “${confirm?.referral?.tenant_id}”?`}
        tone="danger"
        confirmLabel="Void referral"
        body="Marks the attribution as disputed by the operator; future commission stops accruing."
        onConfirm={() => post({ void_referral: { tenant: confirm.referral.tenant_id, note: "operator dispute" } }, "void")}
      />
      <ConfirmDialog
        open={confirm?.type === "revoke"}
        onClose={() => setConfirm(null)}
        title={`Revoke grant — ${confirm?.grant?.agency_name} → ${confirm?.grant?.tenant_id || confirm?.grant?.client_email}?`}
        tone="danger"
        confirmLabel="Revoke grant"
        body="The agency loses access to this client store immediately."
        onConfirm={() => post({ revoke_grant: { id: confirm.grant.id } }, "revoke grant")}
      />
      <ConfirmDialog
        open={confirm?.type === "delete_case"}
        onClose={() => setConfirm(null)}
        title={`Delete case study “${confirm?.caseStudy?.title}”?`}
        tone="danger"
        confirmLabel="Delete"
        body="Removes the draft and its measurement record. A published page is taken down."
        onConfirm={() => post({ delete_case: { slug: confirm.caseStudy.slug } }, "delete")}
      />
    </Card>
  );
}
