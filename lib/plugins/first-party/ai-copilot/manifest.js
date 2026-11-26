// Phase 9 line 5: the AI copilot. It drafts a starter home page, product search
// titles, descriptions and FAQs, and offer ideas, from the catalog and brand
// only (no customer, order or search data). Everything it makes is a draft or
// an offer that is off: only the founder's Publish (or turning an offer on)
// puts it live. Its page is /admin/copilot; it has no storefront blocks and
// reads nothing through the apps API (no scopes).
import { defineManifest } from "../../manifest.js";

export default defineManifest({
  id: "ai-copilot",
  name: "AI copilot",
  version: "1.0.0",
  summary: "Get drafts for a starter home page, product search text and FAQs, and offer ideas. Nothing goes live until you publish it.",
  description:
    "The AI copilot writes first drafts for you: a starter home page, a search title, search description and questions for up to 10 products at a time, and up to three offer ideas. It reads only your catalog and brand (names, descriptions, types, tags, prices and collections), never your customers or orders. Every page it writes is a draft you review in the editor, and every offer it suggests starts switched off. Each store has a daily AI budget, shown on the Copilot page.",
  icon: "Megaphone",
  author: { name: "Storeasy" },
  scopes: [],
  settings: [],
});
