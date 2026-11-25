// Typesense ADMIN client (Node-only — depends on axios). Used by the sync to
// (re)create the collection and import documents. Search goes through the
// edge-safe fetch path in ./typesense-search.js.
import Typesense from "typesense";
import { productsCollection } from "./typesense-search.js";

export { productsCollection, typesenseConfigured } from "./typesense-search.js";

export function getAdminClient() {
  if (!process.env.TYPESENSE_HOST || !process.env.TYPESENSE_ADMIN_API_KEY) return null;
  return new Typesense.Client({
    nodes: [
      {
        host: process.env.TYPESENSE_HOST,
        port: Number(process.env.TYPESENSE_PORT || 443),
        protocol: process.env.TYPESENSE_PROTOCOL || "https",
      },
    ],
    apiKey: process.env.TYPESENSE_ADMIN_API_KEY,
    connectionTimeoutSeconds: 5,
  });
}

export const productsCollectionSchema = () => ({
  name: productsCollection(),
  fields: [
    { name: "title", type: "string" },
    { name: "description", type: "string", optional: true },
    { name: "product_type", type: "string", facet: true, optional: true },
    { name: "vendor", type: "string", facet: true, optional: true },
    { name: "tags", type: "string[]", facet: true, optional: true },
    { name: "handle", type: "string", index: false, optional: true },
    { name: "image", type: "string", index: false, optional: true },
    // P7-FACETS: price is a facet for its min/max stats; options and
    // options_available hold `name:value` keys (lib/catalog/facets.js);
    // created_at sorts Newest. A full sync recreates the collection with them.
    { name: "price", type: "float", facet: true, optional: true },
    { name: "options", type: "string[]", facet: true, optional: true },
    { name: "options_available", type: "string[]", facet: true, optional: true },
    { name: "created_at", type: "int64", optional: true },
    { name: "currency", type: "string", index: false, optional: true },
    { name: "available", type: "bool", optional: true },
  ],
});
