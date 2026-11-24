"use client";

import { useEffect, useState } from "react";
import { Copy, Mail, Plus } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Field, Input, Select } from "@/components/console/fields";
import { ConfirmDialog } from "@/components/console/Dialog";
import { SkeletonText, EmptyState, ErrorState, PermissionNote, KeyValue } from "@/components/console/bits";
import { CopyButton, SecretReveal } from "@/components/console/Copy";
import { Table } from "@/components/console/Table";
import { useToast } from "@/components/console/Toast";

// Merchant ops panels (S43, redesigned S50): Team (MC23), Domains & SEO
// (MC21), Privacy (MC25), Audit log (MC26), Help & diagnostics (MC27) —
// appended to the Settings page as anchor-target Cards.
// Each panel speaks to its own API and renders exactly one of loading /
// permission / error / unsupported / data — never blank. Destructive actions
// (remove member, change role) confirm via ConfirmDialog.

function usePanel(url) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null); // { status, message }
  const load = () => {
    setErr(null);
    setData(null);
    return fetch(url)
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))
      .then(({ status, json }) => {
        if (json.ok) setData(json);
        else setErr({ status, message: json.error || `Request failed (${status})` });
      })
      .catch((e) => setErr({ status: 0, message: String(e) }));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { data, err, load, setData };
}

// One gate for the mandatory states: 403 → PermissionNote (role-aware),
// other errors → ErrorState with retry, null data → skeleton. `children` is
// a render-prop so panels only deal with real data.
function PanelState({ data, err, load, role, need, children }) {
  if (err) {
    return err.status === 403 ? <PermissionNote role={role} need={need} /> : <ErrorState detail={err.message} onRetry={load} className="py-6" />;
  }
  if (!data) return <SkeletonText lines={3} />;
  return children(data);
}

const postJson = async (url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
};

// ---- Team (MC23) -------------------------------------------------------------

const ROLES = ["owner", "admin", "staff", "support"];
const ROLE_TONE = { owner: "info", admin: "neutral", staff: "neutral", support: "neutral" };
const ROLE_SCOPE = {
  owner: "full control, including team and settings",
  admin: "ops and settings access",
  staff: "merchandising access only",
  support: "read-only access",
};

function TeamPanel({ role }) {
  const { data, err, load, setData } = usePanel("/api/admin/team");
  const [form, setForm] = useState({ email: "", role: "staff" });
  const [inviteUrl, setInviteUrl] = useState(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [roleChange, setRoleChange] = useState(null); // { member, role }
  const [removing, setRemoving] = useState(null); // member

  async function post(body) {
    const json = await postJson("/api/admin/team", body);
    setData(json);
    if (json.inviteUrl) setInviteUrl(`${window.location.origin}${json.inviteUrl}`);
    return json;
  }

  return (
    <Card id="team">
      <CardHeader
        title="Team & permissions"
        description="Roles: owner (everything) · admin (ops + settings) · staff (merchandising) · support (read-only). A store can never lose its last owner."
      />
      {actionErr && (
        <Banner tone="danger" className="mb-3">
          {actionErr}
        </Banner>
      )}
      <PanelState data={data} err={err} load={load} role={role} need="view team & permissions">
        {(d) =>
          !d.supported ? (
            <p className="text-sm text-fg-subtle">{d.reason}</p>
          ) : (
            <>
              {d.members.length === 0 ? (
                <EmptyState
                  title="No individual accounts yet"
                  body="This store still runs on the bootstrap password. Invite yourself first."
                  className="py-6"
                />
              ) : (
                <ul className="divide-y divide-edge">
                  {d.members.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium text-fg">{m.email}</span>
                        {m.name && <span className="ml-2 text-xs text-fg-subtle">{m.name}</span>}
                      </span>
                      <Badge tone={ROLE_TONE[m.role] || "neutral"}>{m.role}</Badge>
                      {/* controlled to m.role: picking a value opens the confirm
                          dialog; cancel reverts the select by never committing */}
                      <span className="w-28 shrink-0">
                        <Select
                          aria-label={`Change role for ${m.email}`}
                          value={m.role}
                          onChange={(e) => setRoleChange({ member: m, role: e.target.value })}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      </span>
                      <Button size="sm" variant="dangerOutline" onClick={() => setRemoving(m)}>
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {d.invites.length > 0 && (
                <p className="mt-2 text-xs text-fg-subtle">Pending: {d.invites.map((i) => `${i.email} (${i.role})`).join(", ")}</p>
              )}
              {inviteUrl && (
                <div className="mt-3">
                  <SecretReveal value={inviteUrl} label="Invitation link" note="Shown once — send it to your teammate yourself; it can't be retrieved later." />
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <Field label="Email" htmlFor="team-invite-email" className="flex-1 basis-48">
                  <Input
                    id="team-invite-email"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="teammate@store.in"
                  />
                </Field>
                <Field label="Role" htmlFor="team-invite-role">
                  <Select id="team-invite-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                    {["admin", "staff", "support", "owner"].map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  variant="primary"
                  icon={<Plus size={14} aria-hidden />}
                  busy={inviteBusy}
                  disabled={!form.email}
                  onClick={async () => {
                    setInviteBusy(true);
                    setActionErr(null);
                    try {
                      await post({ action: "invite", email: form.email, role: form.role });
                      setForm((f) => ({ ...f, email: "" }));
                    } catch (e) {
                      setActionErr(String(e?.message || e));
                    }
                    setInviteBusy(false);
                  }}
                >
                  Invite
                </Button>
              </div>
            </>
          )
        }
      </PanelState>

      <ConfirmDialog
        open={!!roleChange}
        onClose={() => setRoleChange(null)}
        title="Change role"
        body={
          roleChange
            ? `Change ${roleChange.member.name || roleChange.member.email}'s role to ${roleChange.role}? They immediately get ${ROLE_SCOPE[roleChange.role] || "that role's access"} — it applies on their very next request.`
            : ""
        }
        confirmLabel="Change role"
        onConfirm={() => post({ action: "role", userId: roleChange.member.id, role: roleChange.role })}
      />
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove team member"
        tone="danger"
        body={removing ? `Remove ${removing.email} from this store? Their console access ends immediately.` : ""}
        confirmLabel="Remove"
        onConfirm={() => post({ action: "remove", userId: removing.id })}
      />
    </Card>
  );
}

// ---- Domains & SEO (MC21) -----------------------------------------------------

function DomainsPanel({ role }) {
  const toast = useToast();
  const { data, err, load, setData } = usePanel("/api/admin/domains");
  const [verifying, setVerifying] = useState(null); // host
  const [warn, setWarn] = useState(null);
  const [actionErr, setActionErr] = useState(null);

  async function verify(host) {
    setVerifying(host);
    setWarn(null);
    setActionErr(null);
    try {
      const json = await postJson("/api/admin/domains", { action: "verify", host });
      setData((d) => ({ ...d, domains: json.domains }));
      if (json.result?.verified) toast.success(`${host} verified.`);
      else setWarn(`TXT record not found yet for ${host} — DNS can take a few minutes to propagate.`);
    } catch (e) {
      setActionErr(String(e?.message || e));
    }
    setVerifying(null);
  }

  return (
    <Card id="domains-seo">
      <CardHeader
        title="Domains & SEO"
        description="Your storefront answers on these hosts. Robots + sitemap are per-tenant and release-aware; campaigns stay noindex."
      />
      {actionErr && (
        <Banner tone="danger" className="mb-3">
          {actionErr}
        </Banner>
      )}
      {warn && (
        <Banner tone="warning" className="mb-3">
          {warn}
        </Banner>
      )}
      <PanelState data={data} err={err} load={load} role={role} need="view domains & SEO">
        {(d) =>
          !d.supported ? (
            <p className="text-sm text-fg-subtle">{d.reason}</p>
          ) : (
            <>
              {d.domains.length === 0 ? (
                <EmptyState
                  title="No custom domain claimed yet"
                  body="Tell the platform operator which host you want (e.g. shop.yourbrand.in) — they claim it, you add the TXT record and verify here."
                  className="py-6"
                />
              ) : (
                <ul className="space-y-2">
                  {d.domains.map((dom) => (
                    <li key={dom.host} className="rounded-ctl border border-edge p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-medium text-fg">{dom.host}</span>
                        {dom.verified ? <StatusBadge status="verified" /> : <Badge tone="warning">Pending DNS proof</Badge>}
                        {dom.primary && <Badge tone="neutral">Primary</Badge>}
                        {!dom.verified && (
                          <Button size="sm" variant="primary" className="ml-auto" busy={verifying === dom.host} onClick={() => verify(dom.host)}>
                            Verify now
                          </Button>
                        )}
                      </div>
                      {dom.challenge && (
                        <div className="mt-2 rounded-ctl bg-surface-sunken p-2.5 font-mono text-xs text-fg-muted">
                          <p className="font-sans">Add this DNS record, then press Verify:</p>
                          <p className="mt-1">TXT&ensp;{dom.challenge.record}</p>
                          <p className="flex items-center gap-1 break-all">
                            <span className="min-w-0">{dom.challenge.value}</span>
                            <CopyButton value={dom.challenge.value} label="Copy TXT value" />
                          </p>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {d.activeHosts?.length > 0 && <p className="mt-2 text-xs text-fg-subtle">Currently serving: {d.activeHosts.join(", ")}</p>}
            </>
          )
        }
      </PanelState>
    </Card>
  );
}

// ---- Privacy (MC25) -----------------------------------------------------------

const PRIVACY_TONE = { done: "success", manual: "warning" };

function PrivacyPanel({ role }) {
  const { data, err, load } = usePanel("/api/admin/privacy");
  return (
    <Card id="privacy">
      <CardHeader
        title="Privacy & data"
        description="Consent configuration, shopper privacy requests and redactions — the automated lifecycle is webhook-driven; everything here is tracked."
      />
      <PanelState data={data} err={err} load={load} role={role} need="view privacy & data">
        {(d) => (
          <>
            <KeyValue
              className="text-sm"
              items={[
                { key: "Consent", value: `v${d.consent.version}: ${d.consent.purposes.map((p) => p.label).join(" · ")}. ${d.consent.note}` },
                { key: "Retention", value: `orders — ${d.retention.orders}; events — ${d.retention.events}` },
                { key: "Redacted", value: `${d.redacted_orders} order(s) redacted to date` },
              ]}
            />
            {d.requests.length === 0 ? (
              <EmptyState title="No privacy requests received" className="py-6" />
            ) : (
              <ul className="mt-3 divide-y divide-edge">
                {d.requests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                    <Badge tone={PRIVACY_TONE[r.status] || "neutral"} title={String(r.status)}>
                      {r.status}
                    </Badge>
                    <span className="text-fg-muted">{r.kind.replace(/_/g, " ")}</span>
                    <span className="ml-auto text-xs text-fg-subtle">{r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN") : ""}</span>
                    {r.notes && <span className="w-full text-xs text-fg-subtle">{r.notes}</span>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </PanelState>
    </Card>
  );
}

// ---- Audit log (MC26) ----------------------------------------------------------

const AUDIT_COLUMNS = [
  { key: "at", header: "At" },
  { key: "actor", header: "Actor" },
  { key: "action", header: "Action" },
  { key: "resource", header: "Resource" },
];

const auditWhen = (iso) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function AuditPanel({ role }) {
  const { data, err, load } = usePanel("/api/admin/audit?limit=30");
  return (
    <Card id="audit-log">
      <CardHeader
        title="Audit log"
        description="Append-only record of privileged actions on this store — who, what, when. Secrets and shopper PII are redacted at write."
      />
      <PanelState data={data} err={err} load={load} role={role} need="view the audit log">
        {(d) => (
          <Table
            dense
            columns={AUDIT_COLUMNS}
            rows={d.entries || []}
            rowKey={(r, i) => i}
            empty={<EmptyState title="No entries yet" body={d.note} className="py-6" />}
            renderCell={(e, col) => {
              switch (col.key) {
                case "at":
                  return <span className="whitespace-nowrap text-xs text-fg-muted">{auditWhen(e.at)}</span>;
                case "actor":
                  return (
                    <span className="font-mono text-xs text-fg-muted">
                      {e.actor_kind}:{String(e.actor || "").slice(0, 12)}
                    </span>
                  );
                case "action":
                  return <span className="font-mono text-xs font-medium text-fg">{e.action}</span>;
                case "resource":
                  return e.resource ? <span className="break-all font-mono text-xs text-fg-muted">{e.resource}</span> : null;
                default:
                  return e[col.key];
              }
            }}
          />
        )}
      </PanelState>
    </Card>
  );
}

// ---- Help & diagnostics (MC27) -------------------------------------------------

function HelpPanel({ role }) {
  const toast = useToast();
  const { data, err, load } = usePanel("/api/admin/help");
  return (
    <Card id="help">
      <CardHeader
        title="Help & support"
        description="Stuck? Copy the diagnostics below into your message — it's exactly what you see here: status flags and counts, never shopper data."
      />
      <PanelState data={data} err={err} load={load} role={role} need="view diagnostics">
        {(d) => (
          <>
            <pre className="max-h-56 overflow-auto rounded-ctl border border-edge bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed text-fg">
              {JSON.stringify(d.diagnostics, null, 2)}
            </pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                icon={<Copy size={14} aria-hidden />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(JSON.stringify(d.diagnostics, null, 2));
                    toast.success("Diagnostics copied");
                  } catch {
                    toast.error("Couldn't copy — select the text instead");
                  }
                }}
              >
                Copy diagnostics
              </Button>
              <a
                href="mailto:support@storeasy.app?subject=Support%20request"
                className="inline-flex items-center gap-2 rounded-ctl border border-edge-strong bg-surface px-3.5 py-2 text-sm font-medium text-fg focus-ring motion-safe:transition-colors hover:bg-surface-muted"
              >
                <Mail size={14} aria-hidden />
                Email platform support
              </a>
            </div>
          </>
        )}
      </PanelState>
    </Card>
  );
}

export default function OpsPanels({ role }) {
  return (
    <div className="mt-4 space-y-4">
      <TeamPanel role={role} />
      <DomainsPanel role={role} />
      <PrivacyPanel role={role} />
      <AuditPanel role={role} />
      <HelpPanel role={role} />
    </div>
  );
}
