"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

// Agency console (S48 / AG01–06). Everything here runs against grants the
// CLIENT accepted — revocation anywhere is immediate on the next call.
const btn = "rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-40";
const btnDark = "rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40";
const input = "rounded-lg border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-zinc-400";
const chip = (cls) => `rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${cls}`;
const inr = (minor) => `₹${(Number(minor || 0) / 100).toLocaleString("en-IN")}`;

export default function PartnersConsole({ agency, email }) {
  const router = useRouter();
  const [portfolio, setPortfolio] = useState(null);
  const [grants, setGrants] = useState([]);
  const [kits, setKits] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [referrals, setReferrals] = useState(null);
  const [report, setReport] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState({ clientEmail: "", role: "staff" });

  const refresh = useCallback(async () => {
    for (const [view, set] of [["portfolio", (d) => setPortfolio(d.portfolio)], ["grants", (d) => setGrants(d.grants)], ["kits", (d) => setKits(d.kits)], ["approvals", (d) => setApprovals(d.approvals)], ["referrals", (d) => setReferrals(d)]]) {
      const res = await fetch(`/api/partners?view=${view}`);
      if (res.ok) set(await res.json());
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function post(body) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "err", text: json.error || "Request failed" });
      return null;
    }
    return json;
  }

  const STATUS_CHIP = { pending: "bg-amber-100 text-amber-700", accepted: "bg-lime-100 text-lime-700", revoked: "bg-zinc-100 text-zinc-400", expired: "bg-zinc-100 text-zinc-400", approved: "bg-lime-100 text-lime-700", rejected: "bg-red-100 text-red-700" };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{agency.name}</h1>
          <p className="text-xs text-zinc-400">
            {email} · <span className={chip(agency.status === "verified" ? "bg-lime-100 text-lime-700" : "bg-amber-100 text-amber-700")}>{agency.status}</span>
            {agency.referral_eligible && <span className="ml-1 text-zinc-400">referrals at {agency.commission_bps / 100}%</span>}
          </p>
        </div>
        <button
          type="button"
          className={btn}
          onClick={async () => {
            await fetch("/api/partners/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
            router.refresh();
          }}
        >
          Sign out
        </button>
      </div>

      {msg && <p className={`mt-4 rounded-lg px-3 py-2 text-sm ${msg.kind === "err" ? "bg-red-50 text-red-600" : "bg-lime-50 text-lime-800"}`}>{msg.text}</p>}

      {/* AG01 portfolio */}
      <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
        <h2 className="text-sm font-bold">Client stores</h2>
        <p className="mt-0.5 text-xs text-zinc-500">Only stores whose owner accepted your access. Revocation takes effect immediately.</p>
        {portfolio === null ? (
          <p className="mt-3 text-sm text-zinc-400">Loading…</p>
        ) : portfolio.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-400">No client stores yet — invite a client below.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {portfolio.map((c) => (
              <li key={c.tenant} className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-100 p-3">
                <span className="font-semibold">{c.name}</span>
                <span className={chip("bg-zinc-100 text-zinc-500")}>{c.role}</span>
                <span className="text-xs text-zinc-400">{c.currency} · {c.timezone}</span>
                {c.reachable ? (
                  <span className="text-xs text-zinc-500">{c.health.products} live products · {c.health.orders30} orders (30d) · {c.health.openReturns} open returns</span>
                ) : (
                  <span className="text-xs text-amber-600">unreachable</span>
                )}
                {c.pendingApprovals > 0 && <span className={chip("bg-amber-100 text-amber-700")}>{c.pendingApprovals} review pending</span>}
                <span className="ml-auto flex gap-2">
                  <button type="button" className={btn} onClick={async () => { const res = await fetch(`/api/partners?view=report&tenant=${c.tenant}`); const j = await res.json(); if (res.ok) setReport(j.report); else setMsg({ kind: "err", text: j.error }); }}>
                    Report
                  </button>
                  <button type="button" className={btn} disabled={busy} onClick={async () => { const r = await post({ kit_export: { tenant: c.tenant } }); if (r) { setMsg({ kind: "ok", text: `Kit "${r.kit.name}" saved — scrubbed structure only.` }); refresh(); } }}>
                    Export kit
                  </button>
                  <button type="button" className={btn} disabled={busy} onClick={async () => { const r = await post({ approval: { tenant: c.tenant } }); if (r) setMsg({ kind: "ok", text: `${r.note} — code: ${r.token}` }); refresh(); }}>
                    Request review
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* AG02 invitations */}
      <section className="mt-6 rounded-2xl border border-zinc-200 p-5">
        <h2 className="text-sm font-bold">Invite a client</h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          The code binds to the client&rsquo;s email and expires in 7 days; they accept it in their own console
          (Settings → Agency access). Ownership transfer is deliberately not offered — grants never escalate to owner.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input type="email" placeholder="client-owner@store.com" className={`${input} min-w-56`} value={invite.clientEmail} onChange={(e) => setInvite({ ...invite, clientEmail: e.target.value })} />
          <select className={input} value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
            <option value="support">support (read-only)</option>
            <option value="staff">staff (content & offers)</option>
            <option value="admin">admin (settings too)</option>
          </select>
          <button type="button" className={btnDark} disabled={busy} onClick={async () => { const r = await post({ invite }); if (r) { setMsg({ kind: "ok", text: `${r.note} — code: ${r.token}` }); setInvite({ clientEmail: "", role: "staff" }); refresh(); } }}>
            Create invitation
          </button>
        </div>
        {grants.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-xs text-zinc-500">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center gap-2">
                <span className={chip(STATUS_CHIP[g.status])}>{g.status}</span>
                <span>{g.client_email}</span>
                <span>· {g.role}</span>
                {g.tenant_id && <span>· {g.tenant_id}</span>}
                {["pending", "accepted"].includes(g.status) && (
                  <button type="button" className="text-red-500 hover:underline" disabled={busy} onClick={async () => (await post({ revoke: { id: g.id } })) && refresh()}>
                    revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* AG03 kits */}
      {kits.length > 0 && (
        <section className="mt-6 rounded-2xl border border-zinc-200 p-5">
          <h2 className="text-sm font-bold">Private kits</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Scrubbed structure only — no customer data, keys, domains, media or catalog ids survive export. Applying
            writes DRAFTS on the destination; the client publishes. Brand tokens come back as a suggestion, never
            auto-applied.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {kits.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-100 p-2.5">
                <span className="font-semibold">{k.name}</span>
                <span className="text-xs text-zinc-400">from {k.source_note} · {Object.keys(k.payload).join(", ")}</span>
                <span className="ml-auto flex items-center gap-1 text-xs">
                  apply to
                  {(portfolio || []).map((c) => (
                    <button key={c.tenant} type="button" className={btn} disabled={busy} onClick={async () => { const r = await post({ kit_apply: { kit: k.id, tenant: c.tenant } }); if (r) setMsg({ kind: "ok", text: `${r.note} (${r.written.join(", ")})${r.brandSuggestion ? " · brand tokens suggested — client applies them in their Brand tab" : ""}` }); }}>
                      {c.name}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* AG04 approvals */}
      {approvals.length > 0 && (
        <section className="mt-6 rounded-2xl border border-zinc-200 p-5">
          <h2 className="text-sm font-bold">Client reviews</h2>
          <p className="mt-0.5 text-xs text-zinc-500">Each link is signed, expiring, and bound to one draft hash — approvals never carry over to changed drafts.</p>
          <ul className="mt-3 space-y-1.5 text-xs">
            {approvals.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className={chip(STATUS_CHIP[a.status] || "bg-zinc-100 text-zinc-500")}>{a.status}</span>
                <span className="font-semibold">{a.tenant_id}</span>
                <code className="font-mono text-zinc-400">{a.content_hash.slice(0, 12)}</code>
                {a.approver && <span className="text-zinc-500">by {a.approver}</span>}
                {a.comment && <span className="text-zinc-400">“{a.comment}”</span>}
                {a.status === "approved" && a.current === false && <span className={chip("bg-amber-100 text-amber-700")}>stale — draft changed since</span>}
                {a.status === "approved" && a.current === true && <span className={chip("bg-lime-100 text-lime-700")}>current draft</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* AG05 referrals */}
      {referrals && (
        <section className="mt-6 rounded-2xl border border-zinc-200 p-5">
          <h2 className="text-sm font-bold">Referrals & earnings</h2>
          {!referrals.eligible ? (
            <p className="mt-2 text-sm text-zinc-400">Referral earnings aren&rsquo;t enabled for this agency yet — that&rsquo;s a platform-side setting.</p>
          ) : (
            <>
              <p className="mt-0.5 text-xs text-zinc-500">
                {referrals.commission_bps / 100}% of eligible COLLECTED revenue on referred stores. Refunds reverse the
                matching commission exactly once. {referrals.statement.payoutsNote}.
              </p>
              {referrals.statement.months.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-400">No commission events yet.</p>
              ) : (
                <table className="mt-3 w-full text-xs">
                  <thead>
                    <tr className="text-left text-zinc-400">
                      <th className="py-1 font-medium">month</th>
                      <th className="font-medium">earned</th>
                      <th className="font-medium">reversed</th>
                      <th className="font-medium">net</th>
                      <th className="font-medium">events</th>
                    </tr>
                  </thead>
                  <tbody>
                    {referrals.statement.months.map((m) => (
                      <tr key={m.period} className="border-t border-zinc-100">
                        <td className="py-1 font-semibold">{m.period}</td>
                        <td>{inr(m.earned)}</td>
                        <td className="text-red-600">{inr(m.reversed)}</td>
                        <td className="font-semibold">{inr(m.net)}</td>
                        <td>{m.events}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>
      )}

      {/* AG06 report viewer */}
      {report && (
        <section className="mt-6 rounded-2xl border border-sky-200 bg-sky-50/40 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold">
              {report.name} — 30 days <span className="font-normal text-zinc-400">({report.currency}, {report.timezone})</span>
            </h2>
            <button type="button" className={btn} onClick={() => setReport(null)}>
              Close
            </button>
          </div>
          <p className="mt-1 text-[11px] text-zinc-400">Prepared by {agency.name} · generated {new Date(report.generated_at).toLocaleString("en-IN")} · this report contains only this client&rsquo;s data.</p>
          <div className="mt-3 flex flex-wrap gap-3 text-xs">
            <span className="rounded-lg bg-white px-3 py-2">orders: {report.sales?.orders ?? "—"}</span>
            <span className="rounded-lg bg-white px-3 py-2">net sales: {report.sales?.net != null ? `₹${Number(report.sales.net).toLocaleString("en-IN")}` : "—"}</span>
            <span className="rounded-lg bg-white px-3 py-2">refunds: {report.sales?.refunds != null ? `₹${Number(report.sales.refunds).toLocaleString("en-IN")}` : "—"}</span>
          </div>
          {report.topProducts?.products?.length > 0 && (
            <ul className="mt-3 text-xs text-zinc-600">
              {report.topProducts.products.slice(0, 5).map((p, i) => (
                <li key={i}>
                  {i + 1}. {p.title} — {p.qty} units · ₹{Number(p.revenue || 0).toLocaleString("en-IN")}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
