"use client";

import { useState } from "react";
import { Card } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Dialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";

// Theme library (S37 / MC07, redesigned S50, apply safety S52): kit cards
// with swatches + type sample. Applying pins the kit as a DRAFT; the kit's
// fonts/header/hero STYLING always comes along, but overwriting the
// merchant's brand tokens and hero copy is now an explicit opt-in — two
// checkboxes in the apply dialog, both off by default (the API's own
// defaults stay true for older clients; we always send both flags).
export default function ThemeAdmin({ initial }) {
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [confirmKit, setConfirmKit] = useState(null);
  const [withBrand, setWithBrand] = useState(false);
  const [withPresets, setWithPresets] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyErr, setApplyErr] = useState(null);

  function openConfirm(kit) {
    setWithBrand(false); // both opt-ins reset per apply — no sticky consent
    setWithPresets(false);
    setApplyErr(null);
    setConfirmKit(kit);
  }

  async function apply(kit) {
    setApplyBusy(true);
    setApplyErr(null);
    try {
      const res = await fetch("/api/admin/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply", kit: kit.id, withBrand, withPresets }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Apply failed (${res.status})`);
      setData(json);
      setConfirmKit(null);
      toast.success(`${kit.label} applied as a draft — preview it, then publish from Publishing.`);
    } catch (e) {
      setApplyErr(String(e?.message || e));
    } finally {
      setApplyBusy(false);
    }
  }

  const current = data.theme?.kit || "pulse";
  const currentKit = data.kits.find((k) => k.id === current);

  const checkboxCls = "focus-ring mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-fg";

  return (
    <div className="space-y-5">
      {data.upgradeAvailable && currentKit && (
        <Banner tone="info">
          A newer version of {currentKit.label} is available — applying re-pins to v{currentKit.version}.
        </Banner>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {data.kits.map((kit) => {
          const isCurrent = current === kit.id;
          const applied = isCurrent && data.theme?.version === kit.version;
          // swatch = [accent, band surface, band text] — the preview band
          // derives from it instead of hardcoding per-kit colors.
          const [swAccent, swSurface, swText] = kit.swatch;
          return (
            <Card key={kit.id} padded={false} className="overflow-hidden">
              {/* mini preview: header band + hero sample in the kit's own surfaces (framed by the card) */}
              <div style={{ background: swSurface, color: swText }} className="border-b border-edge px-5 py-6">
                <p className="text-[10px] font-bold uppercase tracking-widest opacity-60">{kit.vertical}</p>
                <p style={{ fontFamily: kit.fonts.display === "serif" ? "Georgia, serif" : "inherit" }} className="mt-1 text-2xl font-extrabold">
                  {kit.label} looks like this.
                </p>
                <span style={{ background: swAccent, color: swSurface }} className="mt-3 inline-block rounded-full px-4 py-1.5 text-xs font-bold">
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
                <Button variant="primary" className="mt-4" disabled={applied} onClick={() => openConfirm(kit)}>
                  {applied ? "Applied" : `Apply ${kit.label}`}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-fg-subtle">
        Applying a kit is a DRAFT change: it pins the kit version and switches the storefront’s fonts, header and hero
        styling. Your brand colors and hero copy are only replaced if you opt in when applying. Your live storefront only
        changes when you publish from Publishing — and rollback always works. Kit versions never upgrade silently.
      </p>

      <Dialog
        open={!!confirmKit}
        onClose={applyBusy ? undefined : () => setConfirmKit(null)}
        title={confirmKit ? `Apply the ${confirmKit.label} kit?` : ""}
        footer={
          <>
            <Button onClick={() => setConfirmKit(null)} disabled={applyBusy}>
              Cancel
            </Button>
            <Button variant="primary" busy={applyBusy} onClick={() => apply(confirmKit)}>
              {confirmKit ? `Apply ${confirmKit.label}` : "Apply"}
            </Button>
          </>
        }
      >
        {confirmKit && (
          <div className="space-y-3">
            <p>
              This pins your store to {confirmKit.label} v{confirmKit.version} as a DRAFT. Nothing goes live until you
              publish from Publishing.
            </p>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-fg">
              <input type="checkbox" className={checkboxCls} checked={withBrand} onChange={(e) => setWithBrand(e.target.checked)} />
              <span>Also apply the kit’s brand colors (replaces your Brand settings)</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-fg">
              <input type="checkbox" className={checkboxCls} checked={withPresets} onChange={(e) => setWithPresets(e.target.checked)} />
              <span>Also replace the homepage hero copy with the kit’s preset</span>
            </label>
            <p className="text-xs text-fg-subtle">The kit’s fonts, header and hero styling apply either way.</p>
            {applyErr && <p className="text-xs text-danger">{applyErr}</p>}
          </div>
        )}
      </Dialog>
    </div>
  );
}
