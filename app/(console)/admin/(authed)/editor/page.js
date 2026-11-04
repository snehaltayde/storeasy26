import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { getCmsMode } from "@/lib/cms-mode";
import { listDocuments } from "@/lib/documents/service";
import { editorEntry } from "@/lib/admin/editor-entry";
import { tfetch } from "@/lib/console-request";
import { PageHeader } from "@/components/console/PageHeader";
import { Banner } from "@/components/console/Banner";
import DocumentEditor from "@/components/admin/editor/DocumentEditor";

// P3-ROUTES (ED-02, PUB-11; plan decision 11): the new editor's one address.
//   /admin/editor               the home page
//   /admin/editor?doc=<id>      that document
//   /admin/editor?path=<path>   the document at that store address
//                               ("Edit this page", PUB-11)
// The store's mode is read fresh on every request (getCmsMode never caches):
//   documents  the editor (a placeholder until P3-EDITOR)
//   legacy     a note pointing at today's Designer; nothing else changes
//   migrating  a read-only note: old writes are paused, the new editor isn't
//              open yet
// A mode that can't be read is an error page, never a guess.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Editor · Admin", robots: { index: false } };

export default async function EditorPage({ searchParams }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const query = (await searchParams) || {};
  const { mode, entry } = await tfetch(async () => {
    const mode = await getCmsMode();
    if (mode !== "documents") return { mode, entry: null };
    return { mode, entry: editorEntry(query, await listDocuments()) };
  });

  if (mode === "documents") return <DocumentEditor document={entry.document} note={entry.note} />;

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
