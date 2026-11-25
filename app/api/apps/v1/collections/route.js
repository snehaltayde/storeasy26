import { appApiRoute } from "@/lib/plugins/api-auth";
import { collections } from "@/lib/plugins/api-reads";
// API v1 for custom apps (Phase 4 line 4, docs/APPS_API.md). Bearer token
// only (lib/plugins/api-auth.js), GET only, no CORS headers; every call is
// audited before it is answered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// storefront.read: the collections
export const GET = appApiRoute("storefront.read", (request) => collections(request));
