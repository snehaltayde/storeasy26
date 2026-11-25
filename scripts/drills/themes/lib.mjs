// drill:themes shared parts (Phase 5): the roles store's origin and members,
// signing in, console-error watching and the stage list are drill:apps' own
// (scripts/drills/apps/lib.mjs). Stage files import them from here, so a
// themes-only helper can be added in this file without touching drill:apps.
export * from "../apps/lib.mjs";
