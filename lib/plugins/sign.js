// Phase 4 line 3: webhook signing, Standard Webhooks v1
// (https://www.standardwebhooks.com). WebCrypto only.
//
//   newSigningSecret()  "whsec_" + 32 random bytes, base64
//   signPayload(secret, id, timestamp, body)  "v1,<base64 HMAC-SHA256 of
//                       '<id>.<timestamp>.<body>'>", keyed by the secret's
//                       base64 part decoded
//   signatureHeader(secrets, id, timestamp, body)  each secret's signature,
//                       space-separated (two during a rotation's overlap)
//   webhookHeaders({ id, timestamp, body, secrets })  the three headers
// Receivers check one of the signatures and a 5-minute timestamp window.

export const SECRET_PREFIX = "whsec_";
export const SECRET_RE = /^whsec_[A-Za-z0-9+/]{43}=$/;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function newSigningSecret() {
  return SECRET_PREFIX + b64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function signPayload(secret, id, timestamp, body) {
  const raw = String(secret).startsWith(SECRET_PREFIX) ? String(secret).slice(SECRET_PREFIX.length) : String(secret);
  const key = await crypto.subtle.importKey("raw", unb64(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${b64(mac)}`;
}

export async function signatureHeader(secrets, id, timestamp, body) {
  const sigs = [];
  for (const s of secrets.filter(Boolean)) sigs.push(await signPayload(s, id, timestamp, body));
  return sigs.join(" ");
}

export async function webhookHeaders({ id, timestamp, body, secrets }) {
  return {
    "content-type": "application/json",
    "webhook-id": String(id),
    "webhook-timestamp": String(timestamp),
    "webhook-signature": await signatureHeader(secrets, id, timestamp, body),
  };
}
