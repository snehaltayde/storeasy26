"use client";

import { useState } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Field, Select } from "@/components/console/fields";
import { useToast } from "@/components/console/Toast";
import { saveBlock } from "./api";
import { ConflictBanner } from "./ConflictBanner";
import { useDirtyGuard } from "./useDirtyGuard";

// S56 (audit slices 3-4): per-surface template assignment — FAMILY DEFAULTS.
// Lives on the Theme screen; saves as the `surface_templates` draft block
// (CAS like every block) and goes live with the next publish.
const SURFACES = [
  {
    key: "pdp",
    label: "Product page template",
    hint: "Classic = gallery beside the buy box. Editorial = full-width lead image, story flow, sticky buy panel.",
    options: [
      ["classic", "Classic — two columns"],
      ["editorial", "Editorial — story-led"],
    ],
  },
  {
    key: "collection",
    label: "Collection page template",
    hint: "Standard = filter chips above the grid. Sidebar = filters in a left rail on desktop.",
    options: [
      ["standard", "Standard — filter bar"],
      ["sidebar", "Sidebar — filter rail"],
    ],
  },
];

const DEFAULTS = { pdp: "classic", collection: "standard" };

export default function SurfaceTemplatesCard({ initial }) {
  const toast = useToast();
  const [value, setValue] = useState({ ...DEFAULTS, ...(initial.value || {}) });
  const [snap, setSnap] = useState(JSON.stringify({ ...DEFAULTS, ...(initial.value || {}) }));
  const [revision, setRevision] = useState(initial.revision ?? null);
  const [customized, setCustomized] = useState(!!initial.customized);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState(null);
  const [conflict, setConflict] = useState(false);

  const dirty = JSON.stringify(value) !== snap;
  useDirtyGuard(dirty);

  async function save({ force = false } = {}) {
    setBusy(true);
    setErrs(null);
    // unset-at-default surfaces store as null (platform default), per validation
    const payload = Object.fromEntries(Object.entries(value).filter(([k, v]) => v !== DEFAULTS[k]));
    const res = await saveBlock("surface_templates", Object.keys(payload).length ? payload : null, force ? undefined : revision, { force });
    setBusy(false);
    if (res.ok) {
      setConflict(false);
      setRevision(res.revisions?.surface_templates ?? null);
      setCustomized(!!res.customized?.surface_templates);
      setSnap(JSON.stringify(value));
      toast.success("Saved as a draft — publish from Publishing");
      return;
    }
    if (res.conflict) {
      setConflict(true);
      return;
    }
    setErrs(res.errors?.length ? res.errors : [res.error || "Save failed — try again."]);
  }

  return (
    <Card id="page-templates" className="mt-4">
      <CardHeader
        title="Page templates"
        badge={
          <span className="flex items-center gap-1.5">
            <Badge tone={customized ? "accent" : "neutral"}>{customized ? "Customized" : "Default"}</Badge>
            {dirty && <Badge tone="warning">Unsaved</Badge>}
          </span>
        }
        description="Which layout each storefront surface uses. A draft like everything else — shoppers see it after you publish."
        actions={
          <Button variant="primary" size="sm" busy={busy} disabled={!dirty} onClick={() => save()}>
            Save
          </Button>
        }
      />
      {conflict && (
        <ConflictBanner
          what="the page templates"
          busy={busy}
          onTakeTheirs={() => window.location.reload()}
          onOverwrite={() => save({ force: true })}
        />
      )}
      {errs && (
        <Banner tone="danger" className="mb-3">
          {errs.join(" · ")}
        </Banner>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {SURFACES.map((s) => (
          <Field key={s.key} label={s.label} htmlFor={`tpl-${s.key}`} hint={s.hint}>
            <Select id={`tpl-${s.key}`} value={value[s.key]} onChange={(e) => setValue((v) => ({ ...v, [s.key]: e.target.value }))}>
              {s.options.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
    </Card>
  );
}
