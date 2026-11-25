"use client";

import { useState } from "react";
import AddressForm from "./AddressForm";

// /account "Addresses" (Phase 8 line 3): the shopper's saved addresses, default
// first. Add, edit, set default and delete (a real delete, after a confirm).
// Every change goes through /api/account and redraws from its answer.
export const MAX_ADDRESSES = 10;

export function addressLines(a) {
  return [a.line1, a.line2, `${a.city}, ${a.state} ${a.pincode}`].filter(Boolean).join(", ");
}

async function post(body) {
  const res = await fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return res.ok && json.ok ? { ok: true, json } : { ok: false, error: json.error || "That didn't work. Please try again." };
}

export default function AddressBook({ initial = [] }) {
  const [list, setList] = useState(initial);
  const [editing, setEditing] = useState(null); // null | "new" | address id
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function run(body, done) {
    setBusy(true);
    setMsg(null);
    const r = await post(body);
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setList(r.json.addresses || []);
    done?.(r.json);
  }

  const save = (address, makeDefault) =>
    run({ action: "address_save", address, makeDefault }, (j) => {
      setEditing(null);
      setMsg({ ok: true, text: j.duplicate ? "You already have this address saved." : "Address saved." });
    });

  return (
    <section aria-labelledby="addresses-heading" className="rounded-sf-card border border-sf-border p-5">
      <div className="flex items-center justify-between">
        <h2 id="addresses-heading" className="text-sm font-bold">Addresses</h2>
        {editing === null && list.length < MAX_ADDRESSES && (
          <button type="button" onClick={() => setEditing("new")} className="text-xs font-semibold text-sf-accent-text hover:underline">
            Add an address
          </button>
        )}
      </div>
      {msg && <p role="status" className={`mt-3 rounded-sf-small px-3 py-2 text-sm ${msg.ok ? "bg-sf-success-surface text-sf-success" : "bg-sf-danger-surface text-sf-danger"}`}>{msg.text}</p>}
      {list.length === 0 && editing === null && <p className="mt-3 text-sm text-sf-text-subtle">No saved addresses yet. Save one here or at checkout to fill it in with one tap next time.</p>}
      {list.length >= MAX_ADDRESSES && <p className="mt-3 text-xs text-sf-text-faint">You have {MAX_ADDRESSES} saved addresses, the most you can keep. Delete one to add another.</p>}
      {editing === "new" && (
        <div className="mt-4">
          <AddressForm showDefault={list.length > 0} busy={busy} onSave={save} onCancel={() => setEditing(null)} />
        </div>
      )}
      <ul className="mt-4 space-y-3">
        {list.map((a) =>
          editing === a.id ? (
            <li key={a.id}>
              <AddressForm initial={a} showDefault={!a.is_default} busy={busy} onSave={(x, d) => save({ ...x, id: a.id }, d)} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={a.id} data-address={a.id} className="rounded-sf-card border border-sf-border p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{a.label || a.name}</span>
                {a.is_default && <span className="rounded-sf-2xs bg-sf-surface-sunken px-1.5 py-0.5 text-sf-3xs font-bold uppercase text-sf-text-subtle">Default</span>}
              </div>
              {a.label && <p className="mt-1">{a.name}</p>}
              <p className="text-sf-text-muted">{addressLines(a)}</p>
              <p className="text-sf-text-muted">{a.phone}</p>
              {confirming === a.id ? (
                <div className="mt-3 rounded-sf-small bg-sf-surface-muted p-3">
                  <p>Delete this address? Past orders keep their copy.</p>
                  <div className="mt-2 flex gap-3">
                    <button type="button" disabled={busy} onClick={() => run({ action: "address_delete", id: a.id }, () => { setConfirming(null); setMsg({ ok: true, text: "Address deleted." }); })} className="text-xs font-semibold text-sf-danger hover:underline">
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="text-xs font-semibold hover:underline">
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-4 text-xs font-semibold">
                  <button type="button" onClick={() => setEditing(a.id)} className="text-sf-accent-text hover:underline">Edit</button>
                  {!a.is_default && (
                    <button type="button" disabled={busy} onClick={() => run({ action: "address_default", id: a.id }, () => setMsg({ ok: true, text: "Default address changed." }))} className="text-sf-accent-text hover:underline">
                      Make default
                    </button>
                  )}
                  <button type="button" onClick={() => setConfirming(a.id)} className="text-sf-text-faint hover:text-sf-danger">Delete</button>
                </div>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
