// drill:studio shared parts (Phase 6): the roles store's origin and members,
// signing in, console-error watching and the stage list are drill:apps' own
// (scripts/drills/apps/lib.mjs), as drill:themes uses them. Stage files import
// them from here, so a studio-only helper can be added in this file.
export * from "../apps/lib.mjs";
