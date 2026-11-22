import { getMediaFile } from "@/lib/media";
import { tenantHandler } from "@/lib/tenant-request";

// Public media serving (S38 / BE15). Tenant-scoped by construction — the row
// is read from the RESOLVING host's database, so one tenant's ids return 404
// on another tenant's domain. Content is immutable (content-addressed writes),
// hence the far-future cache. SVG is sanitized at write AND served with a
// no-script CSP + nosniff, so even a bypass can't execute in the page origin.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request, { params }) => {
  const { id } = await params;
  if (!/^med_[0-9a-f]{18}$/.test(id || "")) return new Response("Not found", { status: 404 });
  let file = null;
  try {
    file = await getMediaFile(id);
  } catch {
    /* pre-migration tenant → 404 */
  }
  if (!file) return new Response("Not found", { status: 404 });

  if (file.storageUrl && file.storageUrl.startsWith("https://") && file.mime !== "image/svg+xml" && file.data.length === 0) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: file.storageUrl,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ETag: `"${file.sha256.slice(0, 16)}"`,
      },
    });
  }

  return new Response(file.data, {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Content-Disposition": `inline; filename="${file.filename.replace(/"/g, "")}"`,
      ETag: `"${file.sha256.slice(0, 16)}"`,
    },
  });
});
