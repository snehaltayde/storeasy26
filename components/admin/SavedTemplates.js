"use client";

// P4-ED05 (DOC-09 partly pulled in): the store's old saved page templates,
// read-only, by family. "Make a page from this" makes a NEW draft page,
// campaign or journal post from one (lib/admin/saved-templates.js
// pageBodyFromTemplate: fresh ids at the click, re-validated) through the
// documents API's createDocument (its own sign-in, access and mode checks),
// then opens it in the editor. A saved template is never changed or deleted.
//
//   makePageFromTemplate(api, template, { title })   the click, without React:
//     -> { ok: true, id, href, notes } | { ok: false, message, notes }
import { useState } from "react";
import { pageBodyFromTemplate, TEMPLATE_FAMILIES } from "@/lib/admin/saved-templates";
import { editorHref } from "@/lib/admin/editor-entry";
import { createDocumentsApi } from "@/components/admin/editor/documentsApi";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";
import { EmptyState } from "@/components/console/bits";

export async function makePageFromTemplate(api, template, { title = null } = {}) {
  const { type, body, notes } = pageBodyFromTemplate(template, { title });
  const r = await api.call("createDocument", { type, meta: null, body, entityId: null });
  if (r.ok && r.data?.document?.id) return { ok: true, id: r.data.document.id, href: editorHref(r.data.document.id), notes };
  return { ok: false, message: r.message || "Something went wrong on our side, so no page was made. Try again in a minute.", notes };
}

const sectionCount = (n) => `${n} section${n === 1 ? "" : "s"}`;

function TemplateRow({ template, api }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  async function make() {
    setBusy(true);
    setResult(null);
    const r = await makePageFromTemplate(api, template);
    setResult(r);
    setBusy(false);
    if (r.ok && !r.notes.length && typeof window !== "undefined") window.location.assign(r.href);
  }
  return (
    <li className="py-3" data-saved-template={template.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{template.name || "Untitled template"}</p>
          <p className="text-xs text-fg-muted">{sectionCount(template.sections.length)}</p>
        </div>
        <Button size="sm" busy={busy} onClick={make} data-make-page="">
          Make a page from this
        </Button>
      </div>
      {result && !result.ok && (
        <Banner tone="danger" className="mt-2">
          {result.message}
        </Banner>
      )}
      {result?.ok && (
        <Banner tone={result.notes.length ? "warning" : "success"} className="mt-2">
          <p>A new draft was made from this template. Nothing is live until you publish it.</p>
          {result.notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
          <a href={result.href} className="font-medium underline underline-offset-2">
            Open it in the editor
          </a>
        </Banner>
      )}
    </li>
  );
}

export default function SavedTemplates({ templates = [] }) {
  const [api] = useState(() => createDocumentsApi());
  if (!templates.length) {
    return <EmptyState title="No saved templates" body="Templates saved with the old page editor show here. You can make new pages in the editor." />;
  }
  return (
    <div className="space-y-4">
      {TEMPLATE_FAMILIES.map(({ family, label }) => {
        const rows = templates.filter((t) => t.family === family);
        if (!rows.length) return null;
        return (
          <Card key={family}>
            <CardHeader title={label} description={`${rows.length} saved template${rows.length === 1 ? "" : "s"}`} />
            <ul className="divide-y divide-edge" data-template-family={family}>
              {rows.map((t) => (
                <TemplateRow key={t.id} template={t} api={api} />
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
