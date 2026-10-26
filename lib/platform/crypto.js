// Secret encryption for the control plane (Session 20). AES-256-GCM via
// crypto.subtle — edge- and node-safe. Key = SHA-256(PLATFORM_SECRET).
// Ciphertext format: base64(iv[12] || ciphertext+tag). We hold merchants'
// Shopify/Razorpay credentials, so they never sit in plaintext at rest.

const te = new TextEncoder();
const td = new TextDecoder();

async function aesKey() {
  const secret = process.env.PLATFORM_SECRET;
  if (!secret) throw new Error("PLATFORM_SECRET is not set");
  const digest = await crypto.subtle.digest("SHA-256", te.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptSecret(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), te.encode(String(plaintext)));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return b64(out.buffer);
}

export async function decryptSecret(encoded) {
  if (!encoded) return null;
  const raw = unb64(encoded);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(), ct);
  return td.decode(pt);
}

export const encryptJson = async (obj) => encryptSecret(JSON.stringify(obj ?? {}));
export async function decryptJson(encoded) {
  const s = await decryptSecret(encoded);
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
