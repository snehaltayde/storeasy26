"use client";

// Editor > Saved templates (Phase 2 line 6, 6a; replaces SavedTemplates.js):
// the store's old saved page templates by family, read-only. Two actions,
// both storefront.write (RoleGate, hidden for anyone without it):
//   Make a page from this   a NEW draft page from the template
//                           (makePageFromTemplate: createDocument through the
//                           documents API), then opens it
//   Insert into a page      adds the template's sections to the end of a page's
//                           draft (insertIntoPage: getDocument, then saveDraft
//                           on that revision through the documents API, with
//                           lib/admin/saved-templates.js sectionsFromTemplate:
//                           fresh ids, only kinds the page takes), then opens
//                           the page in the editor
// A saved template itself is never changed or deleted here.
//   <TemplatesList templates pages role api? />
//     templates  [{ id, name, family, sections }]; pages [{ id, label }]
import { useState } from "react";
import { FileStack } from "lucide-react";
import { pageBodyFromTemplate, sectionsFromTemplate, TEMPLATE_FAMILIES } from "@/lib/admin/saved-templates";
import { editorHref } from "@/lib/admin/editor-entry";
import { createDocumentsApi } from "@/components/admin/editor/documentsApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { roleAllows } from "@/lib/platform/authz";

export async function makePageFromTemplate(api, template, { title = null } = {}) {
  const { type, body, notes } = pageBodyFromTemplate(template, { title });
  const r = await api.call("createDocument", { type, meta: null, body, entityId: null });
  if (r.ok && r.data?.document?.id) return { ok: true, id: r.data.document.id, href: editorHref(r.data.document.id), notes };
  return { ok: false, message: r.message || "Something went wrong on our side, so no page was made. Try again in a minute.", notes };
}

// "Insert into a page", without React: -> { ok: true, href, added, notes } | { ok: false, message, notes }
export async function insertIntoPage(api, template, pageId) {
  const g = await api.call("getDocument", pageId);
  const doc = g?.ok ? g.data?.document : null;
  if (!doc || !Array.isArray(doc.body?.sections)) return { ok: false, message: g?.message || "That page couldn't be opened, so nothing was added. Reload and try again.", notes: [] };
  const { sections, notes } = sectionsFromTemplate(template, doc.type, { taken: doc.body.sections.map((s) => s?.id) });
  if (!sections.length) return { ok: false, message: "Nothing from this template can go on that page, so nothing was added.", notes };
  const r = await api.call("saveDraft", { id: doc.id, body: { ...doc.body, sections: [...doc.body.sections, ...sections] } }, { revision: doc.revision });
  if (r?.ok) return { ok: true, href: editorHref(doc.id), added: sections.length, notes };
  return { ok: false, message: r?.message || "Something went wrong on our side, so nothing was added. Try again in a minute.", notes };
}

const sectionCount = (n) => `${n} section${n === 1 ? "" : "s"}`;

function TemplateRow({ template, pages, role, api }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [target, setTarget] = useState("");
  async function make() {
    setBusy(true);
    setResult(null);
    const r = await makePageFromTemplate(api, template);
    setResult(r);
    setBusy(false);
    if (r.ok && !r.notes.length && typeof window !== "undefined") window.location.assign(r.href);
  }
  async function insert() {
    if (!target) return;
    setBusy(true);
    setResult(null);
    const r = await insertIntoPage(api, template, target);
    setResult(r.ok ? { ...r, inserted: true } : r);
    setBusy(false);
    if (r.ok && !r.notes.length && typeof window !== "undefined") window.location.assign(r.href);
  }
  const writer = roleAllows(role, "storefront.write");
  return (
    <li className="space-y-2 py-3" data-saved-template={template.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{template.name || "Untitled template"}</p>
          <p className="text-xs text-muted-foreground">{sectionCount(template.sections.length)}</p>
        </div>
        {writer && (
          <div className="flex flex-wrap items-center gap-2">
            {pages.length > 0 && (
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger size="sm" className="w-44" aria-label={`The page to insert ${template.name || "this template"} into`} data-insert-target="">
                  <SelectValue placeholder="Choose a page" />
                </SelectTrigger>
                <SelectContent>
                  {pages.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {pages.length > 0 && (
              <RoleGate role={role} action="storefront.write" mode="hide">
                <Button size="sm" variant="outline" disabled={!target || busy} onClick={insert} data-insert-template="">
                  Insert into a page
                </Button>
              </RoleGate>
            )}
            <RoleGate role={role} action="storefront.write" mode="hide">
              <Button size="sm" disabled={busy} onClick={make} data-make-page="">
                {busy ? "Making the page…" : "Make a page from this"}
              </Button>
            </RoleGate>
          </div>
        )}
      </div>
      {result && !result.ok && (
        <p role="alert" className="text-[13px] text-destructive">
          {result.message}
        </p>
      )}
      {result?.ok && (
        <div role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-foreground">
          <p>{result.inserted ? `Added ${result.added} section${result.added === 1 ? "" : "s"} to the end of that page's draft. Nothing is live until you publish it.` : "A new draft was made from this template. Nothing is live until you publish it."}</p>
          {result.notes.map((n, i) => (
            <p key={i} className="text-muted-foreground">
              {n}
            </p>
          ))}
          <a href={result.href} className="rounded-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" data-read-control="">
            Open it in the editor
          </a>
        </div>
      )}
    </li>
  );
}

export default function TemplatesList({ templates = [], pages = [], role = null, api: given = null }) {
  const [api] = useState(() => given || createDocumentsApi());
  if (!templates.length) {
    return <EmptyState icon={FileStack} title="No saved templates" description="Templates saved with the old page editor show here. You can make new pages in the editor." />;
  }
  return (
    <div className="space-y-4">
      {TEMPLATE_FAMILIES.map(({ family, label }) => {
        const rows = templates.filter((t) => t.family === family);
        if (!rows.length) return null;
        return (
          <Card key={family} data-template-family={family}>
            <CardHeader>
              <CardTitle>{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {rows.map((t) => (
                  <TemplateRow key={t.id} template={t} pages={pages} role={role} api={api} />
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
