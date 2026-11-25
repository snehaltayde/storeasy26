// Phase 4 line 3: the host-name rules every plugin address must pass, before
// DNS. Pure and Edge-safe (manifest.js checks a first-party manifest's
// egress list with it); lib/plugins/egress.js is the real gate at send time.
//
// hostProblem(host) → null when the host is a public-looking DNS name, or a
// plain reason. Refused: IP literals (v4, v6, and the shorthand forms the URL
// parser turns into v4), localhost and *.localhost, *.local, *.internal,
// *.home.arpa, single-label names, and Shopify's hosts (the Shopify boundary:
// a plugin never reaches Shopify through Storeasy).

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "home.arpa"];
const SHOPIFY = ["shopify.com", "myshopify.com"];

const endsWith = (host, suffix) => host === suffix || host.endsWith(`.${suffix}`);

export const normalHost = (host) => String(host ?? "").trim().toLowerCase().replace(/\.$/, "");

export const isShopifyHost = (host) => SHOPIFY.some((s) => endsWith(normalHost(host), s));

export function hostProblem(raw) {
  const host = normalHost(raw);
  if (!host) return "The address needs a host name.";
  if (host.includes(":") || host.startsWith("[") || IPV4.test(host)) return "Use a host name, not an IP address.";
  if (PRIVATE_SUFFIXES.some((s) => endsWith(host, s))) return "That address is on a private network. Use a public HTTPS address.";
  if (isShopifyHost(host)) return "Apps can't send to Shopify addresses through Storeasy.";
  if (host.length > 253) return "That host name is too long.";
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return "That isn't a valid public host name.";
  if (/^\d+$/.test(labels[labels.length - 1])) return "Use a host name, not an IP address.";
  return null;
}
