// Typesense ADMIN client (Node-only — depends on axios). Used by the sync to
// (re)create the collection and import documents. Search goes through the
// edge-safe fetch path in ./typesense-search.js.
import Typesense from "typesense";
import { PRODUCTS_COLLECTION } from "./typesense-search.js";

export { PRODUCTS_COLLECTION, typesenseConfigured } from "./typesense-search.js";

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

export const productsCollectionSchema = {
  name: PRODUCTS_COLLECTION,
  fields: [
    { name: "title", type: "string" },
    { name: "description", type: "string", optional: true },
    { name: "product_type", type: "string", facet: true, optional: true },
    { name: "vendor", type: "string", facet: true, optional: true },
    { name: "tags", type: "string[]", facet: true, optional: true },
    { name: "handle", type: "string", index: false, optional: true },
    { name: "image", type: "string", index: false, optional: true },
    { name: "price", type: "float", optional: true },
    { name: "currency", type: "string", index: false, optional: true },
    { name: "available", type: "bool", optional: true },
  ],
};
