"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";

// Draft preview pane (S37 / MC08, restyled S50): mints an S36 preview token,
// follows the cookie-setting redirect with a same-origin fetch, then iframes
// the real storefront — REAL bindings (catalog, cart, offers), responsive
// widths.
const DEVICES = [
  { key: "mobile", label: "Mobile", width: 375 },
  { key: "tablet", label: "Tablet", width: 768 },
  { key: "desktop", label: "Desktop", width: "100%" },
];

export default function PreviewPane() {
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState("desktop");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.url) throw new Error(json.error || "could not mint a preview link");
      await fetch(json.url, { redirect: "follow" }); // sets the httpOnly preview cookie
      setOpen(true);
      setNonce((n) => n + 1);
    } catch (e) {
      setErr(String(e.message || e));
    }
    setBusy(false);
  }

  const width = DEVICES.find((d) => d.key === device)?.width ?? "100%";

  return (
    <Card>
      <CardHeader
        title="Draft preview"
        description="Your browser only — shoppers keep seeing the live release."
        actions={
          <>
            {open && (
              <span className="flex items-center rounded-ctl border border-edge p-0.5" role="group" aria-label="Preview width">
                {DEVICES.map((d) => (
                  <Button
                    key={d.key}
                    size="sm"
                    variant={device === d.key ? "primary" : "ghost"}
                    aria-pressed={device === d.key}
                    onClick={() => setDevice(d.key)}
                  >
                    {d.label}
                  </Button>
                ))}
              </span>
            )}
            {open && <IconButton label="Refresh preview" icon={<RefreshCw size={14} aria-hidden />} onClick={() => setNonce((n) => n + 1)} />}
            <Button size="sm" busy={busy} onClick={open ? () => setOpen(false) : start}>
              {open ? "Close" : "Open preview"}
            </Button>
          </>
        }
      />
      {err && (
        <Banner tone="danger" className="mb-4" actions={<Button size="sm" onClick={start}>Retry</Button>}>
          {err}
        </Banner>
      )}
      {open && (
        <div className="overflow-auto rounded-card border border-edge bg-surface-sunken p-3">
          <iframe
            key={nonce}
            src="/"
            title="Draft preview"
            style={{ width: typeof width === "number" ? `${width}px` : width }}
            className="mx-auto block h-[600px] rounded-card border border-edge bg-surface shadow-card"
          />
        </div>
      )}
    </Card>
  );
}
