"use client";

import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { startPreview } from "./api";
import { editorPathHref } from "@/lib/admin/editor-entry";

// Draft preview (S37, generalized S52): mints a preview session and iframes
// the REAL storefront — now deep-linked at the page being edited (`to`),
// instead of always opening the homepage.
const DEVICES = [
  { key: "mobile", label: "Mobile", width: 375 },
  { key: "tablet", label: "Tablet", width: 768 },
  { key: "desktop", label: "Desktop", width: "100%" },
];

//
// P4-ED05 (ED-05): on a documents store (cmsMode "documents") the old draft
// preview can't open (its session is refused there), so the card links to the
// editor at the same page instead: the editor's own preview shows its drafts.
// Every other mode is today's card.
export default function PreviewFrame(props) {
  if (props?.cmsMode === "documents") return <EditorPreviewLink {...props} />;
  return <DraftPreviewFrame {...props} />;
}

function EditorPreviewLink({ to = "/", title = "Draft preview" }) {
  return (
    <Card>
      <CardHeader
        title={title}
        description="Preview your drafts in the editor. Shoppers keep seeing what is published."
        actions={
          <a href={editorPathHref(to)} data-editor-preview-link="" className="inline-flex items-center rounded-ctl border border-edge px-3 py-1.5 text-xs font-semibold text-fg focus-ring hover:bg-surface-sunken">
            Open in the editor
          </a>
        }
      />
    </Card>
  );
}

function DraftPreviewFrame({ to = "/", title = "Draft preview", description = "Your browser only — shoppers keep seeing the live release." }) {
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState("desktop");
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function start() {
    setBusy(true);
    setErr(null);
    const r = await startPreview(to);
    if (!r.ok) setErr(r.error || "Could not start the preview");
    else {
      setOpen(true);
      setNonce((n) => n + 1);
    }
    setBusy(false);
  }

  const width = DEVICES.find((d) => d.key === device)?.width ?? "100%";

  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          <>
            {open && (
              <span className="flex items-center rounded-ctl border border-edge p-0.5" role="group" aria-label="Preview width">
                {DEVICES.map((d) => (
                  <Button key={d.key} size="sm" variant={device === d.key ? "primary" : "ghost"} aria-pressed={device === d.key} onClick={() => setDevice(d.key)}>
                    {d.label}
                  </Button>
                ))}
              </span>
            )}
            {open && <IconButton label="Refresh preview" icon={<RefreshCw size={14} aria-hidden />} onClick={() => setNonce((n) => n + 1)} />}
            {open && (
              <IconButton
                label="Open preview in a new tab"
                icon={<ExternalLink size={14} aria-hidden />}
                onClick={() => window.open(to, "_blank", "noreferrer")}
              />
            )}
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
            src={to}
            title={title}
            style={{ width: typeof width === "number" ? `${width}px` : width }}
            className="mx-auto block h-[600px] rounded-card border border-edge bg-surface shadow-card"
          />
        </div>
      )}
    </Card>
  );
}
