import { typesenseSearch } from "@/lib/typesense-search";
import { searchProductsInDb, displayHits } from "@/lib/repo";
import { rateLimit } from "@/lib/rate-limit";
import { tenantHandler } from "@/lib/tenant-request";

export const runtime = "edge";
export const dynamic = "force-dynamic";

// Search endpoint for the header search box. Prefers Typesense (typo tolerance,
// ranking); transparently falls back to a SQL query over the local catalog so
// search works even before Typesense is configured.
// P4-EFFECTIVE (OVL-05): hits carry display_type, the type label the store
// shows (the SQL path reads effective values; P4-SEARCH indexes them).
export const GET = tenantHandler(async (request) => {
  const limited = rateLimit(request, { name: "search", limit: 30 });
  if (limited) return limited;

  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (q.length < 2) {
    return Response.json({ q, hits: [], source: "none" });
  }

  try {
    const ts = await typesenseSearch(q, { limit: 8 });
    if (ts) return Response.json({ q, ...displayHits(ts) });
  } catch {
    /* Typesense unreachable — fall back to the DB */
  }

  try {
    const result = await searchProductsInDb(q, 8);
    return Response.json({ q, ...result });
  } catch {
    return Response.json({ q, hits: [], source: "error" });
  }
});
