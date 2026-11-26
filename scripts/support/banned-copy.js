// The banned-copy rules live in lib/copy/banned-copy.js (Phase 9 line 5: the
// AI copilot scans its output with them at runtime). This path stays for the
// suites that import it; it re-exports the rules unchanged.
export * from "../../lib/copy/banned-copy.js";
