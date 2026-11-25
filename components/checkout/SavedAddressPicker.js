"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { addressValid } from "./checkoutModel";

// Phase 8 line 3: saved addresses at checkout, at AddressStep's
// {/* saved-addresses */} anchor. It finds the shopper itself (GET /api/account;
// the addresses only when signed in, so a signed-out visit asks for nothing it
// can't have) and changes the form only through onAddress(patch, "saved").
//   Signed out: a link to sign in that comes back to checkout.
//   Signed in: one radio card per saved address (the default picked when the
//   form is empty) and "Use a new address". The picked card is whichever one
//   the form matches, so typing over a picked address makes it a new one.
//   A new address with "Save this address to my account" ticked is saved when
//   the shopper continues: this step closes while the checkout stays open.
//   Saving the same address twice keeps one (the server checks too). The tick
//   and the id of an address saved in this checkout live in sessionStorage per
//   cart, so going back from review keeps an unticked box unticked, and fixing
//   an address saved moments ago edits that row instead of adding another.
const PICK = ["name", "phone", "line1", "line2", "city", "state", "pincode"];
const ADDRESS_ONLY = ["line1", "line2", "city", "state", "pincode"];
// a pincode alone (line 1's prefill) still counts as an empty address
const ADDRESS_TYPED = ["line1", "line2", "city", "state"];
const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const matches = (a, form) => PICK.every((k) => norm(a[k]) === norm(form[k]));

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  return res.ok ? res.json().catch(() => null) : null;
}

// What the last mount learned, so a remount (review → Edit) knows the shopper
// at once instead of after its fetches; they still refresh it.
let known = null;

const memoKey = (cartId) => `sf_saved_address:${cartId || "cart"}`;
function readMemo(k) {
  try {
    return JSON.parse(sessionStorage.getItem(k) || "null") || {};
  } catch {
    return {};
  }
}
function writeMemo(k, patch) {
  try {
    sessionStorage.setItem(k, JSON.stringify({ ...readMemo(k), ...patch }));
  } catch {
    // private mode: the tick just isn't remembered
  }
}

export default function SavedAddressPicker({ form, onAddress }) {
  const [state, setState] = useState(() => known?.state || { loaded: false, signedIn: false, email: "", list: [] });
  const [save, setSaveState] = useState(() => (known?.memo && typeof readMemo(known.memo).save === "boolean" ? readMemo(known.memo).save : true));
  const anchor = useRef(null);
  const memo = useRef(known?.memo || null); // the sessionStorage key, once the cart is known
  const latest = useRef({});
  const setSave = (v) => {
    setSaveState(v);
    if (memo.current) writeMemo(memo.current, { save: v });
  };
  const picked = state.list.find((a) => matches(a, form)) || null;
  latest.current = { form, save, signedIn: state.signedIn, picked };

  useEffect(() => {
    let live = true;
    (async () => {
      const me = await getJson("/api/account");
      if (!live) return;
      if (!me?.authenticated) {
        known = null;
        return setState({ loaded: true, signedIn: false, email: "", list: [] });
      }
      const [r, cart] = await Promise.all([getJson("/api/account?view=addresses"), getJson("/api/cart")]);
      if (!live) return;
      memo.current = memoKey(cart?.id);
      const remembered = readMemo(memo.current);
      if (typeof remembered.save === "boolean") setSaveState(remembered.save);
      const list = r?.addresses || [];
      const next = { loaded: true, signedIn: true, email: r?.email || "", list };
      known = { state: next, memo: memo.current };
      setState(next);
      const f = latest.current.form;
      const empty = ADDRESS_TYPED.every((k) => !String(f[k] || "").trim());
      const patch = {};
      if (!String(f.email || "").trim() && r?.email) patch.email = r.email;
      if (empty && list[0]) for (const k of PICK) patch[k] = list[0][k];
      if (Object.keys(patch).length) onAddress(patch, "saved");
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save on Continue: this step unmounts while the checkout stays mounted.
  // Leaving the page removes the checkout too, and then nothing is saved.
  useEffect(() => {
    const flow = anchor.current?.closest('[data-protected="checkout"]') || null;
    return () => {
      const { form: f, save: ticked, signedIn, picked: p } = latest.current;
      if (!flow?.isConnected) {
        known = null; // the page was left: forget the shopper
        return;
      }
      if (!signedIn || p || !ticked || !addressValid(f)) return;
      const key = memo.current;
      const savedId = key ? readMemo(key).savedId : null;
      // an address saved earlier in this checkout is edited, not added again
      const address = { ...Object.fromEntries(PICK.map((k) => [k, f[k]])), ...(savedId ? { id: savedId } : {}) };
      fetch("/api/account", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "address_save", address }) })
        .then((res) => res.json().catch(() => null))
        .then((j) => {
          if (key) writeMemo(key, { savedId: j?.address?.id || null });
        })
        .catch(() => {});
    };
  }, []);

  const useNew = () => onAddress(Object.fromEntries(ADDRESS_ONLY.map((k) => [k, ""])), "saved");
  const choose = (a) => onAddress(Object.fromEntries(PICK.map((k) => [k, a[k]])), "saved");

  return (
    <div ref={anchor} data-saved-addresses="" className="mb-5">
      {state.loaded && !state.signedIn && (
        <p className="text-sm text-sf-text-muted">
          Have an account?{" "}
          <Link href="/account?return=/checkout" className="font-medium text-sf-accent-text underline">
            Sign in to use saved addresses
          </Link>
        </p>
      )}
      {state.signedIn && state.list.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-sf-text-subtle">Saved addresses</legend>
          <div className="space-y-2">
            {state.list.map((a) => (
              <label key={a.id} className={`flex cursor-pointer gap-3 rounded-sf-card border p-3 text-sm ${picked?.id === a.id ? "border-sf-border-hover" : "border-sf-border"}`}>
                <input type="radio" name="saved-address" value={a.id} checked={picked?.id === a.id} onChange={() => choose(a)} className="mt-1" />
                <span className="min-w-0">
                  <span className="font-semibold">{a.label || a.name}</span>
                  {a.is_default && <span className="ml-2 text-xs text-sf-text-faint">Default</span>}
                  <span className="block text-sf-text-muted">
                    {[a.line1, a.line2, `${a.city}, ${a.state} ${a.pincode}`].filter(Boolean).join(", ")}
                  </span>
                </span>
              </label>
            ))}
            <label className={`flex cursor-pointer gap-3 rounded-sf-card border p-3 text-sm ${picked ? "border-sf-border" : "border-sf-border-hover"}`}>
              <input type="radio" name="saved-address" value="new" checked={!picked} onChange={useNew} />
              <span className="font-semibold">Use a new address</span>
            </label>
          </div>
        </fieldset>
      )}
      {state.signedIn && !picked && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" name="save-address" checked={save} onChange={(e) => setSave(e.target.checked)} />
          Save this address to my account
        </label>
      )}
    </div>
  );
}
