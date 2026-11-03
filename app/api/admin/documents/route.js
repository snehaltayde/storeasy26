import { NextResponse } from "next/server";
import { handleDocumentsPut } from "@/lib/admin/documents-api";
import { tenantHandler } from "@/lib/tenant-request";

// P2-DOCS (spec 8.14): the documents console API.
//   PUT { getDocument: id } | { listDocuments: true | {type, includeArchived} }
//       | { listHistory: id }                                   storefront.read
//   PUT { createDocument: {type, meta?, body?, entityId?} }
//       | { saveDraft: {id, body}, revision }
//       | { discardDraft: id, revision } | { archive: id, revision }
//       | { restoreVersion: {id, versionId}, revision }         storefront.write
//   PUT { publish: {id, draftHash}, revision }
//       | { publishSet: [{id, revision, draftHash}, …] }        storefront.publish
// Exactly ONE operation per request, parsed before it is authorized. Writes
// answer 409 STORE_USES_LEGACY unless the store is in documents mode. The
// handler lives in lib/admin/documents-api.js so scripts/test-documents.js
// runs the real dispatch.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = tenantHandler(async (request) => {
  const r = await handleDocumentsPut(request);
  return NextResponse.json(r.body, { status: r.status });
});
