"use client";

import { useState } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Field, Input, Select } from "@/components/console/fields";
import { ConfirmDialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";

// Brand tokens editor (S35 / MC10, redesigned S50). Colors + radius + type
// scale; live shade ladder preview; WCAG contrast errors BLOCK save (server
// re-validates) and render as a persistent danger Banner; warnings persist
// as a warning Banner even after a successful save. Reset confirms via
// ConfirmDialog; saves are toasts.
const RADII = ["sm", "md", "lg", "xl"];
const SCALES = ["compact", "regular", "large"];

function ColorField({ id, label, value, onChange, hint }) {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-ctl border border-edge bg-surface focus-ring"
          aria-label={`${label} color picker`}
        />
        <Input id={id} mono value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="#84cc16" className="w-28" />
      </div>
    </Field>
  );
}

export default function BrandAdmin({ initial }) {
  const toast = useToast();
  const [brand, setBrand] = useState(initial.brand);
  const [customized, setCustomized] = useState(initial.customized);
  const [shades, setShades] = useState(initial.shades);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [confirmReset, setConfirmReset] = useState(false);

  const set = (key) => (value) => setBrand((b) => ({ ...b, [key]: value }));

  async function call(body) {
    setBusy(true);
    setErrors([]);
    try {
      const res = await fetch("/api/admin/brand", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        setBrand(json.brand);
        setCustomized(json.customized);
        setShades(json.shades);
        setWarnings(json.warnings || []);
        toast.success(
          body.reset
            ? "Reset to the default look."
            : "Saved as a draft. If this store has published a release, publish again from the Releases tab to take it live; before the first release it applies within ~30s.",
        );
      } else {
        setErrors(json.errors || [json.error || `Save failed (${res.status})`]);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {errors.length > 0 && (
        <Banner tone="danger" title="Couldn't save">
          {errors.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </Banner>
      )}
      {warnings.length > 0 && (
        <Banner tone="warning">
          {warnings.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </Banner>
      )}

      <Card>
        <CardHeader title="Colors" badge={customized ? <StatusBadge status="customized" /> : null} />
        <div className="grid gap-4 sm:grid-cols-3">
          <ColorField id="brand-accent" label="Accent" value={brand.accent} onChange={set("accent")} hint="One color — the 50–900 ladder derives from it." />
          <ColorField id="brand-background" label="Background" value={brand.background} onChange={set("background")} />
          <ColorField id="brand-foreground" label="Text" value={brand.foreground} onChange={set("foreground")} hint="Must pass WCAG AA (4.5:1) on the background." />
        </div>
        <div className="mt-4">
          <p className="text-xs font-medium text-fg-muted">Derived accent ladder</p>
          <div className="mt-2 flex overflow-hidden rounded-ctl border border-edge">
            {["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"].map((s) => (
              <div key={s} className="h-9 flex-1" style={{ background: shades[s] }} title={`${s} ${shades[s]}`} />
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Type & shape" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Corner radius" htmlFor="brand-radius">
            <Select id="brand-radius" value={brand.radius} onChange={(e) => set("radius")(e.target.value)}>
              {RADII.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type scale" htmlFor="brand-scale">
            <Select id="brand-scale" value={brand.type_scale} onChange={(e) => set("type_scale")(e.target.value)}>
              {SCALES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mt-4 rounded-ctl border border-edge bg-surface-sunken p-4">
          <p className="text-xs text-fg-subtle">Preview</p>
          <div className="mt-2 flex items-center gap-3" style={{ background: brand.background, padding: "12px", borderRadius: "12px" }}>
            <span style={{ color: brand.foreground }} className="text-sm font-medium">
              Body text on your background
            </span>
            <button
              type="button"
              style={{ background: shades["400"], color: brand.accent_label || "#0a0a0b", borderRadius: "9999px" }}
              className="px-4 py-2 text-sm font-bold"
            >
              Buy now
            </button>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" busy={busy} onClick={() => call({ brand })}>
          Save brand
        </Button>
        <Button variant="dangerOutline" disabled={busy || !customized} onClick={() => setConfirmReset(true)}>
          Reset to theme
        </Button>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset to the platform default look?"
        tone="danger"
        confirmLabel="Reset"
        body="Your custom brand tokens are removed and the storefront returns to the platform default look."
        onConfirm={() => call({ reset: true })}
      />
    </div>
  );
}
