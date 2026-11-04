import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getCmsMode } from "@/lib/cms-mode";
import { listDocuments } from "@/lib/documents/service";
import { editorEntry, parseEditorTarget } from "@/lib/admin/editor-entry";
import { entityEntry, entityForDocument, canEdit, ENTRY_WORDS } from "@/lib/admin/entity-entry";
import { tfetch } from "@/lib/console-request";
import { PageHeader } from "@/components/console/PageHeader";
import { Banner } from "@/components/console/Banner";
import DocumentEditor from "@/components/admin/editor/DocumentEditor";

// P3-ROUTES (ED-02, PUB-11; plan decision 11): the new editor's one address.
//   /admin/editor               the home page
//   /admin/editor?doc=<id>      that document
//   /admin/editor?path=<path>   the document at that store address
//                               ("Edit this page", PUB-11)
// P4-EDITOR (OVL-04, ED-12; plan section 4, the URL contract):
//   /admin/editor?product=<gid>     that product's content
//   /admin/editor?collection=<gid>  that collection's content
//   parseEditorTarget (lib/admin/editor-entry.js) reads the address. A person
//   who can edit opens the content through openEntityContent (found, made with
//   its deterministic id, or brought back); anyone else only READS it
//   (lib/admin/entity-entry.js readEntityContent), never a write. What Shopify
//   sends now (the gallery's Shopify side, the price, variants and stock) is
//   read here and handed to the editor, so the browser never asks for it.
//   A product or collection that isn't in the catalog opens the home page
//   with a note in plain words.
// The store's mode is read fresh on every request (getCmsMode never caches):
//   documents  the editor
//   legacy     a note pointing at today's Designer; nothing else changes
//   migrating  a read-only note: old writes are paused, the new editor isn't
//              open yet
// A mode that can't be read is an error page, never a guess.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Editor · Admin", robots: { index: false } };

const ENTITY_TYPES = new Set(["product_content", "collection_content"]);

export default async function EditorPage({ searchParams }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const query = (await searchParams) || {};
  const target = parseEditorTarget(query);
  const editable = canEdit(actor);
  const { mode, entry, entity, readOnly } = await tfetch(async () => {
    const mode = await getCmsMode();
    if (mode !== "documents") return { mode, entry: null };
    if (target.product || target.collection) {
      const type = target.product ? "product_content" : "collection_content";
      const out = await entityEntry({ type, entityId: target.product || target.collection, actor });
      if (out.document) return { mode, entry: { document: out.document, note: null }, entity: out.entity, readOnly: out.readOnly };
      return { mode, entry: { ...editorEntry({}, await listDocuments()), note: out.error || ENTRY_WORDS.failed }, entity: null, readOnly: null };
    }
    const docs = await listDocuments();
    const e = editorEntry(query, docs);
    if (!ENTITY_TYPES.has(e.document?.type)) return { mode, entry: e, entity: null, readOnly: null };
    // ?doc= of a product's or collection's content: read what Shopify sends now
    const row = docs.find((d) => d.id === e.document.id);
    return { mode, entry: e, entity: await entityForDocument(row), readOnly: editable ? null : ENTRY_WORDS.readOnly };
  });

  if (mode === "documents") return <DocumentEditor document={entry.document} note={entry.note} entity={entity ?? null} readOnly={readOnly ?? null} />;

  if (mode === "legacy") {
    return (
      <>
        <PageHeader title="Editor" />
        <Banner tone="info" title="Your store still uses the current editors">
          <p data-editor-note="legacy">
            The new editor opens here once your store moves to it. Until then, edit your home page in the{" "}
            <Link href="/admin/storefront/designer" className="font-medium underline underline-offset-2">
              Designer
            </Link>
            , and your other pages from Storefront.
          </p>
        </Banner>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Editor" />
      <Banner tone="warning" title="Your store is moving to the new editor">
        <p data-editor-note="migrating">
          While the move runs, nothing can be changed here or in the old editors. Your store stays as it is for shoppers. Come back once the move is done.
        </p>
      </Banner>
    </>
  );
}
