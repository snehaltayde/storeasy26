"use client";

import { useEffect, useState } from "react";

// Merchant ops panels (S43): Team (MC23), Domains & SEO (MC21), Privacy
// (MC25), Audit log (MC26), Help & diagnostics (MC27) — appended to the
// Settings page. Each panel speaks to its own API and renders an honest
// no-access / unsupported state instead of hiding.

const input = "mt-1 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400";

function usePanel(url) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = () =>
    fetch(url)
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))
      .then(({ status, json }) => {
        if (json.ok) setData(json);
        else setErr(status === 403 ? "Your role can't view this section." : json.error || `failed (${status})`);
      })
      .catch((e) => setErr(String(e)));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [data, err, load, setData, setErr];
}

const Panel = ({ title, desc, children }) => (
  <section className="rounded-2xl border border-zinc-200 p-5">
    <h2 className="text-sm font-bold">{title}</h2>
    {desc && <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>}
    <div className="mt-3">{children}</div>
  </section>
);

// ---- Team (MC23) -------------------------------------------------------------

function TeamPanel() {
  const [data, err, load, setData, setErr] = usePanel("/api/admin/team");
  const [form, setForm] = useState({ email: "", role: "staff" });
  const [inviteUrl, setInviteUrl] = useState(null);
  const [busy, setBusy] = useState(false);

  async function post(body) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/admin/team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      setData(json);
      if (json.inviteUrl) setInviteUrl(`${window.location.origin}${json.inviteUrl}`);
    } else setErr(json.error || `failed (${res.status})`);
    setBusy(false);
  }

  return (
    <Panel title="Team & permissions" desc="Roles: owner (everything) · admin (ops + settings) · staff (merchandising) · support (read-only). A store can never lose its last owner.">
      {err && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}
      {data && !data.supported && <p className="text-sm text-zinc-400">{data.reason}</p>}
      {data?.supported && (
        <>
          <ul className="divide-y divide-zinc-100">
            {data.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{m.email}</span>
                  {m.name && <span className="ml-2 text-xs text-zinc-400">{m.name}</span>}
                </span>
                <select value={m.role} disabled={busy} onChange={(e) => post({ action: "role", userId: m.id, role: e.target.value })} className="rounded-lg border border-zinc-200 px-2 py-1 text-xs">
                  {["owner", "admin", "staff", "support"].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button type="button" disabled={busy} onClick={() => window.confirm(`Remove ${m.email} from this store?`) && post({ action: "remove", userId: m.id })} className="text-xs text-zinc-400 hover:text-red-600">
                  remove
                </button>
              </li>
            ))}
            {data.members.length === 0 && <li className="py-3 text-sm text-zinc-400">No individual accounts yet — this store still runs on the bootstrap password. Invite yourself first.</li>}
          </ul>
          {data.invites.length > 0 && (
            <p className="mt-2 text-xs text-zinc-400">Pending: {data.invites.map((i) => `${i.email} (${i.role})`).join(", ")}</p>
          )}
          {inviteUrl && (
            <p className="mt-2 break-all rounded-lg bg-lime-50 px-3 py-2 text-xs text-lime-800">
              Invitation link (shown once — send it yourself): <code>{inviteUrl}</code>
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="min-w-48 flex-1">
              <span className="text-xs font-semibold text-zinc-600">Email</span>
              <input className={input} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="teammate@store.in" />
            </label>
            <label>
              <span className="text-xs font-semibold text-zinc-600">Role</span>
              <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {["admin", "staff", "support", "owner"].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={busy || !form.email} onClick={() => post({ action: "invite", email: form.email, role: form.role })} className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40">
              Invite
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

// ---- Domains & SEO (MC21) -----------------------------------------------------

function DomainsPanel() {
  const [data, err, load, setData, setErr] = usePanel("/api/admin/domains");
  const [busy, setBusy] = useState(false);

  async function verify(host) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/admin/domains", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", host }) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      setData((d) => ({ ...d, domains: json.domains }));
      if (!json.result?.verified) setErr(`TXT record not found yet for ${host} — DNS can take a few minutes to propagate.`);
    } else setErr(json.error || `failed (${res.status})`);
    setBusy(false);
  }

  return (
    <Panel title="Domains & SEO" desc="Your storefront answers on these hosts. Robots + sitemap are per-tenant and release-aware; campaigns stay noindex.">
      {err && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{err}</p>}
      {data && !data.supported && <p className="text-sm text-zinc-400">{data.reason}</p>}
      {data?.supported && (
        <>
          <ul className="space-y-2">
            {data.domains.map((d) => (
              <li key={d.host} className="rounded-xl border border-zinc-100 p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{d.host}</span>
                  {d.verified ? (
                    <span className="rounded bg-lime-100 px-1.5 py-0.5 text-[10px] font-bold text-lime-700">VERIFIED</span>
                  ) : (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">PENDING DNS PROOF</span>
                  )}
                  {d.primary && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold text-zinc-500">PRIMARY</span>}
                  {!d.verified && (
                    <button type="button" disabled={busy} onClick={() => verify(d.host)} className="ml-auto rounded-lg bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">
                      Verify now
                    </button>
                  )}
                </p>
                {d.challenge && (
                  <div className="mt-2 rounded-lg bg-zinc-50 p-2 font-mono text-xs text-zinc-600">
                    <p>Add this DNS record, then press Verify:</p>
                    <p className="mt-1">TXT &nbsp;{d.challenge.record}</p>
                    <p className="break-all">{d.challenge.value}</p>
                  </div>
                )}
              </li>
            ))}
            {data.domains.length === 0 && (
              <li className="text-sm text-zinc-400">
                No custom domain claimed yet. Tell the platform operator which host you want (e.g. shop.yourbrand.in) — they claim it, you add the TXT record and verify here.
              </li>
            )}
          </ul>
          {data.activeHosts?.length > 0 && <p className="mt-2 text-xs text-zinc-400">Currently serving: {data.activeHosts.join(", ")}</p>}
        </>
      )}
    </Panel>
  );
}

// ---- Privacy (MC25) -----------------------------------------------------------

function PrivacyPanel() {
  const [data, err] = usePanel("/api/admin/privacy");
  const chip = (s) => (s === "done" ? "bg-lime-100 text-lime-700" : s === "manual" ? "bg-amber-100 text-amber-700" : "bg-zinc-100 text-zinc-500");
  return (
    <Panel title="Privacy & data" desc="Consent configuration, shopper privacy requests and redactions — the automated lifecycle is webhook-driven; everything here is tracked.">
      {err && <p className="text-sm text-red-600">{err}</p>}
      {data && (
        <>
          <p className="text-xs text-zinc-500">
            Consent v{data.consent.version}: {data.consent.purposes.map((p) => p.label).join(" · ")}. {data.consent.note}
          </p>
          <p className="mt-2 text-xs text-zinc-500">
            Retention: orders — {data.retention.orders}; events — {data.retention.events}.
          </p>
          <p className="mt-2 text-sm">
            <span className="font-semibold">{data.redacted_orders}</span> order(s) redacted to date.
          </p>
          <ul className="mt-2 divide-y divide-zinc-100">
            {data.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${chip(r.status)}`}>{r.status}</span>
                <span className="text-zinc-600">{r.kind.replace(/_/g, " ")}</span>
                <span className="ml-auto text-xs text-zinc-400">{r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN") : ""}</span>
                {r.notes && <span className="w-full text-xs text-zinc-400">{r.notes}</span>}
              </li>
            ))}
            {data.requests.length === 0 && <li className="py-2 text-sm text-zinc-400">No privacy requests received.</li>}
          </ul>
        </>
      )}
    </Panel>
  );
}

// ---- Audit log (MC26) ----------------------------------------------------------

function AuditPanel() {
  const [data, err] = usePanel("/api/admin/audit?limit=30");
  return (
    <Panel title="Audit log" desc="Append-only record of privileged actions on this store — who, what, when. Secrets and shopper PII are redacted at write.">
      {err && <p className="text-sm text-red-600">{err}</p>}
      {data && (
        <ul className="divide-y divide-zinc-100 font-mono text-xs">
          {(data.entries || []).map((e, i) => (
            <li key={i} className="flex flex-wrap gap-2 py-1.5">
              <span className="text-zinc-400">{new Date(e.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="font-semibold text-zinc-700">{e.action}</span>
              {e.resource && <span className="text-zinc-500">{e.resource}</span>}
              <span className="ml-auto text-zinc-400">{e.actor_kind}:{String(e.actor || "").slice(0, 12)}</span>
            </li>
          ))}
          {(data.entries || []).length === 0 && <li className="py-2 font-sans text-sm text-zinc-400">{data.note || "No entries yet."}</li>}
        </ul>
      )}
    </Panel>
  );
}

// ---- Help & diagnostics (MC27) -------------------------------------------------

function HelpPanel() {
  const [data, err] = usePanel("/api/admin/help");
  const [copied, setCopied] = useState(false);
  return (
    <Panel title="Help & support" desc="Stuck? Copy the diagnostics below into your message — it's exactly what you see here: status flags and counts, never shopper data.">
      {err && <p className="text-sm text-red-600">{err}</p>}
      {data && (
        <>
          <pre className="max-h-56 overflow-auto rounded-xl bg-zinc-900 p-3 text-[11px] leading-relaxed text-lime-300">{JSON.stringify(data.diagnostics, null, 2)}</pre>
          <div className="mt-2 flex gap-3">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(JSON.stringify(data.diagnostics, null, 2));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch { /* clipboard blocked */ }
              }}
              className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800"
            >
              {copied ? "Copied ✓" : "Copy diagnostics"}
            </button>
            <a href="mailto:support@storeasy.app?subject=Support%20request" className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50">
              Email platform support
            </a>
          </div>
        </>
      )}
    </Panel>
  );
}

export default function OpsPanels() {
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 pb-10 sm:px-6">
      <TeamPanel />
      <DomainsPanel />
      <PrivacyPanel />
      <AuditPanel />
      <HelpPanel />
    </div>
  );
}
