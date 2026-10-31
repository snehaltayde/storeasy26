"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { Field, Select } from "@/components/console/fields";
import { useToast } from "@/components/console/Toast";
import { saveBlock } from "./api";
import { ConflictBanner } from "./ConflictBanner";
import { useDirtyGuard } from "./useDirtyGuard";
import { ProductPicker, CollectionPicker, fetchRefs, refLabel } from "./RefPicker";

// S56 (audit slices 3-4): per-surface template assignment — FAMILY DEFAULTS.
// S57 adds EXPLICIT per-entity exceptions (audit precedence: explicit entity
// assignment → family default → platform default; ranked rules come later).
// Lives on the Theme screen; saves as the `surface_templates` draft block
// (CAS like every block) and goes live with the next publish.
const SURFACES = [
  {
    key: "pdp",
    mapKey: "products",
    refType: "product",
    label: "Product page template",
    hint: "Classic = gallery beside the buy box. Editorial = full-width lead image, story flow, sticky buy panel.",
    addLabel: "Add product exceptions…",
    pickerTitle: "Products with their own template",
    options: [
      ["classic", "Classic — two columns"],
      ["editorial", "Editorial — story-led"],
    ],
  },
  {
    key: "collection",
    mapKey: "collections",
    refType: "collection",
    label: "Collection page template",
    hint: "Standard = filter chips above the grid. Sidebar = filters in a left rail on desktop.",
    addLabel: "Add collection exceptions…",
    pickerTitle: "Collections with their own template",
    options: [
      ["standard", "Standard — filter bar"],
      ["sidebar", "Sidebar — filter rail"],
    ],
  },
];

const DEFAULTS = { pdp: "classic", collection: "standard" };

const normalize = (stored) => ({
  ...DEFAULTS,
  products: {},
  collections: {},
  ...(stored || {}),
  ...(stored?.products ? { products: { ...stored.products } } : {}),
  ...(stored?.collections ? { collections: { ...stored.collections } } : {}),
});

export default function SurfaceTemplatesCard({ initial }) {
  const toast = useToast();
  const [value, setValue] = useState(() => normalize(initial.value));
  const [snap, setSnap] = useState(() => JSON.stringify(normalize(initial.value)));
  const [revision, setRevision] = useState(initial.revision ?? null);
  const [customized, setCustomized] = useState(!!initial.customized);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [pickerFor, setPickerFor] = useState(null); // surface key | null
  const [refs, setRefs] = useState({}); // id → hydrated item (titles for exception rows)

  const dirty = JSON.stringify(value) !== snap;
  useDirtyGuard(dirty);

  // Hydrate exception-row titles; ids the catalog no longer has stay VISIBLE
  // as "missing" rows (never silently dropped).
  const prodIds = Object.keys(value.products).join(",");
  const collIds = Object.keys(value.collections).join(",");
  useEffect(() => {
    let gone = false;
    (async () => {
      const want = [
        ["product", prodIds],
        ["collection", collIds],
      ].filter(([, ids]) => ids);
      for (const [type, ids] of want) {
        try {
          const data = await fetchRefs({ type, ids });
          if (gone) return;
          setRefs((r) => {
            const next = { ...r };
            for (const item of data.items || []) next[item.id] = item;
            return next;
          });
        } catch {
          /* titles are a nicety — rows fall back to the raw id */
        }
      }
    })();
    return () => {
      gone = true;
    };
  }, [prodIds, collIds]);

  async function save({ force = false } = {}) {
    setBusy(true);
    setErrs(null);
    // unset-at-default family picks store as null (platform default), per
    // validation; EXPLICIT exceptions always store, even when equal to the
    // family default (a pin survives a later default change).
    const payload = Object.fromEntries(Object.entries(DEFAULTS).flatMap(([k]) => (value[k] !== DEFAULTS[k] ? [[k, value[k]]] : [])));
    if (Object.keys(value.products).length) payload.products = value.products;
    if (Object.keys(value.collections).length) payload.collections = value.collections;
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

  const setException = (mapKey, id, tpl) => setValue((v) => ({ ...v, [mapKey]: { ...v[mapKey], [id]: tpl } }));
  const dropException = (mapKey, id) =>
    setValue((v) => {
      const next = { ...v[mapKey] };
      delete next[id];
      return { ...v, [mapKey]: next };
    });

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
        description="Which layout each storefront surface uses. Exceptions pin a template to specific items; everything else follows the default. A draft like everything else — shoppers see it after you publish."
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
      <div className="grid gap-6 sm:grid-cols-2">
        {SURFACES.map((s) => {
          const exceptions = Object.entries(value[s.mapKey]);
          return (
            <div key={s.key} className="space-y-3">
              <Field label={s.label} htmlFor={`tpl-${s.key}`} hint={s.hint}>
                <Select id={`tpl-${s.key}`} value={value[s.key]} onChange={(e) => setValue((v) => ({ ...v, [s.key]: e.target.value }))}>
                  {s.options.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              {exceptions.length > 0 && (
                <ul className="divide-y divide-edge rounded-ctl border border-edge">
                  {exceptions.map(([id, tpl]) => {
                    const item = refs[id];
                    const missing = item?.missing;
                    return (
                      <li key={id} className="flex items-center gap-2 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {item && !missing ? refLabel(item) : id}
                          {missing && (
                            <Badge tone="warning" className="ml-2">
                              Missing from catalog
                            </Badge>
                          )}
                        </span>
                        <span className="w-44 shrink-0">
                          <Select
                            aria-label={`Template for ${item && !missing ? refLabel(item) : id}`}
                            value={tpl}
                            onChange={(e) => setException(s.mapKey, id, e.target.value)}
                          >
                            {s.options.map(([v, label]) => (
                              <option key={v} value={v}>
                                {label}
                              </option>
                            ))}
                          </Select>
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => dropException(s.mapKey, id)}>
                          Remove
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Button variant="secondary" size="sm" onClick={() => setPickerFor(s.key)}>
                {s.addLabel}
              </Button>
            </div>
          );
        })}
      </div>
      {SURFACES.map((s) => {
        const Picker = s.refType === "product" ? ProductPicker : CollectionPicker;
        return (
          <Picker
            key={s.key}
            open={pickerFor === s.key}
            onClose={() => setPickerFor(null)}
            multi
            title={s.pickerTitle}
            selectedIds={Object.keys(value[s.mapKey])}
            onConfirm={(items) => {
              setPickerFor(null);
              setRefs((r) => {
                const next = { ...r };
                for (const item of items) next[item.id] = item;
                return next;
              });
              setValue((v) => {
                // keep existing picks; new entries start at the family value
                // (explicit pin of today's look — flip the row to diverge)
                const map = {};
                for (const item of items) map[item.id] = v[s.mapKey][item.id] || v[s.key];
                return { ...v, [s.mapKey]: map };
              });
            }}
          />
        );
      })}
    </Card>
  );
}
