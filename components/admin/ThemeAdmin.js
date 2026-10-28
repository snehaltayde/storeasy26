"use client";

import { useState } from "react";
import { Card } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Button } from "@/components/console/Button";
import { ConfirmDialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";

// Theme library (S37 / MC07, redesigned S50): kit cards with swatches + type
// sample; applying pins the kit and seeds its brand defaults (and hero
// preset) as DRAFTS. Apply confirms via ConfirmDialog (same honest draft
// copy the old confirm() carried); results are toasts.
export default function ThemeAdmin({ initial }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [confirmKit, setConfirmKit] = useState(null);

  async function apply(kit) {
    const res = await fetch("/api/admin/theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "apply", kit: kit.id }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(json.error || `Apply failed (${res.status})`);
    setData(json);
    toast.success(`${kit.label} applied as a draft — review in Brand/Storefront, preview it, then publish from the Releases tab.`);
  }

  const current = data.theme?.kit || "pulse";

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {data.kits.map((kit) => {
          const isCurrent = current === kit.id;
          const applied = isCurrent && data.theme?.version === kit.version;
          return (
            <Card key={kit.id} padded={false} className="overflow-hidden">
              {/* mini preview: header band + hero sample in the kit's own surfaces (framed by the card) */}
              <div
                style={{ background: kit.id === "glow" ? "#fff1ee" : "#09090b", color: kit.id === "glow" ? "#1c1917" : "#fff" }}
                className="border-b border-edge px-5 py-6"
              >
                <p className="text-[10px] font-bold uppercase tracking-widest opacity-60">{kit.vertical}</p>
                <p style={{ fontFamily: kit.fonts.display === "serif" ? "Georgia, serif" : "inherit" }} className="mt-1 text-2xl font-extrabold">
                  {kit.label} looks like this.
                </p>
                <span style={{ background: kit.brand.accent, color: kit.id === "glow" ? "#fff" : "#0a0a0b" }} className="mt-3 inline-block rounded-full px-4 py-1.5 text-xs font-bold">
                  Shop now
                </span>
              </div>
              <div className="p-5">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-fg">
                    {kit.label} <span className="font-normal text-fg-subtle">v{kit.version}</span>
                  </h2>
                  {applied && <Badge tone="success">Applied</Badge>}
                  {isCurrent && !applied && <Badge tone="neutral">Current</Badge>}
                  <span className="ml-auto flex gap-1" aria-hidden="true">
                    {kit.swatch.map((c) => (
                      <span key={c} className="h-4 w-4 rounded-full border border-edge" style={{ background: c }} />
                    ))}
                  </span>
                </div>
                <p className="mt-2 text-sm text-fg-muted">{kit.description}</p>
                <Button variant="primary" className="mt-4" disabled={applied} onClick={() => setConfirmKit(kit)}>
                  {applied ? "Applied" : `Apply ${kit.label}`}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-fg-subtle">
        Applying a kit is a DRAFT change: it pins the kit version, resets your draft brand tokens to the kit's defaults and
        replaces the draft hero copy with its preset. Your live storefront only changes when you publish a release — and
        rollback always works. Kit versions never upgrade silently.
      </p>

      <ConfirmDialog
        open={!!confirmKit}
        onClose={() => setConfirmKit(null)}
        title={confirmKit ? `Apply the ${confirmKit.label} kit?` : ""}
        confirmLabel={confirmKit ? `Apply ${confirmKit.label}` : "Apply"}
        body={
          confirmKit
            ? `This pins your store to ${confirmKit.label} v${confirmKit.version} and replaces your DRAFT brand tokens (and hero copy) with the kit's defaults. Nothing goes live until you publish a release.`
            : null
        }
        onConfirm={() => apply(confirmKit)}
      />
    </div>
  );
}
