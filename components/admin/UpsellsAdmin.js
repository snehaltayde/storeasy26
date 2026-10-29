"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardHeader, CardFooter } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Switch } from "@/components/console/Switch";
import { ConfirmDialog } from "@/components/console/Dialog";
import { Field, Input, Select } from "@/components/console/fields";
import { EmptyState, Skeleton } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Upsell placements console (Session 23, redesigned S50). Merchants reference
// products by HANDLE (the /products/<handle> part); the server stores gids.

const EMPTY = { kind: "pdp_pairs", sourceHandle: "", targetHandles: "", title: "", position: 0 };

export default function UpsellsAdmin({ initial }) {
  const toast = useToast();
  const [placements, setPlacements] = useState(initial);
  const [form, setForm] = useState(null); // EMPTY-shaped | null
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [togglingId, setTogglingId] = useState(null);
  const [deleting, setDeleting] = useState(null); // placement row | null

  // silent=true keeps the rows on screen (the toggling Switch already shows
  // pending); the skeleton pass is for refetches after delete.
  async function refresh({ silent = false } = {}) {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/admin/upsells");
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.placements) throw new Error(data.error || `Couldn't load placements (${res.status})`);
      setPlacements(data.placements);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setRefreshing(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/upsells", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(form.id ? { id: form.id } : {}),
          kind: form.kind,
          sourceHandle: form.sourceHandle.trim(),
          targetHandles: form.targetHandles.split(",").map((s) => s.trim()).filter(Boolean),
          title: form.title,
          position: Number(form.position) || 0,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setForm(null);
        setPlacements(data.placements);
        toast.success("Placement saved — live on the storefront now");
      } else setError(data.error || `Save failed (${res.status})`);
    } catch (err) {
      setError(String(err?.message || err));
    }
    setBusy(false);
  }

  async function toggle(p) {
    setError(null);
    setTogglingId(p.id);
    try {
      const res = await fetch(`/api/admin/upsells/${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !p.enabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Toggle failed (${res.status})`);
      }
      await refresh({ silent: true });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setTogglingId(null);
    }
  }

  async function remove(p) {
    const res = await fetch(`/api/admin/upsells/${p.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Delete failed (${res.status})`);
    }
    toast.success("Placement deleted");
    await refresh();
  }

  const newPlacementButton = (
    <Button variant="primary" icon={<Plus size={15} aria-hidden />} onClick={() => setForm({ ...EMPTY })}>
      New placement
    </Button>
  );

  const rowTitle = (p) => p.title || (p.kind === "pdp_pairs" ? "Pairs well with" : "You might also like");

  return (
    <div>
      <PageHeader
        title="Upsells"
        description="PDP “pairs well with” (per product; auto same-collection when unset) and the cart-drawer slot. Saved as drafts — shoppers see changes after you publish from Publishing (S53)."
        actions={!form ? newPlacementButton : null}
      />

      {error && (
        <Banner tone="danger" className="mb-4">
          {error}
        </Banner>
      )}

      {form && (
        <form onSubmit={save}>
          <Card className="mb-4">
            <CardHeader
              title={form.id ? "Edit placement" : "New placement"}
              description="Reference products by handle — the /products/<handle> part of the URL."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Kind" htmlFor="upsell-kind">
                <Select id="upsell-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  <option value="pdp_pairs">PDP — pairs well with</option>
                  <option value="cart_upsell">Cart drawer slot</option>
                </Select>
              </Field>
              {form.kind === "pdp_pairs" ? (
                <Field label="Source product handle" hint="the PDP this strip appears on" htmlFor="upsell-source">
                  <Input id="upsell-source" value={form.sourceHandle} onChange={(e) => setForm({ ...form, sourceHandle: e.target.value })} placeholder="whey-protein-1kg" />
                </Field>
              ) : (
                <Field label="Position" hint="lower shows first when several slots exist" htmlFor="upsell-position">
                  <Input id="upsell-position" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
                </Field>
              )}
              <Field label="Target product handles" hint="comma-separated, shown in this order" htmlFor="upsell-targets" className="sm:col-span-2">
                <Input id="upsell-targets" value={form.targetHandles} onChange={(e) => setForm({ ...form, targetHandles: e.target.value })} placeholder="creatine-100g, shaker-neon" />
              </Field>
              <Field label="Title" hint={form.kind === "pdp_pairs" ? 'blank = "Pairs well with"' : 'blank = "You might also like"'} htmlFor="upsell-title">
                <Input id="upsell-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </Field>
            </div>
            <CardFooter className="justify-end">
              <Button onClick={() => setForm(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" busy={busy}>
                Save placement
              </Button>
            </CardFooter>
          </Card>
        </form>
      )}

      <Card padded={false}>
        {refreshing ? (
          <ul className="divide-y divide-edge" aria-hidden>
            {Array.from({ length: Math.max(placements.length, 3) }, (_, i) => (
              <li key={i} className="flex items-center gap-4 px-4 py-4">
                <Skeleton className="h-5 w-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </li>
            ))}
          </ul>
        ) : placements.length === 0 ? (
          <EmptyState
            title="No placements yet"
            body="PDPs use the automatic same-collection strip until you add one."
            action={!form ? newPlacementButton : null}
          />
        ) : (
          <ul className="divide-y divide-edge">
            {placements.map((p) => (
              <li key={p.id} className="flex items-center gap-4 px-4 py-4">
                <Switch
                  checked={!!p.enabled}
                  pending={togglingId === p.id}
                  label={`${p.enabled ? "Disable" : "Enable"} ${rowTitle(p)}`}
                  onChange={() => toggle(p)}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
                    <span className="truncate">{rowTitle(p)}</span>
                    <Badge tone={p.kind === "pdp_pairs" ? "info" : "neutral"}>{p.kind === "pdp_pairs" ? "PDP pairs" : "Cart drawer"}</Badge>
                  </p>
                  <p className="truncate text-xs text-fg-muted">
                    {p.kind === "pdp_pairs" ? `on ${p.source_handle} → ` : "→ "}
                    {/* S39 (MC15): availability-aware preview — struck-through
                        targets won't render on the storefront */}
                    {(p.targets || p.target_handles.map((h) => ({ handle: h, state: "ok" }))).map((t, i) => (
                      <span key={i}>
                        {i > 0 && ", "}
                        <span
                          className={t.state === "ok" ? "" : "text-fg-subtle line-through"}
                          title={t.state === "missing" ? "deleted from the catalog" : t.state === "soldout" ? "sold out — skipped on the storefront" : undefined}
                        >
                          {t.handle}
                        </span>
                      </span>
                    ))}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setForm({
                      id: p.id,
                      kind: p.kind,
                      sourceHandle: p.source_handle || "",
                      targetHandles: p.target_handles.join(", "),
                      title: p.title || "",
                      position: p.position,
                    })
                  }
                >
                  Edit
                </Button>
                <Button size="sm" variant="dangerOutline" onClick={() => setDeleting(p)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete placement"
        tone="danger"
        confirmLabel="Delete placement"
        body={
          deleting
            ? `Delete the ${deleting.kind === "pdp_pairs" ? "PDP pairs" : "cart drawer"} placement “${rowTitle(deleting)}”? The storefront falls back to its automatic behaviour.`
            : null
        }
        onConfirm={() => remove(deleting)}
      />
    </div>
  );
}
