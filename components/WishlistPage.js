"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { readLocalWishlist, writeLocalWishlist } from "./WishlistButton";

// Wishlist page (S49 / SF22). Two clearly separated lists: the LOCAL one
// (this browser only) and — when signed in — the ACCOUNT one. The ONLY
// bridge between them is the explicit merge button; nothing joins
// identities on its own. Unavailable and gone items stay visible and
// labeled instead of quietly disappearing.
const inr = (n, c = "INR") => `₹${Number(n || 0).toLocaleString("en-IN")}`;

const STATE_LABEL = {
  unavailable: "sold out right now",
  gone: "no longer in the catalog",
};

function Row({ item, onRemove }) {
  const dim = item.state !== "ok";
  return (
    <li className="flex items-center gap-3 py-3">
      {item.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.image} alt="" className={`h-14 w-14 rounded-sf-small object-cover ${dim ? "opacity-40 grayscale" : ""}`} />
      ) : (
        // P1-CONTRAST: the missing-photo "?" is muted text on the image well
        // (pair text-muted-sunken), readable on every look, the default one too.
        // It was the mark role (1.34:1 on the default look, 4.19:1 on Glow).
        <span className="flex h-14 w-14 items-center justify-center rounded-sf-small bg-sf-surface-sunken text-sf-text-muted">?</span>
      )}
      <span className="min-w-0 flex-1">
        {item.state === "gone" ? (
          <span className="block truncate font-semibold text-sf-text-faint">{item.handle}</span>
        ) : (
          <Link href={`/products/${item.handle}`} className={`block truncate font-semibold hover:underline ${dim ? "text-sf-text-faint" : ""}`}>
            {item.title}
          </Link>
        )}
        {dim ? <span className="text-xs text-sf-warning">{STATE_LABEL[item.state]}</span> : <span className="text-xs text-sf-text-subtle">{inr(item.price, item.currency)}</span>}
      </span>
      <button type="button" onClick={onRemove} className="text-xs text-sf-text-faint hover:text-sf-danger">
        remove
      </button>
    </li>
  );
}

export default function WishlistPage() {
  const [local, setLocal] = useState(null); // resolved local items
  const [account, setAccount] = useState(null); // resolved account items (if authed)
  const [authed, setAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const refresh = useCallback(async () => {
    const raw = readLocalWishlist();
    if (raw.length) {
      const res = await fetch("/api/wishlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: raw }) });
      const json = await res.json().catch(() => ({}));
      setLocal(json.ok ? json.items : []);
    } else {
      setLocal([]);
    }
    const acc = await fetch("/api/account?view=wishlist").then((r) => r.json()).catch(() => null);
    if (acc?.authenticated) {
      setAuthed(true);
      setAccount(acc.items || []);
    } else {
      setAuthed(false);
      setAccount(null);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function merge() {
    setBusy(true);
    setNote(null);
    const res = await fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "wishlist_merge", items: readLocalWishlist() }) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && json.ok) {
      writeLocalWishlist([]); // merged — the account copy is now the saved one
      setNote(`Merged: ${json.added} added${json.deduped ? `, ${json.deduped} already saved` : ""}.`);
      refresh();
    } else {
      setNote(json.error || "Merge failed — your local list is untouched.");
    }
  }

  const localRemove = (handle) => {
    writeLocalWishlist(readLocalWishlist().filter((i) => i.handle !== handle));
    refresh();
  };
  const accountRemove = async (handle) => {
    await fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "wishlist_remove", handle }) });
    refresh();
  };

  if (local === null) return <p className="text-sm text-sf-text-faint">Loading…</p>;
  const empty = local.length === 0 && (!account || account.length === 0);

  return (
    <div>
      {note && <p className="mb-4 rounded-sf-small bg-sf-success-surface px-3 py-2 text-sm text-sf-success-strong">{note}</p>}
      {empty && (
        <p className="rounded-sf-card border border-sf-border p-6 text-sm text-sf-text-subtle">
          Nothing saved yet — tap <strong>Save for later</strong> on any product. Your list stays in this browser
          unless you sign in and choose to merge it into your account.
        </p>
      )}

      {local.length > 0 && (
        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold">Saved on this device ({local.length})</h2>
            <button type="button" className="text-xs text-sf-text-faint hover:text-sf-danger" onClick={() => { writeLocalWishlist([]); refresh(); }}>
              clear all
            </button>
          </div>
          {authed && (
            <div className="mt-2 rounded-sf-control bg-sf-surface-muted px-4 py-3 text-sm">
              <p className="text-sf-text-muted">You&rsquo;re signed in. Move these into your account so they follow you across devices?</p>
              <button type="button" disabled={busy} onClick={merge} className="mt-2 rounded-sf-control bg-sf-inverse px-4 py-2 text-xs font-bold text-sf-on-inverse hover:bg-sf-inverse-hover disabled:opacity-50">
                {busy ? "Merging…" : "Merge into my account"}
              </button>
              <p className="mt-1 text-sf-2xs text-sf-text-faint">This is the only way device and account lists ever join — nothing merges on its own.</p>
            </div>
          )}
          <ul className="mt-2 divide-y divide-sf-border-soft">
            {local.map((i) => (
              <Row key={i.handle} item={i} onRemove={() => localRemove(i.handle)} />
            ))}
          </ul>
        </section>
      )}

      {authed && account?.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-bold">In your account ({account.length})</h2>
          <ul className="mt-2 divide-y divide-sf-border-soft">
            {account.map((i) => (
              <Row key={i.handle} item={i} onRemove={() => accountRemove(i.handle)} />
            ))}
          </ul>
        </section>
      )}
      {!authed && account === null && local.length > 0 && (
        <p className="mt-6 text-xs text-sf-text-faint">
          <Link href="/account?return=%2Fwishlist" className="underline hover:text-sf-text-muted">
            Sign in
          </Link>{" "}
          to optionally keep this list on your account (your choice — nothing merges automatically).
        </p>
      )}
    </div>
  );
}
