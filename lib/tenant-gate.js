// Fail-closed gate semantics for host resolution outcomes (S25 / BE01+SF23).
//
// Plain-Node importable on purpose: lib/tenant-request.js (the Next-facing
// consumer) imports next/headers and can never run under the test suites, so the
// outcome → HTTP mapping lives here where scripts/test-tenant-boundary.js can
// assert it directly.
//
// Outcomes come from resolveHost() in lib/platform/control.js:
//   legacy | resolved  → not gated (legacy = env-default single-tenant mode)
//   unknown            → 404 TENANT_UNKNOWN (never another merchant's store)
//   suspended          → 503 TENANT_SUSPENDED
//   unavailable        → 503 CONTROL_PLANE_UNAVAILABLE (+ Retry-After)

export const GATE = {
  unknown: { status: 404, code: "TENANT_UNKNOWN", message: "Store not found" },
  suspended: { status: 503, code: "TENANT_SUSPENDED", message: "This store is temporarily unavailable" },
  unavailable: {
    status: 503,
    code: "CONTROL_PLANE_UNAVAILABLE",
    message: "Service temporarily unavailable",
    retryAfter: "30",
  },
};

export const isGated = (r) => Boolean(r && GATE[r.outcome]);

// Thrown by page rendering (tfetch) on "unavailable" — lands in the neutral
// error boundary. Pages can't emit a true 503 without middleware; APIs do.
export class ControlPlaneUnavailableError extends Error {
  constructor() {
    super("control plane unavailable");
    this.code = "CONTROL_PLANE_UNAVAILABLE";
  }
}
