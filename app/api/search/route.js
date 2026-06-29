import { typesenseSearch } from "@/lib/typesense";
import { searchProductsInDb } from "@/lib/repo";

export const dynamic = "force-dynamic";

// Search endpoint for the header search box. Prefers Typesense (typo tolerance,
// ranking); transparently falls back to a SQL query over the local catalog so
// search works even before Typesense is configured.
export async function GET(request) {
  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (q.length < 2) {
    return Response.json({ q, hits: [], source: "none" });
  }

  try {
    const ts = await typesenseSearch(q, { limit: 8 });
    if (ts) return Response.json({ q, ...ts });
  } catch {
    /* Typesense unreachable — fall back to the DB */
  }

  try {
    const result = await searchProductsInDb(q, 8);
    return Response.json({ q, ...result });
  } catch (e) {
    return Response.json({ q, hits: [], source: "error", error: String(e?.message || e) });
  }
}
