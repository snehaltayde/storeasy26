// Phase 4 line 2: a named storefront slot (lib/plugins/slots.js). A server
// component: it runs no plugin JavaScript, here or in the browser. It reads
// the store's placements once a request (lib/plugins/placements.js
// slotBlocks, cached), and draws each block with a Storeasy primitive
// (./blocks) from props that passed validateBlockProps.
//   <PluginSlot name="storefront.pdp.under_atc" ctx={product} />
// An empty slot renders nothing at all. A slot that can't be read renders
// nothing too: a plugin never breaks a page. In a founder's preview, a
// block that is switched off shows with a note that shoppers don't see it.
import { slotBlocks } from "@/lib/plugins/placements";
import { tfetch } from "@/lib/storefront-request";
import { slog } from "@/lib/log";
import { FounderNote, isFounderPreview } from "@/components/sections/parts";
import { BLOCK_COMPONENTS } from "./blocks";

export const OFF_NOTE = "Turned off: shoppers don't see this.";

export default async function PluginSlot({ name, ctx = null, className = "" }) {
  const preview = isFounderPreview(null);
  let blocks;
  try {
    blocks = await tfetch(() => slotBlocks(name, ctx, { preview }));
  } catch (e) {
    if (e?.digest) throw e; // notFound() from the store gate
    slog("plugin_slot_failed", { slot: String(name), error: String(e?.name || "Error") });
    return null;
  }
  if (!blocks.length) return null;
  return (
    <div data-plugin-slot-outlet={name} className={`space-y-3 ${className}`.trim()}>
      {blocks.map((b) => {
        const Block = BLOCK_COMPONENTS[b.primitive];
        if (!Block) return null;
        return (
          <div key={b.key} data-plugin-slot={name} data-plugin={b.pluginId} data-block={b.blockId}>
            {b.live ? null : <FounderNote ctx={{ preview }} text={OFF_NOTE} attrs={{ "data-plugin-off": "" }} className="mb-2" />}
            <Block {...b.props} />
          </div>
        );
      })}
    </div>
  );
}
