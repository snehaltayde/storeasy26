"use client";

import { useEffect, useState, useCallback } from "react";

// Partner administration (S48 / OP14) + case-study authoring (MK06).
// Commercial status here never grants client access — grants are the
// client's act, in their own console.
const btn = "rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold hover:bg-zinc-50 disabled:opacity-40";
const btnDark = "rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40";
const input = "rounded-lg border border-zinc-200 px-2 py-1.5 text-sm outline-none focus:border-zinc-400";
const inr = (minor) => `₹${(Number(minor || 0) / 100).toLocaleString("en-IN")}`;

export default function PartnersPanel() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [newAgency, setNewAgency] = useState("");
  const [invite, setInvite] = useState({ agencyId: "", email: "" });
  const [referral, setReferral] = useState({ tenant: "", agency: "" });
  const [statement, setStatement] = useState(null);
  const [cs, setCs] = useState(null); // case-study form

  const refresh = useCallback(async () => {
    const res = await fetch("/api/platform/partners");
    if (res.ok) setData(await res.json());
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function post(body, label) {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/platform/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setMsg(res.ok ? `${label}: ok${j.token ? ` — code: ${j.token}` : ""}${j.note ? ` (${j.note})` : ""}${j.inserted !== undefined ? ` (${j.inserted} new entries)` : ""}` : `${label}: ${j.error || res.status}`);
    setBusy(false);
    refresh();
    return res.ok ? j : null;
  }

  if (!data) return null;
  const { agencies, grants, referrals, caseStudies } = data;

  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
      <h2 className="text-sm font-bold">Partners (agencies)</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Verification, referral eligibility and commission rates are COMMERCIAL state — they grant no client access.
        Access exists only where a client accepted a grant in their own console, and it revokes instantly.
      </p>
      {msg && <p className="mt-2 break-all text-xs text-zinc-500">{msg}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input className={input} placeholder="New agency name" value={newAgency} onChange={(e) => setNewAgency(e.target.value)} />
        <button type="button" className={btn} disabled={busy || !newAgency.trim()} onClick={async () => (await post({ agency: { name: newAgency } }, "create")) && setNewAgency("")}>
          Create agency
        </button>
      </div>

      <ul className="mt-3 space-y-2 text-sm">
        {agencies.map((a) => (
          <li key={a.id} className="rounded-xl border border-zinc-100 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{a.name}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${a.status === "verified" ? "bg-lime-100 text-lime-700" : a.status === "suspended" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>{a.status}</span>
              <span className="text-xs text-zinc-400">{a.members} members · {a.clients} client stores · {a.commission_bps / 100}%{a.referral_eligible ? " · referral-eligible" : ""}</span>
              <span className="ml-auto flex gap-1.5">
                {a.status !== "verified" && (
                  <button type="button" className={btn} disabled={busy} onClick={() => post({ status: { id: a.id, status: "verified" } }, "verify")}>
                    Verify
                  </button>
                )}
                <button type="button" className={btn} disabled={busy} onClick={() => post({ status: { id: a.id, referral_eligible: !a.referral_eligible } }, "eligibility")}>
                  {a.referral_eligible ? "Disable referrals" : "Enable referrals"}
                </button>
                <button type="button" className={btn} disabled={busy} onClick={() => post({ status: { id: a.id, status: a.status === "suspended" ? "verified" : "suspended" } }, "suspend")}>
                  {a.status === "suspended" ? "Unsuspend" : "Suspend"}
                </button>
                <button type="button" className={btn} onClick={async () => { const res = await fetch(`/api/platform/partners?statement=${a.id}`); if (res.ok) setStatement({ agency: a.name, ...(await res.json()).statement }); }}>
                  Statement
                </button>
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <input className={input} placeholder="member@agency.com" value={invite.agencyId === a.id ? invite.email : ""} onChange={(e) => setInvite({ agencyId: a.id, email: e.target.value })} />
              <button type="button" className={btn} disabled={busy || invite.agencyId !== a.id || !invite.email} onClick={async () => (await post({ member_invite: invite }, "member invite")) && setInvite({ agencyId: "", email: "" })}>
                Invite member
              </button>
            </div>
          </li>
        ))}
      </ul>

      {/* referrals */}
      <div className="mt-5 rounded-xl bg-zinc-50 p-3">
        <h3 className="text-xs font-bold">Referral attribution</h3>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <input className={input} placeholder="tenant slug" value={referral.tenant} onChange={(e) => setReferral({ ...referral, tenant: e.target.value })} />
          <select className={input} value={referral.agency} onChange={(e) => setReferral({ ...referral, agency: e.target.value })}>
            <option value="">agency…</option>
            {agencies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="button" className={btn} disabled={busy || !referral.tenant || !referral.agency} onClick={() => post({ referral }, "attribute")}>
            Attribute
          </button>
          <button type="button" className={btn} disabled={busy} onClick={() => post({ recompute: true }, "recompute commissions")}>
            Recompute commissions
          </button>
        </div>
        {referrals.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-zinc-600">
            {referrals.map((r) => (
              <li key={r.tenant_id} className="flex items-center gap-2">
                <span className="font-semibold">{r.tenant_id}</span>→ {r.agency_name}
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${r.status === "attributed" ? "bg-lime-100 text-lime-700" : "bg-zinc-100 text-zinc-400"}`}>{r.status}</span>
                {r.status === "attributed" && (
                  <button type="button" className="text-red-500 hover:underline" disabled={busy} onClick={() => post({ void_referral: { tenant: r.tenant_id, note: "operator dispute" } }, "void")}>
                    void (dispute)
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {statement && (
        <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/40 p-3 text-xs">
          <div className="flex items-center justify-between">
            <h3 className="font-bold">Statement — {statement.agency}</h3>
            <button type="button" className={btn} onClick={() => setStatement(null)}>
              Close
            </button>
          </div>
          <p className="mt-1 text-zinc-500">{statement.payoutsNote}</p>
          {statement.months.length === 0 ? (
            <p className="mt-1 text-zinc-400">No commission events.</p>
          ) : (
            statement.months.map((m) => (
              <p key={m.period}>
                {m.period}: earned {inr(m.earned)} · reversed {inr(m.reversed)} · net <strong>{inr(m.net)}</strong> ({m.events} events)
              </p>
            ))
          )}
        </div>
      )}

      {/* grants overview (read + revoke) */}
      {grants.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-bold">Grants across the fleet ({grants.length})</summary>
          <ul className="mt-2 space-y-1 text-xs text-zinc-600">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center gap-2">
                <span className="font-semibold">{g.agency_name}</span>→ {g.tenant_id || `(pending: ${g.client_email})`} · {g.role} ·
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${g.status === "accepted" ? "bg-lime-100 text-lime-700" : "bg-zinc-100 text-zinc-400"}`}>{g.status}</span>
                {["pending", "accepted"].includes(g.status) && (
                  <button type="button" className="text-red-500 hover:underline" disabled={busy} onClick={() => post({ revoke_grant: { id: g.id } }, "revoke grant")}>
                    revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* MK06 case studies */}
      <div className="mt-5 rounded-xl bg-zinc-50 p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold">Case studies (marketing site)</h3>
          <button type="button" className={btn} onClick={() => setCs({ slug: "", title: "", tenant_id: "", consent_ref: "", period: "", baseline: "", method: "", limitations: "", confounders: "", results: [{ metric: "", before: "", after: "" }], quote: "", quote_by: "", body: "" })}>
            New case study
          </button>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">Publishing is gated: documented merchant consent + measurement period/method/results + limitations/confounders — a lift claim without its measurement record cannot publish.</p>
        <ul className="mt-2 space-y-1 text-xs text-zinc-600">
          {caseStudies.map((c) => (
            <li key={c.slug} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{c.title}</span>
              <span className="text-zinc-400">/customers/{c.slug}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${c.published ? "bg-lime-100 text-lime-700" : "bg-zinc-100 text-zinc-500"}`}>{c.published ? "published" : "draft"}</span>
              {!c.published && c.publishBlocks.length > 0 && <span className="text-amber-600">blocked: {c.publishBlocks[0]}{c.publishBlocks.length > 1 ? ` (+${c.publishBlocks.length - 1})` : ""}</span>}
              <span className="ml-auto flex gap-1.5">
                <button type="button" className={btn} onClick={() => setCs({ ...c, results: c.results.length ? c.results : [{ metric: "", before: "", after: "" }] })}>
                  Edit
                </button>
                <button type="button" className={btn} disabled={busy} onClick={() => post({ publish_case: { slug: c.slug, published: !c.published } }, c.published ? "unpublish" : "publish")}>
                  {c.published ? "Unpublish" : "Publish"}
                </button>
                <button type="button" className={btn} disabled={busy} onClick={() => post({ delete_case: { slug: c.slug } }, "delete")}>
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
        {cs && (
          <div className="mt-3 grid gap-2 rounded-xl border border-zinc-200 bg-white p-3 text-xs sm:grid-cols-2">
            {[["slug", "slug"], ["title", "Title"], ["tenant_id", "Tenant (slug)"], ["consent_ref", "Consent ref (who approved, when, how)"], ["period", "Measurement period"], ["baseline", "Baseline"], ["method", "Method"], ["limitations", "Limitations"], ["confounders", "Confounders (or 'none known')"], ["quote", "Quote (with usage rights)"], ["quote_by", "Quote attribution"]].map(([k, label]) => (
              <input key={k} className={input} placeholder={label} value={cs[k] || ""} onChange={(e) => setCs({ ...cs, [k]: e.target.value })} />
            ))}
            <textarea className={`${input} min-h-20 sm:col-span-2`} placeholder="Narrative body" value={cs.body || ""} onChange={(e) => setCs({ ...cs, body: e.target.value })} />
            <div className="sm:col-span-2">
              <p className="font-semibold text-zinc-600">Measured results (before → after)</p>
              {cs.results.map((r, i) => (
                <div key={i} className="mt-1 flex gap-2">
                  <input className={`${input} flex-1`} placeholder="metric" value={r.metric} onChange={(e) => setCs({ ...cs, results: cs.results.map((x, j) => (j === i ? { ...x, metric: e.target.value } : x)) })} />
                  <input className={`${input} w-24`} placeholder="before" value={r.before} onChange={(e) => setCs({ ...cs, results: cs.results.map((x, j) => (j === i ? { ...x, before: e.target.value } : x)) })} />
                  <input className={`${input} w-24`} placeholder="after" value={r.after} onChange={(e) => setCs({ ...cs, results: cs.results.map((x, j) => (j === i ? { ...x, after: e.target.value } : x)) })} />
                </div>
              ))}
              <button type="button" className={`${btn} mt-1.5`} onClick={() => setCs({ ...cs, results: [...cs.results, { metric: "", before: "", after: "" }] })}>
                + result
              </button>
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className={btnDark} disabled={busy} onClick={async () => (await post({ case_study: cs }, "save case study")) && setCs(null)}>
                Save draft
              </button>
              <button type="button" className={btn} onClick={() => setCs(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
