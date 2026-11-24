// The job secret (CRON_SECRET) check shared by /api/jobs/*, /api/health and
// /api/connect/shopify/start. Bearer header or ?secret=. With no secret set the
// routes stay open for local work only: in production they fail closed
// (Phase 0 least-trusted audit, gap B).
export function cronAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${secret}` || request.nextUrl.searchParams.get("secret") === secret;
}
