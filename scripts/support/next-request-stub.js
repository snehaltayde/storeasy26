// What lib/tenant-request.js imports from react / next/headers / next/navigation,
// none of which its tenantHandler needs outside a live Next request.
export const cache = (fn) => fn;
export const headers = async () => {
  throw new Error("no request scope");
};
export const notFound = () => {
  throw new Error("notFound");
};
