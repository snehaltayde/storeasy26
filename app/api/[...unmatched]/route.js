// Any /api/* path with no route of its own answers 404 JSON, whatever the
// store's state. Without this, the storefront's catch-all page caught these
// paths and a closed store answered them with its "Opening soon" page and a
// 200. Real API routes are more specific and always win over this one.
// Edge-safe: no imports.
export const runtime = "edge";
export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });

export const GET = notFound;
export const HEAD = () => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
