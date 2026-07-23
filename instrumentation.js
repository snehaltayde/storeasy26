// Next.js instrumentation (Session 17): onRequestError fires for every
// unhandled server/edge error — RSC renders, route handlers, server actions —
// and feeds the first-party error sink (fingerprinted + alert-throttled).
// Runs in BOTH runtimes; lib/errors.js is edge-safe and never throws.
import { captureError } from "./lib/errors.js";

export async function onRequestError(err, request, context) {
  await captureError({
    source: context?.runtime === "edge" ? "edge" : "server",
    error: err,
    url: request?.path || request?.url || null,
    digest: err?.digest || null,
    extra: {
      method: request?.method,
      routerKind: context?.routerKind,
      routePath: context?.routePath,
      routeType: context?.routeType,
    },
  });
}
