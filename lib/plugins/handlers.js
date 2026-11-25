// Phase 4 line 3: first-party plugins' event handlers, in code (a manifest is
// frozen data and names only its events). Only lib/plugins/deliveries.js
// reads this. Phase 4 ships no first-party handler; Phase 9 (WhatsApp,
// Shiprocket) adds theirs to BUILT_IN. registerPluginHandler() is a
// test-only seam, like registerPlugin().
//
// A handler: async (ctx) => void, where ctx is
//   { event, install: { id, settings }, secrets(), fetch(url, opts), log(evt, fields) }
// fetch is safeFetch bound to the manifest's egress list. A throw, or a
// fetch answer that isn't ok when the handler returns it, is a failed attempt.
const BUILT_IN = Object.freeze({});
let extra = {};

export const handlerFor = (pluginId, topic) => extra[pluginId]?.[topic] ?? BUILT_IN[pluginId]?.[topic] ?? null;

// → an undo function
export function registerPluginHandler(pluginId, topic, fn) {
  extra = { ...extra, [pluginId]: { ...extra[pluginId], [topic]: fn } };
  return () => {
    const { [topic]: _gone, ...rest } = extra[pluginId] ?? {};
    extra = { ...extra, [pluginId]: rest };
  };
}
